// Applies the M0b verdict rule (written before the M0b run; see the site's milestones) to
// the newest results/<date>-<browser>.json of Chromium and WebKit. Prints every measure the
// rule uses, then the verdict.
//
//   bun runner/verdict.ts [--dir ../../results]

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = resolve(fileURLToPath(new URL("..", import.meta.url)), process.argv.includes("--dir") ? process.argv[process.argv.indexOf("--dir") + 1] : "../../results");
const QS = ["q1", "q2", "q3", "q4"] as const;
const FIXED = ["q1", "q4"] as const;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const x = (n: number) => `${n.toFixed(n >= 10 ? 1 : 2)}x`;

const fmtMs = (s: { median: number } | undefined) => (s ? `${s.median.toFixed(s.median >= 10 ? 1 : 3)} ms` : "-");

/** Open plus first Q1 for every engine and size the file holds: reopen in the same page, and a
 * fresh page load (navigation start to the first Q1 result). */
function coldTotals(doc: any): void {
  for (const [size, engines] of Object.entries<any>(doc.sizes ?? {})) {
    for (const [engine, r] of Object.entries<any>(engines)) {
      if (r.status !== "ok") {
        console.log(`  ${size.padStart(7)} ${engine.padEnd(7)} ${r.status}`);
        continue;
      }
      const reopen = r.cold ? `${fmtMs(r.cold.open)} + ${fmtMs(r.cold.firstQ1)} = ${fmtMs(r.cold.total)}` : "-";
      const fresh = r.fresh?.total ? fmtMs(r.fresh.total) : r.fresh?.error ? `error: ${r.fresh.error}` : "-";
      const first = r.freshFirstLoad?.total ? fmtMs(r.freshFirstLoad.total) : "-";
      console.log(`  ${size.padStart(7)} ${engine.padEnd(7)} reopen (open + first Q1) ${reopen}   fresh page total ${fresh} (first-ever load ${first})`);
    }
  }
}

const files = (await readdir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}-(chromium|webkit)\.json$/.test(f)).sort();
const newest = new Map<string, any>();
for (const f of files) newest.set(f.slice(11, -5), JSON.parse(await readFile(join(dir, f), "utf8")));

const verdicts: Record<string, { c1: boolean; c2: boolean; c3: boolean; c4: boolean; c4gap: number }> = {};
for (const [browser, doc] of newest) {
  const at = (size: number, engine: string) => doc.sizes[size]?.[engine];
  const t = (size: number, engine: string, q: string): number => at(size, engine).warm[q].median;
  console.log(`\n${browser} ${doc.browserVersion}  (${doc.date})`);
  coldTotals(doc);
  if (![10000, 100000, 1000000].every((n) => ["idb", "sqlite", "plateau"].every((e) => at(n, e)?.status === "ok"))) {
    console.log("  (the verdict rule needs idb, sqlite and plateau at 10k, 100k and 1M; skipped)");
    continue;
  }

  const idbRatios = QS.map((q) => t(100000, "idb", q) / t(100000, "plateau", q));
  const sqlRatios = QS.map((q) => t(100000, "sqlite", q) / t(100000, "plateau", q));
  console.log(`  100k  IndexedDB/plateau  ${QS.map((q, i) => `${q} ${x(idbRatios[i])}`).join("  ")}  median ${x(median(idbRatios))}`);
  console.log(`  100k  SQLite/plateau     ${QS.map((q, i) => `${q} ${x(sqlRatios[i])}`).join("  ")}  median ${x(median(sqlRatios))}`);

  let growthOk = true;
  const growth: string[] = [];
  for (const q of QS) {
    const timeRatio = t(1000000, "plateau", q) / t(10000, "plateau", q);
    const sizeOf = (size: number) => mean(at(size, "plateau").resultSizes[q] as number[]);
    if ((FIXED as readonly string[]).includes(q)) {
      const ok = timeRatio < 3;
      growthOk &&= ok;
      growth.push(`${q} time ${x(timeRatio)} (result ${sizeOf(10000).toFixed(0)} -> ${sizeOf(1000000).toFixed(0)}) ${ok ? "pass" : "FAIL"} (<3x)`);
    } else {
      const resultRatio = sizeOf(1000000) / Math.max(sizeOf(10000), 1e-9);
      const ok = timeRatio <= resultRatio;
      growthOk &&= ok;
      growth.push(`${q} time ${x(timeRatio)} vs result ${x(resultRatio)} ${ok ? "pass" : "FAIL"}`);
    }
  }
  console.log(`  growth 10k -> 1M (plateau)  ${growth.join("; ")}`);
  for (const q of QS) console.log(`    ${q} IndexedDB ${x(t(1000000, "idb", q) / t(10000, "idb", q))}  SQLite ${x(t(1000000, "sqlite", q) / t(10000, "sqlite", q))}`);

  const openP = at(1000000, "plateau").cold.open.median;
  const openS = at(1000000, "sqlite").cold.open.median;
  console.log(`  cold open at 1M  plateau ${openP.toFixed(1)} ms  SQLite ${openS.toFixed(1)} ms  IndexedDB ${at(1000000, "idb").cold.open.median.toFixed(1)} ms`);

  verdicts[browser] = {
    c1: median(idbRatios) >= 10,
    c2: median(sqlRatios) > 2,
    c3: growthOk,
    c4: openP <= openS,
    c4gap: openP / openS,
  };
  const v = verdicts[browser];
  console.log(`  conditions  1 (>=10x IndexedDB) ${v.c1}  2 (>2x SQLite) ${v.c2}  3 (growth) ${v.c3}  4 (cold open <= SQLite) ${v.c4} (${x(v.c4gap)})`);
}

const all = Object.values(verdicts);
if (!all.length) {
  console.log("\nNo verdict: no browser has the full matrix.");
  process.exit(0);
}
const passes123 = (v: (typeof all)[number]) => v.c1 && v.c2 && v.c3;
const sqliteClose = all.every((v) => !v.c2);
const idbFailsBoth = all.every((v) => !v.c1);
let verdict: string;
if (sqliteClose || idbFailsBoth) verdict = "KILL";
else if (all.every((v) => passes123(v) && v.c4)) verdict = "KEEP";
else if (all.filter(passes123).length === 1 || (all.every(passes123) && all.every((v) => v.c4 || v.c4gap < 2))) verdict = "ITERATE";
else verdict = "ITERATE? (no clause matches exactly; read the numbers)";
console.log(`\nVerdict by the written rule: ${verdict}`);
