// Reads the newest benchmark results in results/ and writes site/data.js, the numbers the site
// shows. Run from the repo root: `bun site/extract.ts`. Every number on the site comes from here.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RESULTS = join(import.meta.dir, "..", "results");
const ENGINES = ["idb", "sqlite", "plateau", "plateau-idb", "plateau-idb-generic"];
const BUDGET_ENGINES = ["plateau", "plateau-idb", "plateau-idb-generic"];
const BUDGETS = ["", "@24mb", "@unbounded"];
const QUERIES = ["q1", "q2", "q3", "q4", "gets"];

type Stat = { median: number; p95: number };
const stat = (s: any): Stat | null => (s && typeof s.median === "number" ? { median: s.median, p95: s.p95 } : null);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

function newest(browser: string): string | null {
  const files = readdirSync(RESULTS).filter((f) => f.endsWith(`-${browser}.json`)).sort();
  return files.length ? join(RESULTS, files[files.length - 1]) : null;
}

function engineData(e: any) {
  if (!e || e.status !== "ok") return null;
  const warm: Record<string, Stat | null> = {};
  const afterUpdates: Record<string, Stat | null> = {};
  for (const q of QUERIES) {
    warm[q] = stat(e.warm?.[q]);
    afterUpdates[q] = stat(e.updates?.warm?.[q]);
  }
  const resultSizes: Record<string, number | null> = {};
  for (const q of ["q1", "q2", "q3", "q4"]) resultSizes[q] = e.resultSizes?.[q] ? median(e.resultSizes[q]) : null;
  // plateau records its plan per run in `plans`; the SQLite engine records EXPLAIN QUERY PLAN in `details`.
  const plans: Record<string, string | null> = {};
  for (const q of ["q1", "q2", "q3", "q4"]) plans[q] = e.plans?.[q]?.[0] ?? (typeof e.details?.[q] === "string" ? e.details[q] : null);
  // File size: plateau reports its own; IndexedDB's comes from the profile's files. storage.usage is
  // left out because WebKit shares OPFS across runs and Chromium counts other origin data in it.
  const fileBytes = typeof e.details?.fileBytes === "number" ? e.details.fileBytes : Array.isArray(e.idbFiles) ? e.idbFiles.reduce((s: number, f: any) => s + (f.bytes ?? 0), 0) : null;
  return {
    where: e.where,
    warm,
    afterUpdates,
    resultSizes,
    plans,
    reopen: stat(e.cold?.total),
    fresh: stat(e.fresh?.total),
    freshFirstLoad: stat(e.freshFirstLoad?.total),
    loadMs: e.load?.totalMs ?? null,
    updateCommits: (e.updates?.batches ?? []).map((b: any) => ({ replaced: b.replaced, deleted: b.deleted, ms: b.totalMs })),
    wasmMemoryBytes: typeof e.details?.wasmMemoryBytes === "number" ? e.details.wasmMemoryBytes : null,
    fileBytes,
    info: e.info ?? null,
  };
}

const out: any = { generated: new Date().toISOString().slice(0, 10), browsers: {} };
for (const browser of ["chromium", "webkit", "firefox"]) {
  const path = newest(browser);
  if (!path) continue;
  const d = JSON.parse(readFileSync(path, "utf8"));
  if (d.status === "blocked") {
    out.browsers[browser] = { status: "blocked", note: d.note, launchError: String(d.launchError ?? "").split("|")[0].trim() };
    continue;
  }
  const sizes: any = {};
  for (const [size, engines] of Object.entries<any>(d.sizes)) {
    sizes[size] = { engines: {}, budgets: {}, correct: d.correctness?.[size]?.match ?? null, compared: d.correctness?.[size]?.compared?.length ?? 0 };
    for (const name of ENGINES) sizes[size].engines[name] = engineData(engines[name]);
    for (const base of BUDGET_ENGINES) {
      for (const b of BUDGETS) {
        const e = engines[base + b];
        if (!e || e.status !== "ok") continue;
        sizes[size].budgets[base + b] = {
          wasmMemoryBytes: e.details?.wasmMemoryBytes ?? null,
          fileBytes: e.details?.fileBytes ?? null,
          gets: stat(e.warm?.gets),
          q2: stat(e.warm?.q2),
        };
      }
    }
  }
  out.browsers[browser] = {
    status: "ok",
    date: d.date,
    version: d.browserVersion,
    note: d.browserNote,
    machine: d.machine,
    runs: d.options?.runs,
    coldRuns: d.options?.coldRuns,
    playwright: d.playwright,
    idbBackend: d.idbBackend ?? null,
    sizes,
  };
}

// The live-sync example's measurements (examples/live-sync/results/live-sync-<browser>.json).
const liveSync: any = {};
for (const browser of ["chromium", "webkit"]) {
  const path = join(import.meta.dir, "..", "examples", "live-sync", "results", `live-sync-${browser}.json`);
  let d: any;
  try {
    d = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    continue;
  }
  const lat = (k: string) => ({ p50: d.latency[k].follower.p50, p95: d.latency[k].follower.p95 });
  const cold = d.cold["100000 orders"];
  const rounds = Object.values<any>(d.failover).flatMap((v) => v.failovers.map((f: any) => f.newLeaderStreamOpenMs));
  liveSync[browser] = {
    edits: d.edits,
    edit0: lat("plateau@poll0"),
    rest0: lat("rest@poll0"),
    edit1000: lat("plateau@poll1000"),
    cold100k: { rest: cold.restFirstRender.p50, first: cold.plateauFirstVisitFirstRender.p50, loaded: cold.plateauFirstVisitLoaded.p50, returnFirst: cold.plateauReturnFirstRender.p50, returnCaught: cold.plateauReturnCaughtUp.p50 },
    failoverMs: Math.max(...rounds),
  };
}
if (Object.keys(liveSync).length) out.liveSync = liveSync;

writeFileSync(join(import.meta.dir, "data.js"), `// Written by site/extract.ts from results/*.json. Do not edit by hand.\nwindow.PLATEAU = ${JSON.stringify(out)};\n`);
console.log(`site/data.js written from ${Object.keys(out.browsers).join(", ")}`);
