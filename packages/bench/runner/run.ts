// Drives the bench page in Chromium, WebKit and Firefox (headless) and writes
// results/<YYYY-MM-DD>-<browser>.json. Each engine and size gets a fresh persistent profile on
// disk, so IndexedDB and OPFS are disk-backed (Playwright's default contexts keep storage in memory).
//
//   bun runner/run.ts [--browsers chromium,chromium-idb-sqlite,webkit,firefox] [--sizes 10000,100000,1000000]
//                     [--engines idb,sqlite,plateau,plateau-idb] [--runs 20] [--cold-runs 20]
//                     [--budgets default,24mb,unbounded]
//                     [--warmup 100] [--timeout-min 20] [--out ../../results]

import { mkdtemp, mkdir, open, readdir, rm, writeFile, stat } from "node:fs/promises";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit, type BrowserType } from "playwright";
import { preview } from "vite";
import { stats, type FreshResult } from "../src/harness";
import { SEED } from "../src/workload";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

const browsers = list(arg("browsers", "chromium,webkit,firefox"));
const sizes = list(arg("sizes", "10000,100000,1000000")).map(Number);
const baseEngines = list(arg("engines", "idb,sqlite,plateau,plateau-idb,plateau-idb-generic"));
/** Memory budgets each plateau engine runs under: `default` (the runtime's own), `unbounded`, or
 * `<n>mb`. A variant other than the default is its own engine in the results: `plateau@24mb`. */
const budgets = list(arg("budgets", "default"));
const engines = baseEngines.flatMap((e) => (e.startsWith("plateau") ? budgets.map((b) => (b === "default" ? e : `${e}@${b}`)) : [e]));
const runs = Number(arg("runs", "20"));
const coldRuns = Number(arg("cold-runs", "20"));
const chunk = 10_000;
const warmup = Number(arg("warmup", "100"));
const timeoutMs = Number(arg("timeout-min", "20")) * 60_000;
const benchDir = fileURLToPath(new URL("..", import.meta.url));
const outDir = resolve(benchDir, arg("out", "../../results"));

/** Browser targets. `chromium-idb-sqlite` forces Chromium's SQLite IndexedDB backend, which Chrome
 * 156+ rolls out to new origins through a field trial that Playwright's Chromium does not receive. */
const targets: Record<string, { type: BrowserType; args?: string[]; note: string }> = {
  chromium: { type: chromium, note: "Playwright Chromium (Chrome for Testing), new headless; no field trials" },
  "chromium-idb-sqlite": {
    type: chromium,
    args: ["--enable-features=IdbSqliteBackingStore,IdbSqliteOnDiskRollout"],
    note: "Playwright Chromium with the SQLite IndexedDB backend forced on (Chrome 156+ rollout)",
  },
  webkit: { type: webkit, note: "Playwright WebKit (Safari engine), headless" },
  firefox: { type: firefox, note: "Playwright Firefox, headless" },
};

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

