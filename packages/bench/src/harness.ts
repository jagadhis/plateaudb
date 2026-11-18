// Runs one engine at one size in this page and returns every timing plus result signatures.
// Every query time is measured on the main thread, from the call to the resolved result, so
// worker engines pay their postMessage round trip and result cloning.

import type { Engine, Timed } from "./types";
import { params, SEED, updateBatches, type Issue, type Params } from "./workload";

export interface Stats {
  n: number;
  median: number;
  p95: number;
  min: number;
  max: number;
  samples: number[];
}

export interface EngineResult {
  engine: string;
  where: string;
  size: number;
  status: "ok" | "error";
  error?: string;
  /** The step that failed, if any. */
  failedAt?: string;
  create?: Timed;
  load?: Timed;
  warm: Partial<Record<"gets" | "q1" | "q2" | "q3" | "q4", Stats>>;
  /** Worker engines only: time inside the worker for the same warm runs (the rest is the hop). */
  inWorker: Partial<Record<"gets" | "q1" | "q2" | "q3" | "q4", Stats>>;
  /** Reopen: close, then open again in the same page, then the first Q1. */
  cold?: { open: Stats; firstQ1: Stats; total: Stats; parts: Record<string, Stats> };
  /** Fresh page: a new page load in the same browser context (data persists), from navigation
   * start to the first Q1 result. Filled in by the runner, which drives the navigations. */
  fresh?: { total: Stats; scriptStart: Stats; open: Stats; firstQ1: Stats; parts: Record<string, Stats>; error?: string };
  /** The fresh-page runs again with empty HTTP and compiled-code caches (never-seen URLs). */
  freshFirstLoad?: { total: Stats; scriptStart: Stats; open: Stats; firstQ1: Stats; parts: Record<string, Stats>; error?: string };
  /** `details` after the last fresh-page Q1. */
  detailsAfterFreshQ1?: Record<string, unknown>;
  /** One hash per run (index 0 is the warm-up), compared across engines and browsers. */
  signatures: Record<string, string[]>;
  resultSizes: Record<string, number[]>;
  plans: Record<string, string[]>;
  storage?: { usage?: number; quota?: number };
  info: Record<string, unknown>;
  details?: Record<string, unknown>;
  /** `details` right after the load, before any query: WASM memory (its peak so far, since WASM
   * memory never shrinks) and file size after the load. */
  detailsAfterLoad?: Record<string, unknown>;
  /** `details` again right after the last cold open and its first Q1: what opening and one query
   * cost in memory. */
  detailsAfterColdQ1?: Record<string, unknown>;
  durationMs: number;
}

export interface FreshResult {
  /** performance.now() at the first Q1 result: ms since navigation start. */
  totalMs: number;
  /** When this module started running: page load and script fetch, the same for every engine. */
  scriptStartMs: number;
  openMs: number;
  firstQ1Ms: number;
  parts: Record<string, number>;
  signature: string;
  plan?: string;
  details?: Record<string, unknown>;
  error?: string;
}

/** One fresh-page measurement: open the database the main run left, run Q1 run `k`'s parameters,
 * then (untimed) read details and close, so the next page load finds the file unlocked. */
