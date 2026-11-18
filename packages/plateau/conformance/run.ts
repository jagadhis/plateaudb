// Runs the conformance tests in Chromium and WebKit (headless, Playwright, persistent profiles so
// IndexedDB and OPFS are disk-backed) against native IndexedDB and plateau's API, and prints the
// counts and every test whose outcome differs between the two.
//
//   bun conformance/run.ts [--browsers chromium,webkit] [--filter text] [--json out.json]
// Exits non-zero if any test fails on plateau, or the two implementations differ, other than in
// the known differences listed below. Those still run, and every run prints them.

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
const types: Record<string, BrowserType> = { chromium, webkit };

/** Tests that pass natively and fail on plateau, with the reason. Listed, never skipped. */
const KNOWN: Record<string, string> = {
  "keys: -0 equals 0, and a record stored under -0 reports its key as -0":
    "plateau holds keys in a sortable encoding in which -0 and 0 are one key, so a key stored as -0 comes back as 0",
};

const server = await createServer({ configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)), server: { port: 0, host: "127.0.0.1" } });
await server.listen();
const url = server.resolvedUrls!.local[0];

const report: Record<string, Record<string, Result[]>> = {};
let bad = false;
for (const b of browsers) {
  report[b] = {};
  for (const impl of ["native", "plateau"]) {
    const profile = await mkdtemp(join(tmpdir(), "plateau-conformance-"));
    const ctx = await types[b].launchPersistentContext(profile, { headless: true });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto(`${url}?impl=${impl}${filter ? `&filter=${encodeURIComponent(filter)}` : ""}`);
    await page.waitForFunction(() => document.getElementById("status")?.textContent === "done", null, { timeout: 600_000 });
    const results = (await page.evaluate(() => window.results)) as Result[];
    report[b][impl] = results;
    await ctx.close();
    await rm(profile, { recursive: true, force: true });
    const shared = results.filter((r) => r.scope === "shared");
    const own = results.filter((r) => r.scope === "plateau");
    const pass = (rs: Result[]) => rs.filter((r) => r.status === "pass").length;
    console.log(`[${b}] ${impl.padEnd(7)} ${pass(shared)}/${shared.length} pass${own.length ? `; plateau-only tests ${pass(own)}/${own.length} pass` : ""}`);
    for (const r of results) if (r.status !== "pass") console.log(`    FAIL ${r.name}: ${r.message}`);
    if (errors.length && process.env.VERBOSE) console.log(`    console errors:\n      ${errors.join("\n      ")}`);
  }
  const native = new Map(report[b].native.map((r) => [r.name, r.status]));
  const diff = report[b].plateau.filter((r) => r.scope === "shared" && native.get(r.name) !== r.status);
  for (const r of diff) {
    const known = KNOWN[r.name];
    console.log(`[${b}] DIFFERS${known ? " (known)" : ""}: ${r.name}: native ${native.get(r.name)}, plateau ${r.status}${known ? ` (${known})` : ""}`);
  }
  const unexplained = report[b].plateau.filter((r) => r.status !== "pass" && !(KNOWN[r.name] && native.get(r.name) === "pass"));
  if (diff.some((r) => !KNOWN[r.name]) || unexplained.length) bad = true;
}
if (jsonOut) await writeFile(jsonOut, JSON.stringify(report, null, 2));
await server.close();
process.exit(bad ? 1 : 0);