/** IndexedDB files in the profile, to show which backend stored the data. */
async function idbFiles(profile: string): Promise<{ path: string; bytes: number; sqlite: boolean }[]> {
  const files = (await walk(profile)).filter((f) => /indexeddb|\/idb\//i.test(f));
  const out = [];
  for (const f of files.slice(0, 40)) {
    const head = Buffer.alloc(16);
    const fd = await open(f, "r");
    await fd.read(head, 0, 16, 0).finally(() => fd.close());
    out.push({ path: relative(profile, f), bytes: (await stat(f)).size, sqlite: head.toString("latin1").startsWith("SQLite format 3") });
  }
  return out;
}

function idbBackend(browser: string, version: string, files: { path: string; sqlite: boolean }[], args: string[] = []): string {
  const names = files.map((f) => f.path).join(" ");
  const seen = /\.leveldb\//.test(names)
    ? "LevelDB files (*.indexeddb.leveldb)"
    : files.some((f) => f.sqlite)
      ? "SQLite database files (header 'SQLite format 3')"
      : "no IndexedDB files recognized";
  const major = Number(version.split(".")[0]);
  const expected =
    browser.startsWith("chromium")
      ? args.some((a) => a.includes("IdbSqlite"))
        ? "SQLite backend forced on by flag"
        : major >= 156
          ? "Chrome 156+ moves new origins to SQLite by field-trial rollout, which Playwright Chromium does not get"
          : "Chromium before 156 stores IndexedDB in LevelDB"
      : browser === "firefox"
        ? "Firefox stores IndexedDB in SQLite"
        : "WebKit stores IndexedDB in SQLite";
  return `${expected}; profile shows ${seen}`;
}

/** Same row signatures from every engine that finished; a mismatch is a bug, not a result. */
function compare(bySize: Record<string, any>): { match: boolean; compared: string[]; mismatches: string[] } {
  const ok = Object.values(bySize).filter((r: any) => r.status === "ok");
  const mismatches: string[] = [];
  if (ok.length > 1) {
    const [ref, ...rest] = ok;
    const optional = (key: string) => /coldQ1$|^freshQ1$|^freshFirstQ1$/.test(key);
    const check = (key: string, a: string[] | undefined, other: any, okey: string) => {
      const b: string[] | undefined = other.signatures[okey];
      if (optional(key) && (!a?.length || !b?.length)) return;
      if (!a || !b) {
        mismatches.push(`${okey}: missing for ${a ? other.engine : ref.engine}`);
        return;
      }
      if (a.length !== b.length || a.some((s, i) => s !== b[i])) {
        const i = a.findIndex((s, j) => s !== b[j]);
        mismatches.push(`${okey}: ${ref.engine} ${a[i]} vs ${other.engine} ${b[i]} at run ${i}`);
      }
    };
    // Signatures after compaction (`c_*`, only engines that compact) are compared below.
    for (const other of rest) {
      for (const key of Object.keys(ref.signatures)) if (!key.startsWith("c_")) check(key, ref.signatures[key], other, key);
    }
    // After compaction the rows must equal the reference engine's rows after the updates.
    for (const r of ok) {
      for (const key of Object.keys(r.signatures).filter((k) => k.startsWith("c_"))) {
        check(key, ref.signatures[`u_${key.slice(2)}`], r, key);
      }
    }
  }
  return { match: mismatches.length === 0, compared: ok.map((r: any) => r.engine), mismatches };
}

/** The fresh-page scenario: `coldRuns` page loads in the same context, each opening the database
 * the main run left and timing its first Q1 from navigation start. First-ever loads come first,
 * each under a new `/first-<size>-<k>/` prefix so every script and WASM file is fetched at a URL the
 * browser has never seen (empty HTTP and code caches); then repeat loads at the page's own URL,
 * whose files the main run already fetched. */
async function freshPages(page: import("playwright").Page, engine: string, size: number, result: any): Promise<void> {
  const measure = async (prefix: (k: number) => string): Promise<{ runs: FreshResult[]; error?: string }> => {
    const out: FreshResult[] = [];
    for (let k = 1; k <= coldRuns; k++) {
      // Nothing touches the page until it reports: Playwright's polling and script injection would
      // run on the page's main thread while it is being timed.
      const done = page.waitForEvent("console", { predicate: (m) => m.text() === "fresh done", timeout: 60_000 });
      await page.goto(`${url}${prefix(k)}?fresh=${engine}&size=${size}&runs=${runs}&k=${k}`, { waitUntil: "commit" });
      await done;
      const r = (await page.evaluate(() => window.freshResult)) as FreshResult;
      if (r.error) return { runs: out, error: `run ${k}: ${r.error}` };
      out.push(r);
    }
    return { runs: out };
  };
  const summary = (runs_: FreshResult[]) => {
    const parts: Record<string, number[]> = {};
    for (const r of runs_) for (const [name, ms] of Object.entries(r.parts)) (parts[name] ??= []).push(ms);
    return {
      total: stats(runs_.map((r) => r.totalMs)),
      scriptStart: stats(runs_.map((r) => r.scriptStartMs)),
      open: stats(runs_.map((r) => r.openMs)),
      firstQ1: stats(runs_.map((r) => r.firstQ1Ms)),
      parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, stats(v)])),
    };
  };
  const first = await measure((k) => `first-${size}-${k}/`);
  if (first.error) {
    result.freshFirstLoad = { error: first.error };
    return;
  }
  result.freshFirstLoad = summary(first.runs);
  result.signatures.freshFirstQ1 = first.runs.map((r) => r.signature);
  const repeat = await measure(() => "");
  if (repeat.error) {
    result.fresh = { error: repeat.error };
    return;
  }
  result.fresh = summary(repeat.runs);
  result.signatures.freshQ1 = repeat.runs.map((r) => r.signature);
  result.plans.freshQ1 = repeat.runs.map((r) => r.plan ?? "");
  result.detailsAfterFreshQ1 = repeat.runs.at(-1)?.details;
}