export async function freshRun(engine: Engine, size: number, runs: number, k: number): Promise<FreshResult> {
  const scriptStartMs = performance.now();
  try {
    const run = k % (runs + 1);
    const q1 = params(SEED, size, run, run).q1[0];
    const t0 = performance.now();
    const opened = await engine.open();
    const t1 = performance.now();
    const rows = await engine.q1(q1);
    const t2 = performance.now();
    const plan = engine.lastPlan;
    const details = engine.details ? await engine.details() : undefined;
    await engine.close();
    return { totalMs: t2, scriptStartMs, openMs: t1 - t0, firstQ1Ms: t2 - t1, parts: opened.parts, signature: sig(rows), plan, details };
  } catch (e) {
    return { totalMs: NaN, scriptStartMs, openMs: NaN, firstQ1Ms: NaN, parts: {}, signature: "", error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

export function stats(samples: number[]): Stats {
  const s = [...samples].sort((a, b) => a - b);
  const rank = (p: number) => s[Math.max(0, Math.ceil(p * s.length) - 1)];
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return {
    n: s.length,
    median: r(s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2),
    p95: r(rank(0.95)),
    min: r(s[0]),
    max: r(s[s.length - 1]),
    samples: samples.map(r),
  };
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Every field, in a fixed order, so engines that build objects differently still compare equal. */
function canon(rows: (Issue | null)[]): string {
  return JSON.stringify(
    rows.map((r) => (r ? [r.id, r.teamId, r.stateId, r.assigneeId, r.labelIds, r.priority, r.createdAt, r.updatedAt, r.title] : null)),
  );
}

const sig = (rows: (Issue | null)[]) => `${rows.length}:${fnv1a(canon(rows))}`;

export interface RunOptions {
  size: number;
  runs: number;
  coldRuns: number;
  chunk: number;
  /** Untimed calls per query shape before the timed runs, with their own parameters, so each
   * engine's hot code is past the browser's baseline WASM/JS tiers. */
  warmup: number;
}

export async function runEngine(engine: Engine, o: RunOptions): Promise<EngineResult> {
  const started = performance.now();
  const p = params(SEED, o.size, o.runs);
  const w = params(SEED, o.size, o.runs + o.warmup, o.runs + 1);
  const res: EngineResult = {
    engine: engine.name,
    where: engine.where,
    size: o.size,
    status: "ok",
    warm: {},
    inWorker: {},
    signatures: { gets: [], q1: [], q2: [], q3: [], q4: [], coldQ1: [], freshQ1: [], freshFirstQ1: [] },
    resultSizes: { q1: [], q2: [], q3: [], q4: [] },
    plans: { q1: [], q2: [], q3: [], q4: [] },
    info: {},
    durationMs: 0,
  };
  let step = "create";
  try {
    res.create = await engine.create();
    step = "load";
    res.load = await engine.load(SEED, o.size, o.chunk);
    if (engine.details) res.detailsAfterLoad = await engine.details();
    step = "storage";
    const est = await navigator.storage.estimate();
    res.storage = { usage: est.usage, quota: est.quota };

    step = "warm";
    const set = await warmSet(engine, o, p, w, res, "", new Set(), (s) => (step = s));
    res.warm = set.warm;
    res.inWorker = set.inWorker;

    step = "details";
    res.details = engine.details ? await engine.details() : undefined;

    step = "cold";
    if (o.coldRuns > 0) {
      res.cold = await reopens(engine, o, p, res.signatures.coldQ1);
      if (engine.details) res.detailsAfterColdQ1 = await engine.details();
    }
    step = "close";
    res.info = engine.info();
    await engine.close();
  } catch (e) {
    res.status = "error";
    res.failedAt = step;
    res.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    res.info = engine.info();
    try {
      await engine.close();
    } catch {
      // The engine is already broken; the error above is what matters.
    }
  }
  res.durationMs = Math.round(performance.now() - started);
  return res;
}

type Warm = Partial<Record<"gets" | "q1" | "q2" | "q3" | "q4", Stats>>;

const time = async <T>(f: () => Promise<T>): Promise<[number, T]> => {
  const t = performance.now();
  const v = await f();
  return [performance.now() - t, v];
};

/** The warm query set: an untimed warm-up with its own parameters (`w`), then `o.runs` timed runs
 * of gets and Q1-Q4 with run 0 untimed. Signatures, result sizes and plans go into `res` under
 * `prefix` + the query name. A get must return its id, or null for an id in `removed`. */
async function warmSet(
  engine: Engine,
  o: RunOptions,
  p: Params,
  w: Params,
  res: Pick<EngineResult, "signatures" | "resultSizes" | "plans">,
  prefix: string,
  removed: Set<number>,
  onStep: (step: string) => void,
): Promise<{ warm: Warm; inWorker: Warm }> {
  const warm: Warm = {};
  const inWorkerAll: Warm = {};
  for (const key of ["gets", "q1", "q2", "q3", "q4"]) {
    res.signatures[prefix + key] ??= [];
    if (key !== "gets") {
      res.resultSizes[prefix + key] ??= [];
      res.plans[prefix + key] ??= [];
    }
  }
  // Run index 0 is the warm-up: signed and checked, not timed.
  onStep(`${prefix}warmup`);
  for (let k = 0; k < o.warmup; k++) {
    if (k < o.warmup / 5) await engine.getMany(w.gets[k]);
    await engine.q1(w.q1[k]);
    await engine.q2(w.q2[k]);
    await engine.q3(w.q3[k]);
    await engine.q4(w.q4[k]);
  }

  onStep(`${prefix}gets`);
  const gets: number[] = [];
  const getsInWorker: number[] = [];
  for (let k = 0; k <= o.runs; k++) {
    const [ms, rows] = await time(() => engine.getMany(p.gets[k]));
    const bad = rows.findIndex((r, i) => (removed.has(p.gets[k][i]) ? r !== null : r?.id !== p.gets[k][i]));
    if (bad >= 0) throw new Error(`gets run ${k}: id ${p.gets[k][bad]} returned ${JSON.stringify(rows[bad])}`);
    res.signatures[prefix + "gets"].push(sig(rows));
    if (k > 0) gets.push(ms);
    if (k > 0 && engine.lastWorkerMs !== undefined) getsInWorker.push(engine.lastWorkerMs);
  }
  warm.gets = stats(gets);
  if (getsInWorker.length) inWorkerAll.gets = stats(getsInWorker);

  for (const qn of ["q1", "q2", "q3", "q4"] as const) {
    onStep(prefix + qn);
    const samples: number[] = [];
    const inWorker: number[] = [];
    for (let k = 0; k <= o.runs; k++) {
      let ms: number;
      if (qn === "q3") {
        let n: number;
        [ms, n] = await time(() => engine.q3(p.q3[k]));
        res.signatures[prefix + "q3"].push(String(n));
        res.resultSizes[prefix + "q3"].push(n);
      } else {
        let rows: Issue[];
        [ms, rows] = await time(() => (qn === "q1" ? engine.q1(p.q1[k]) : qn === "q2" ? engine.q2(p.q2[k]) : engine.q4(p.q4[k])));
        res.signatures[prefix + qn].push(sig(rows));
        res.resultSizes[prefix + qn].push(rows.length);
      }
      if (engine.lastPlan) res.plans[prefix + qn].push(engine.lastPlan);
      if (k > 0) samples.push(ms);
      if (k > 0 && engine.lastWorkerMs !== undefined) inWorker.push(engine.lastWorkerMs);
    }
    warm[qn] = stats(samples);
    if (inWorker.length) inWorkerAll[qn] = stats(inWorker);
  }
  return { warm, inWorker: inWorkerAll };
}

type Reopen = { open: Stats; firstQ1: Stats; total: Stats; parts: Record<string, Stats> };

/** `o.coldRuns` times: close, open, the first Q1. Pushes each first Q1's signature to `sigs`. */
async function reopens(engine: Engine, o: RunOptions, p: Params, sigs: string[]): Promise<Reopen> {
  const open: number[] = [];
  const first: number[] = [];
  const total: number[] = [];
  const parts: Record<string, number[]> = {};
  for (let k = 1; k <= o.coldRuns; k++) {
    await engine.close();
    const t = performance.now();
    const opened = await engine.open();
    const t1 = performance.now();
    const rows = await engine.q1(p.q1[k % (o.runs + 1)]);
    const t2 = performance.now();
    open.push(t1 - t);
    first.push(t2 - t1);
    total.push(t2 - t);
    for (const [name, ms] of Object.entries(opened.parts)) (parts[name] ??= []).push(ms);
    sigs.push(sig(rows));
  }
  return {
    open: stats(open),
    firstQ1: stats(first),
    total: stats(total),
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, stats(v)])),
  };
}

export interface UpdateResult {
  engine: string;
  size: number;
  status: "ok" | "error";
  error?: string;
  failedAt?: string;
  /** Per commit: rows replaced and deleted, the time from the call to the commit's end on the
   * main thread, and the engine's own split. */
  batches: { replaced: number; deleted: number; totalMs: number; parts: Record<string, number> }[];
  /** All commits together, main thread. */
  updateMs?: number;
  warm: Warm;
  inWorker: Warm;
  /** Reopen after the updates: close, open, first Q1. */
  cold?: Reopen;
  /** plateau only: compaction after the updates, then the warm set and reopen again. */
  compact?: { totalMs: number; parts: Record<string, number> };
  warmCompacted?: Warm;
  inWorkerCompacted?: Warm;
  coldCompacted?: Reopen;
  /** `u_*` after the updates, `c_*` after compaction; compared across engines like the others. */
  signatures: Record<string, string[]>;
  resultSizes: Record<string, number[]>;
  plans: Record<string, string[]>;
  details?: Record<string, unknown>;
  detailsCompacted?: Record<string, unknown>;
  /** `details` right after the update commits and right after compaction, before any query. */
  detailsAfterUpdates?: Record<string, unknown>;
  detailsAfterCompaction?: Record<string, unknown>;
  durationMs: number;
}

/** The update scenario, run on the database the main run left (after its fresh-page loads): open,
 * replace 1% of rows and delete 1% in two commits (`updateBatches`), then the warm query set and
 * reopens; where the engine compacts, compaction and the same again. */
export async function runUpdates(engine: Engine, o: RunOptions): Promise<UpdateResult> {
  const started = performance.now();
  const p = params(SEED, o.size, o.runs);
  const w = params(SEED, o.size, o.runs + o.warmup, o.runs + 1);
  const res: UpdateResult = {
    engine: engine.name,
    size: o.size,
    status: "ok",
    batches: [],
    warm: {},
    inWorker: {},
    signatures: { u_coldQ1: [] },
    resultSizes: {},
    plans: {},
    durationMs: 0,
  };
  let step = "open";
  try {
    await engine.open();
    const batches = updateBatches(SEED, o.size);
    const removed = new Set(batches.flatMap((b) => b.remove));
    for (let b = 0; b < batches.length; b++) {
      step = `prepare ${b}`;
      await engine.prepareUpdate(SEED, o.size, b);
      step = `update ${b}`;
      const [ms, inner] = await time(() => engine.applyUpdate());
      res.batches.push({ replaced: batches[b].replace.length, deleted: batches[b].remove.length, totalMs: ms, parts: inner.parts });
    }
    res.updateMs = res.batches.reduce((a, b) => a + b.totalMs, 0);
    if (engine.details) res.detailsAfterUpdates = await engine.details();
    const after = await warmSet(engine, o, p, w, res, "u_", removed, (s) => (step = s));
    res.warm = after.warm;
    res.inWorker = after.inWorker;
    if (engine.details) res.details = await engine.details();
    step = "u_cold";
    if (o.coldRuns > 0) res.cold = await reopens(engine, o, p, res.signatures.u_coldQ1);
    if (engine.compact) {
      step = "compact";
      const [ms, inner] = await time(() => engine.compact!());
      res.compact = { totalMs: ms, parts: inner.parts };
      if (engine.details) res.detailsAfterCompaction = await engine.details();
      const c = await warmSet(engine, o, p, w, res, "c_", removed, (s) => (step = s));
      res.warmCompacted = c.warm;
      res.inWorkerCompacted = c.inWorker;
      if (engine.details) res.detailsCompacted = await engine.details();
      step = "c_cold";
      res.signatures.c_coldQ1 = [];
      if (o.coldRuns > 0) res.coldCompacted = await reopens(engine, o, p, res.signatures.c_coldQ1);
    }
    step = "close";
    await engine.close();
  } catch (e) {
    res.status = "error";
    res.failedAt = step;
    res.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    try {
      await engine.close();
    } catch {
      // The engine is already broken; the error above is what matters.
    }
  }
  res.durationMs = Math.round(performance.now() - started);
  return res;
}
