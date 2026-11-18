// Runs the conformance tests in Chromium and WebKit (headless, Playwright, persistent profiles so
// IndexedDB and OPFS are disk-backed) against native IndexedDB, plateau's API on its engine
// (`plateau`) and plateau's API forced onto the browser's IndexedDB (`fallback`), and prints the
// counts and every test whose outcome differs from native. Then the fallback cases: pages where
// plateau must fall back by itself (OPFS, Worker or WebAssembly removed by an init script, and a
// WebKit ephemeral context), each running the suite after a first open made before the choice.
//
//   bun conformance/run.ts [--browsers chromium,webkit] [--filter text] [--json out.json]
//                          [--impls native,plateau,fallback] [--no-cases]
// Exits non-zero if any test fails on plateau's API, a backend is not the one expected, or an
// implementation differs from native other than in the known differences listed below. Those
// still run, and every run prints them.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, type BrowserType } from "playwright";
import { createServer } from "vite";
import type { Result } from "./harness";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const browsers = arg("browsers", "chromium,webkit").split(",").filter(Boolean);
const filter = arg("filter", "");
const jsonOut = arg("json", "");
const cases = !argv.includes("--no-cases");
const impls = arg("impls", "native,plateau,fallback").split(",").filter(Boolean) as Impl[];
const types: Record<string, BrowserType> = { chromium, webkit };

/** Tests that pass natively and fail on plateau's engine, with the reason. Listed, never skipped.
 * The fallback has none: it is the browser's IndexedDB. */
const KNOWN: Record<string, string> = {
  "keys: -0 equals 0, and a record stored under -0 reports its key as -0":
    "plateau holds keys in a sortable encoding in which -0 and 0 are one key, so a key stored as -0 comes back as 0",
};

const server = await createServer({ configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)), server: { port: 0, host: "127.0.0.1" } });
await server.listen();
const url = server.resolvedUrls!.local[0];

type Impl = "native" | "plateau" | "fallback" | "auto";

/** The ways a page must fall back by itself: an init script that removes what the engine needs, or
 * a WebKit ephemeral (non-persistent) context, where OPFS throws UnknownError. */
const FALLBACK_CASES: { name: string; browsers: string[]; init?: string; ephemeral?: boolean }[] = [
  { name: "no OPFS", browsers: ["chromium", "webkit"], init: "delete StorageManager.prototype.getDirectory" },
  { name: "no Worker", browsers: ["chromium", "webkit"], init: "delete window.Worker" },
  { name: "no WebAssembly", browsers: ["chromium", "webkit"], init: "delete window.WebAssembly" },
  // Found only once the runtime starts: the engine's WASM does not compile, or the worker's script
  // does not load (as where module workers are missing).
  { name: "WASM that does not compile", browsers: ["chromium", "webkit"], init: "WebAssembly.compileStreaming = WebAssembly.compile = () => Promise.reject(new Error('blocked'))" },
  { name: "a worker that does not load", browsers: ["chromium", "webkit"], init: "const W = window.Worker; window.Worker = function (u, o) { return new W('/no-such-worker.js', o); }" },
  { name: "WebKit ephemeral context", browsers: ["webkit"], ephemeral: true },
];

/** Runs the suite in one page; returns its results, the backend it ran on and, on `auto`, how its
 * first open went. */
async function runPage(b: string, impl: Impl, o: { init?: string; ephemeral?: boolean } = {}) {
  const profile = o.ephemeral ? null : await mkdtemp(join(tmpdir(), "plateau-conformance-"));
  const browser = o.ephemeral ? await types[b].launch({ headless: true }) : null;
  const ctx = browser ? await browser.newContext() : await types[b].launchPersistentContext(profile!, { headless: true });
  if (o.init) await ctx.addInitScript(o.init);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(`${url}?impl=${impl}${filter ? `&filter=${encodeURIComponent(filter)}` : ""}`);
  await page.waitForFunction(() => document.getElementById("status")?.textContent === "done", null, { timeout: 600_000 });
  const out = (await page.evaluate(() => ({ results: window.results, backend: window.backend, firstOpen: window.firstOpen }))) as { results: Result[]; backend: string; firstOpen?: string };
  await ctx.close();
  await browser?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
  if (errors.length && process.env.VERBOSE) console.log(`    console errors:\n      ${errors.join("\n      ")}`);
  return out;
}

const pass = (rs: Result[]) => rs.filter((r) => r.status === "pass").length;

function summary(label: string, results: Result[]): void {
  const shared = results.filter((r) => r.scope === "shared");
  const own = results.filter((r) => r.scope === "plateau" || r.scope === "engine");
  const fb = results.filter((r) => r.scope === "fallback");
  console.log(`${label} ${pass(shared)}/${shared.length} pass${own.length ? `; plateau-only tests ${pass(own)}/${own.length} pass` : ""}${fb.length ? `; fallback-only tests ${pass(fb)}/${fb.length} pass` : ""}`);
  for (const r of results) if (r.status !== "pass") console.log(`    FAIL ${r.name}: ${r.message}`);
}

/** Compares a run of plateau's API with native; true when it is bad. */
function compare(b: string, label: string, native: Map<string, string>, results: Result[], known: Record<string, string>): boolean {
  const diff = results.filter((r) => r.scope === "shared" && native.get(r.name) !== r.status);
  for (const r of diff) {
    const k = known[r.name];
    console.log(`[${b}] ${label} DIFFERS${k ? " (known)" : ""}: ${r.name}: native ${native.get(r.name)}, ${label} ${r.status}${k ? ` (${k})` : ""}`);
  }
  const unexplained = results.filter((r) => r.status !== "pass" && !(known[r.name] && native.get(r.name) === "pass"));
  return diff.some((r) => !known[r.name]) || unexplained.length > 0;
}

const report: Record<string, Record<string, Result[]>> = {};
let bad = false;
const expected: Record<string, string> = { native: "native", plateau: "opfs", fallback: "indexeddb", auto: "indexeddb" };
for (const b of browsers) {
  report[b] = {};
  for (const impl of impls) {
    const { results, backend } = await runPage(b, impl);
    report[b][impl] = results;
    summary(`[${b}] ${impl.padEnd(8)}`, results);
    if (backend !== expected[impl]) {
      console.log(`[${b}] ${impl}: ran on backend ${backend}, expected ${expected[impl]}`);
      bad = true;
    }
  }
  // Without a native run, each result is checked on its own.
  const native = new Map((report[b].native ?? []).map((r) => [r.name, r.status]));
  if (!report[b].native) for (const rs of Object.values(report[b])) for (const r of rs) native.set(r.name, "pass");
  if (report[b].plateau && compare(b, "plateau", native, report[b].plateau, KNOWN)) bad = true;
  if (report[b].fallback && compare(b, "fallback", native, report[b].fallback, {})) bad = true;
  if (!cases) continue;
  for (const c of FALLBACK_CASES) {
    if (!c.browsers.includes(b)) continue;
    const { results, backend, firstOpen } = await runPage(b, "auto", c);
    report[b][`auto: ${c.name}`] = results;
    summary(`[${b}] ${c.name}: backend ${backend}; first open: ${firstOpen};`, results);
    const firstOk = firstOpen === "upgradeneeded 0->2; success v2; index [1,2]";
    if (backend !== "indexeddb" || !firstOk) {
      console.log(`[${b}] ${c.name}: expected backend indexeddb and a working first open`);
      bad = true;
    }
    if (compare(b, c.name, native, results, {})) bad = true;
  }
}
if (jsonOut) await writeFile(jsonOut, JSON.stringify(report, null, 2));
await server.close();
process.exit(bad ? 1 : 0);