const server = await preview({ root: benchDir, logLevel: "warn", preview: { host: "127.0.0.1", port: 4173 } });
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error("vite preview did not report a URL");
await mkdir(outDir, { recursive: true });
let failed = false;

for (const browser of browsers) {
  const target = targets[browser];
  if (!target) throw new Error(`unknown browser ${browser}`);
  const { type, args } = target;
  const file = join(outDir, `${today()}-${browser}.json`);
  let version: string;
  try {
    const probe = await type.launch({ args });
    version = probe.version();
    await probe.close();
  } catch (e) {
    // A browser that cannot start is a result too: record it instead of dropping it.
    const error = e instanceof Error ? e.message.split("\n").filter((l) => /err\]|Failed/.test(l)).slice(0, 4).join(" | ") : String(e);
    await writeFile(file, JSON.stringify({ schemaVersion: 1, date: today(), browser, status: "blocked", note: target.note, launchError: error }, null, 2) + "\n");
    console.error(`[${browser}] could not launch: ${error}`);
    failed = true;
    continue;
  }

  const doc: any = {
    schemaVersion: 1,
    date: today(),
    browser,
    browserVersion: version,
    browserNote: target.note,
    launchArgs: args ?? [],
    headless: true,
    playwright: "1.65.0",
    machine: { cpu: cpus()[0]?.model, cores: cpus().length, memoryGiB: Math.round(totalmem() / 2 ** 30), os: `${platform()} ${release()}` },
    seed: SEED,
    options: { sizes, engines, budgets, runs, coldRuns, chunk, warmup, timeoutMin: timeoutMs / 60_000 },
    timing:
      "Every query is timed on the main thread from call to resolved result: IndexedDB runs on the main thread (no hop); " +
      "SQLite and plateau run in a dedicated worker and include the postMessage round trip and result clone. " +
      "Warm = 20 timed runs after an untimed warm-up (100 calls per query shape, 20 for gets, own parameters, interleaved) and one more untimed run. " +
      "Reopen (`cold`) = close, then open from storage in the same page, then the first Q1; a worker engine keeps its worker (the runtime) and releases only the database and its file handle, as IndexedDB keeps its backend. " +
      "Fresh page (`fresh`) = a new page load in the same browser context (OPFS and IndexedDB data persist), timed from navigation start (performance.timeOrigin) to the first Q1 result. " +
      "Every engine gets the same head bootstrap, an inline script in the HTML <head> that runs at navigation before the app bundle loads, and the app's open() attaches to what it started: " +
      "IndexedDB: issues indexedDB.open(name, 1); open() takes that request (or its result if it already succeeded). " +
      "SQLite: spawns its worker (a separate script), whose first act is to start loading SQLite's WASM (sqlite3InitModule); open() then installs the OPFS pool and opens the database. " +
      "plateau: spawns its worker (a separate script) and starts WebAssembly.compileStreaming(fetch(wasm)) on the main thread, posting the Module to the worker to instantiate; open() then takes the file handle and reads the manifest. " +
      "No bootstrap reads plateau's or SQLite's database file before open(), and nothing caches query results across page loads. Untimed after each run: details, then close. " +
      "Built files carry content hashes and are served `Cache-Control: immutable` (index.html `no-cache`), as a production host would. " +
      "`freshFirstLoad` = the same fresh-page runs, done first, each under a new URL prefix so every script and WASM file is fetched from the server at a URL never seen before (empty HTTP and compiled-code caches); `fresh` = repeat loads at the page's own URL, whose files the main run fetched. " +
      "The OS file cache stays warm in both. " +
      "`updates` runs last, from a plain page load, on the database the clean runs left: open, then two commits that together replace 1% of rows (an edit: new state, assignee, labels, priority, recent updatedAt, edited title; one in ten also moves team) and delete another 1% (updateBatches: the first commit 1,000 of each, the second the rest), each engine its native way " +
      "(IndexedDB: one readwrite transaction per commit, put and delete per row, default durability; SQLite: one transaction per commit, UPDATE and DELETE by primary key with the label join rows removed by their primary key; plateau: put of the batch, delete of the ids, save). " +
      "Each commit is timed on the main thread from the call to its durable end; rows are generated untimed beforehand. Then the warm set and reopens as above (`u_*` signatures), and for the plateau engines compaction followed by the same again (`c_*`, compared with every engine's `u_*`). " +
      "Loads: IndexedDB and plateau-idb-generic (the same code) commit a readwrite transaction per 10,000-row chunk; SQLite as before; plateau and plateau-idb commit every 50,000 rows and then compact, so the measured runs start from one segment while unsaved rows stay bounded. " +
      "plateau engines run under the runtime's default memory budget (64 MiB, 24 MiB where navigator.deviceMemory <= 4) unless the engine name carries a variant (`plateau@24mb`, `plateau@unbounded`). `details*` record wasmMemoryBytes (the worker's WASM memory: its peak so far, since WASM memory never shrinks) and fileBytes after the load, after the update commits and after compaction (each before any query), and again after each warm set.",
    env: null,
    idbBackend: null,
    sizes: {},
    correctness: {},
  };
  const save = () => writeFile(file, JSON.stringify(doc, null, 2) + "\n");

  for (const size of sizes) {
    doc.sizes[size] = {};
    for (const engine of engines) {
      const profile = await mkdtemp(join(tmpdir(), "plateau-bench-"));
      const t = Date.now();
      let result: any;
      let ctx;
      try {
        ctx = await type.launchPersistentContext(profile, { headless: true, args });
        const page = ctx.pages()[0] ?? (await ctx.newPage());
        page.on("pageerror", (e) => console.error(`[${browser}] page error: ${e.message}`));
        await page.goto(url);
        await page.waitForFunction(() => document.getElementById("status")?.textContent === "ready", null, { timeout: 60_000 });
        doc.env ??= await page.evaluate(() => window.bench.env());
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise((r) => {
          timer = setTimeout(() => r({ engine, size, status: "timeout", error: `no result within ${timeoutMs / 60_000} min` }), timeoutMs);
        });
        result = await Promise.race([page.evaluate(([e, o]) => window.bench.run(e as never, o as never), [engine, { size, runs, coldRuns, chunk, warmup }] as const), timeout]);
        clearTimeout(timer);
        if (result.status === "ok" && coldRuns > 0) await freshPages(page, engine, size, result);
        if (result.status === "ok") {
          // The update scenario runs last, on the database the clean runs left, from a plain page.
          await page.goto(url);
          await page.waitForFunction(() => document.getElementById("status")?.textContent === "ready", null, { timeout: 60_000 });
          let utimer: ReturnType<typeof setTimeout> | undefined;
          const utimeout = new Promise((r) => {
            utimer = setTimeout(() => r({ status: "error", failedAt: "timeout", error: `no update result within ${timeoutMs / 60_000} min` }), timeoutMs);
          });
          const u: any = await Promise.race([page.evaluate(([e, o]) => window.bench.updates(e as never, o as never), [engine, { size, runs, coldRuns, chunk, warmup }] as const), utimeout]);
          clearTimeout(utimer);
          result.updates = u;
          Object.assign(result.signatures, u.signatures ?? {});
          if (u.status !== "ok") {
            failed = true;
            console.error(`[${browser}] ${engine} ${size} updates failed at ${u.failedAt}: ${u.error}`);
          }
        }
      } catch (e) {
        result = { engine, size, status: "error", failedAt: "page", error: e instanceof Error ? e.message.split("\n")[0] : String(e) };
      }
      await Promise.race([ctx?.close(), new Promise((r) => setTimeout(r, 30_000))]).catch(() => {});
      if (engine === "idb" && result.status === "ok") {
        result.idbFiles = await idbFiles(profile);
        doc.idbBackend ??= idbBackend(browser, version, result.idbFiles, args);
      }
      await rm(profile, { recursive: true, force: true }).catch(() => {});
      result.wallMs = Date.now() - t;
      doc.sizes[size][engine] = result;
      await save();
      const w = result.warm ?? {};
      const m = (s: any) => (s ? s.median.toFixed(3) : "-");
      console.log(
        `[${browser} ${version}] ${engine.padEnd(19)} ${String(size).padStart(7)} ${result.status.padEnd(7)} ` +
          `load ${result.load ? Math.round(result.load.totalMs) : "-"} ms  gets ${m(w.gets)}  q1 ${m(w.q1)}  q2 ${m(w.q2)}  q3 ${m(w.q3)}  q4 ${m(w.q4)}  ` +
          `reopen ${m(result.cold?.open)} + ${m(result.cold?.firstQ1)} = ${m(result.cold?.total)}  fresh page ${m(result.fresh?.total)} (first load ${m(result.freshFirstLoad?.total)})${result.fresh?.error ? ` (${result.fresh.error})` : ""}  (${Math.round(result.wallMs / 1000)} s)${result.error ? `  ${result.failedAt}: ${result.error}` : ""}`,
      );
      const mib = (d: any) =>
        d && typeof d.wasmMemoryBytes === "number"
          ? `${(d.wasmMemoryBytes / 2 ** 20).toFixed(1)} MiB wasm, ${(d.fileBytes / 2 ** 20).toFixed(1)} MiB file (${(d.usedBytes / 2 ** 20).toFixed(1)} used)`
          : "-";
      if (engine.startsWith("plateau")) {
        const ud = result.updates ?? {};
        console.log(`    memory: after load ${mib(result.detailsAfterLoad)}; after warm ${mib(result.details)}; after updates ${mib(ud.detailsAfterUpdates)}; after compaction ${mib(ud.detailsAfterCompaction)}; after its warm ${mib(ud.detailsCompacted)}`);
      }
      const u = result.updates;
      if (u?.status === "ok") {
        const uw = u.warm ?? {};
        const batches = u.batches.map((b: any) => `${b.replaced}+${b.deleted} ${b.totalMs.toFixed(1)} ms`).join(", ");
        let line = `    updates: ${batches}  gets ${m(uw.gets)}  q1 ${m(uw.q1)}  q2 ${m(uw.q2)}  q3 ${m(uw.q3)}  q4 ${m(uw.q4)}  reopen ${m(u.cold?.total)}`;
        if (u.compact) {
          const cw = u.warmCompacted ?? {};
          line += `\n    compacted in ${u.compact.totalMs.toFixed(1)} ms: gets ${m(cw.gets)}  q1 ${m(cw.q1)}  q2 ${m(cw.q2)}  q3 ${m(cw.q3)}  q4 ${m(cw.q4)}  reopen ${m(u.coldCompacted?.total)}`;
        }
        console.log(line);
      }
    }
    doc.correctness[size] = compare(doc.sizes[size]);
    if (!doc.correctness[size].match) {
      failed = true;
      console.error(`[${browser}] MISMATCH at ${size}: ${doc.correctness[size].mismatches.join("; ")}`);
    }
    await save();
  }
  console.log(`wrote ${relative(process.cwd(), file)}`);
}

await server.close();
process.exit(failed ? 1 : 0);
