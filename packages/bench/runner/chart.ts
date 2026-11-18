// Writes results/index.html from the newest results/<date>-<browser>.json per browser:
// small multiples of median latency against row count (log-log), one row per measure,
// one column per browser, plus the full table. Static HTML, no dependencies.
//
//   bun runner/chart.ts [--results ../../results]

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const i = argv.indexOf("--results");
const dir = resolve(fileURLToPath(new URL("..", import.meta.url)), i >= 0 ? argv[i + 1] : "../../results");

type Stats = { median: number; p95: number; n: number };
type Run = any;

const files = (await readdir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}-.+\.json$/.test(f)).sort();
const latest = new Map<string, Run>();
for (const f of files) {
  const doc = JSON.parse(await readFile(join(dir, f), "utf8"));
  doc.file = f;
  latest.set(doc.browser, doc);
}
const docs = [...latest.values()];
const ok = docs.filter((d) => d.status !== "blocked" && d.browser !== "chromium-idb-sqlite");
const blocked = docs.filter((d) => d.status === "blocked");
const idbSqlite = latest.get("chromium-idb-sqlite");

const ENGINES = [
  { key: "idb", label: "IndexedDB", slot: 1 },
  { key: "sqlite", label: "SQLite-WASM (sahpool)", slot: 2 },
  { key: "plateau", label: "plateau", slot: 3 },
  { key: "plateau-idb", label: "plateau, IndexedDB-compatible API, typed store", slot: 4 },
  { key: "plateau-idb-generic", label: "plateau, IndexedDB-compatible API, generic store", slot: 5 },
];
const MEASURES: { key: string; title: string; pick: (r: Run) => Stats | undefined }[] = [
  { key: "q1", title: "Q1 team = X AND state IN (2) ORDER BY updatedAt DESC LIMIT 50", pick: (r) => r.warm?.q1 },
  { key: "q2", title: "Q2 assignee = Y AND label = L AND priority ≤ 2", pick: (r) => r.warm?.q2 },
  { key: "q3", title: "Q3 team = X AND updatedAt > T, count", pick: (r) => r.warm?.q3 },
  { key: "q4", title: "Q4 team = X AND state IN (2) AND priority ≤ 2 ORDER BY updatedAt DESC LIMIT 50", pick: (r) => r.warm?.q4 },
  { key: "gets", title: "1,000 point gets (one batch)", pick: (r) => r.warm?.gets },
  { key: "coldOpen", title: "Reopen: open after close in the same page (no query)", pick: (r) => r.cold?.open },
  { key: "cold", title: "Reopen: open after close in the same page + first Q1", pick: (r) => r.cold?.total },
  { key: "fresh", title: "Fresh page, repeat load: new page load, navigation start to first Q1 result", pick: (r) => r.fresh?.total },
  { key: "freshFirst", title: "Fresh page, first-ever load (empty HTTP and code caches): navigation start to first Q1 result", pick: (r) => r.freshFirstLoad?.total },
  { key: "load", title: "Bulk load (insert + indexes + durable write)", pick: (r) => (r.load ? { median: r.load.totalMs, p95: r.load.totalMs, n: 1 } : undefined) },
];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : ms >= 10 ? `${ms.toFixed(0)} ms` : ms >= 1 ? `${ms.toFixed(1)} ms` : `${ms.toFixed(3)} ms`);
const sizeLabel = (n: number) => (n >= 1e6 ? `${n / 1e6}M` : `${n / 1e3}k`);

const W = 300;
const H = 190;
const M = { l: 46, r: 92, t: 10, b: 26 };

interface Series {
  label: string;
  slot: number;
  dashed?: boolean;
  points: { size: number; s?: Stats; status: string }[];
}

function panel(series: Series[], sizes: number[], browser: string, measure: string): string {
  const vals = series.flatMap((s) => s.points.filter((p) => p.s).map((p) => p.s!.median));
  if (!vals.length) return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="no data"><text x="${W / 2}" y="${H / 2}" class="muted" text-anchor="middle">no data</text></svg>`;
  const lo = 10 ** Math.floor(Math.log10(Math.min(...vals)));
  const hi = 10 ** Math.ceil(Math.log10(Math.max(...vals)));
  const pw = W - M.l - M.r;
  const ph = H - M.t - M.b;
  const x = (n: number) => M.l + (sizes.length === 1 ? pw / 2 : (sizes.indexOf(n) / (sizes.length - 1)) * pw);
  const y = (v: number) => M.t + ph - ((Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo) || 1)) * ph;
  let g = "";
  for (let d = lo; d <= hi * 1.0001; d *= 10) {
    g += `<line class="grid" x1="${M.l}" x2="${M.l + pw}" y1="${y(d)}" y2="${y(d)}"/><text class="muted tick" x="${M.l - 6}" y="${y(d) + 3.5}" text-anchor="end">${fmt(d).replace(".000", "")}</text>`;
  }
  g += `<line class="axis" x1="${M.l}" x2="${M.l + pw}" y1="${M.t + ph}" y2="${M.t + ph}"/>`;
  for (const n of sizes) g += `<text class="muted tick" x="${x(n)}" y="${H - 8}" text-anchor="middle">${sizeLabel(n)} rows</text>`;
  const labels: { y: number; text: string; slot: number }[] = [];
  for (const s of series) {
    const pts = s.points.filter((p) => p.s);
    if (pts.length > 1) {
      g += `<polyline class="line" style="stroke:var(--series-${s.slot})"${s.dashed ? ' stroke-dasharray="5 4"' : ""} points="${pts.map((p) => `${x(p.size)},${y(p.s!.median)}`).join(" ")}"/>`;
    }
    for (const p of s.points) {
      if (p.s) {
        const tip = `${s.label} · ${browser} · ${p.size.toLocaleString("en")} rows\n${measure}\nmedian ${fmt(p.s.median)} · p95 ${fmt(p.s.p95)} · n ${p.s.n}`;
        g += `<g class="pt" data-tip="${esc(tip)}"><circle class="hit" cx="${x(p.size)}" cy="${y(p.s.median)}" r="11"/><circle class="dot" cx="${x(p.size)}" cy="${y(p.s.median)}" r="4" style="fill:var(--series-${s.slot})"/></g>`;
      } else if (p.status !== "missing") {
        g += `<text class="muted flag" x="${x(p.size)}" y="${M.t + 9}" text-anchor="middle">${esc(p.status)}</text>`;
      }
    }
    const last = [...pts].reverse()[0];
    if (last) labels.push({ y: y(last.s!.median), text: s.label, slot: s.slot });
  }
  labels.sort((a, b) => a.y - b.y);
  for (let k = 1; k < labels.length; k++) labels[k].y = Math.max(labels[k].y, labels[k - 1].y + 12);
  for (const l of labels) g += `<text class="dlabel" x="${M.l + pw + 8}" y="${l.y + 3.5}">${esc(l.text.replace(" (sahpool)", "").replace("IndexedDB, SQLite backend", "IDB (SQLite)"))}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${measure}, ${browser}`)}">${g}</svg>`;
}

const sizes = [...new Set(ok.flatMap((d) => Object.keys(d.sizes).map(Number)))].sort((a, b) => a - b);

function seriesFor(doc: Run, m: (typeof MEASURES)[number]): Series[] {
  const out: Series[] = ENGINES.map((e) => ({
    label: e.label,
    slot: e.slot,
    points: sizes.map((n) => {
      const r = doc.sizes?.[n]?.[e.key];
      if (!r) return { size: n, status: "missing" };
      return { size: n, s: r.status === "ok" ? m.pick(r) : undefined, status: r.status };
    }),
  }));
  if (doc.browser === "chromium" && idbSqlite && idbSqlite.status !== "blocked") {
    out.push({
      label: "IndexedDB, SQLite backend",
      slot: 1,
      dashed: true,
      points: sizes.map((n) => {
        const r = idbSqlite.sizes?.[n]?.idb;
        if (!r) return { size: n, status: "missing" };
        return { size: n, s: r.status === "ok" ? m.pick(r) : undefined, status: r.status };
      }),
    });
  }
  return out;
}

const cols = ok.map((d) => `${d.browser} ${d.browserVersion}`);
let grid = `<div class="grid-head" style="grid-template-columns: 11rem repeat(${ok.length}, minmax(0, 1fr))"><div></div>${cols.map((c) => `<div class="colhead">${esc(c)}</div>`).join("")}</div>`;
for (const m of MEASURES) {
  grid += `<div class="row" style="grid-template-columns: 11rem repeat(${ok.length}, minmax(0, 1fr))"><div class="rowhead">${esc(m.title)}</div>`;
  for (const d of ok) grid += `<div class="cell">${panel(seriesFor(d, m), sizes, `${d.browser} ${d.browserVersion}`, m.title)}</div>`;
  grid += `</div>`;
}

let table = "";
for (const d of [...ok, ...(idbSqlite && idbSqlite.status !== "blocked" ? [idbSqlite] : [])]) {
  table += `<h3>${esc(d.browser)} ${esc(d.browserVersion)} <span class="muted">(${esc(d.file)}; IndexedDB: ${esc(d.idbBackend ?? "n/a")})</span></h3><table><thead><tr><th>engine</th><th>rows</th><th>status</th>${MEASURES.map((m) => `<th>${esc(m.key)} median</th><th>${esc(m.key)} p95</th>`).join("")}</tr></thead><tbody>`;
  for (const n of Object.keys(d.sizes).map(Number).sort((a, b) => a - b)) {
    for (const [engine, r] of Object.entries<any>(d.sizes[n])) {
      table += `<tr><td>${esc(engine)}</td><td class="num">${n.toLocaleString("en")}</td><td>${esc(r.status)}${r.error ? ` <span class="muted">${esc(`${r.failedAt}: ${r.error}`)}</span>` : ""}</td>`;
      for (const m of MEASURES) {
        const s = r.status === "ok" ? m.pick(r) : undefined;
        table += s ? `<td class="num">${fmt(s.median)}</td><td class="num">${fmt(s.p95)}</td>` : `<td></td><td></td>`;
      }
      table += `</tr>`;
    }
    const c = d.correctness?.[n];
    if (c) table += `<tr class="muted"><td colspan="${3 + MEASURES.length * 2}">${n.toLocaleString("en")} rows: ${c.match ? `same results from ${c.compared.join(", ")}` : `MISMATCH: ${esc(c.mismatches.join("; "))}`}</td></tr>`;
  }
  table += `</tbody></table>`;
}

const m0 = ok[0];
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>plateau M0 benchmark</title>
<style>
.viz-root {
  color-scheme: light;
  --surface-1: #fcfcfb; --text-primary: #0b0b0b; --text-secondary: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7;
  --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a; --series-4: #8a5cd6; --series-5: #c2417f;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) .viz-root {
    color-scheme: dark;
    --surface-1: #1a1a19; --text-primary: #f0efec; --text-secondary: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835;
    --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #9b72e0; --series-5: #d6589a;
  }
}
:root[data-theme="dark"] .viz-root {
  color-scheme: dark;
  --surface-1: #1a1a19; --text-primary: #f0efec; --text-secondary: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835;
  --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #9b72e0; --series-5: #d6589a;
}
body { margin: 0; }
.viz-root { background: var(--surface-1); color: var(--text-primary); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 24px 28px 48px; }
h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 28px 0 8px; } h3 { font-size: 14px; margin: 20px 0 6px; }
p { margin: 4px 0; color: var(--text-secondary); max-width: 70rem; }
.muted { color: var(--muted); fill: var(--muted); }
.legend { display: flex; gap: 18px; margin: 14px 0 6px; flex-wrap: wrap; color: var(--text-secondary); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend svg { width: 26px; height: 10px; }
.grid-head, .row { display: grid; gap: 8px; align-items: center; }
.colhead { font-weight: 600; color: var(--text-secondary); text-align: center; }
.rowhead { color: var(--text-secondary); font-size: 13px; padding-right: 8px; }
.cell svg { width: 100%; max-width: 380px; height: auto; display: block; margin: 0 auto; overflow: visible; }
svg text { font-size: 10px; } .tick { font-variant-numeric: tabular-nums; } .flag { font-size: 9px; }
.dlabel { fill: var(--text-secondary); font-size: 10px; }
.grid { stroke: var(--grid); stroke-width: 1; } .axis { stroke: var(--axis); stroke-width: 1; }
.line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.dot { stroke: var(--surface-1); stroke-width: 2; } .hit { fill: transparent; cursor: default; }
.pt:hover .dot { r: 5.5; }
#tip { position: fixed; pointer-events: none; background: var(--surface-1); color: var(--text-primary); border: 1px solid var(--axis); border-radius: 6px; padding: 6px 8px; font-size: 12px; white-space: pre; box-shadow: 0 2px 8px rgb(0 0 0 / 0.15); display: none; z-index: 10; }
table { border-collapse: collapse; font-size: 12px; margin-bottom: 8px; }
th, td { padding: 3px 8px; border-bottom: 1px solid var(--grid); text-align: left; white-space: nowrap; }
th { color: var(--text-secondary); font-weight: 600; } td.num { text-align: right; font-variant-numeric: tabular-nums; }
.wrap { overflow-x: auto; }
</style>
</head>
<body>
<div class="viz-root">
<h1>plateau M0 benchmark: median latency vs row count</h1>
<p>Generated from ${esc(docs.map((d) => d.file).join(", "))}. Machine: ${esc(m0 ? `${m0.machine.cpu}, ${m0.machine.memoryGiB} GiB, ${m0.machine.os}` : "n/a")}. Seed ${esc(String(m0?.seed ?? ""))}. Both axes are logarithmic; lower is better.</p>
<p>${esc(m0?.timing ?? "")}</p>
${blocked.map((b) => `<p><strong>${esc(b.browser)}: not measured.</strong> The browser did not start: ${esc(b.launchError)}</p>`).join("")}
<div class="legend">
${ENGINES.map((e) => `<span><svg viewBox="0 0 26 10"><line x1="1" x2="25" y1="5" y2="5" style="stroke:var(--series-${e.slot})" stroke-width="2"/><circle cx="13" cy="5" r="3.5" style="fill:var(--series-${e.slot})"/></svg>${esc(e.label)}</span>`).join("")}
${idbSqlite && idbSqlite.status !== "blocked" ? `<span><svg viewBox="0 0 26 10"><line x1="1" x2="25" y1="5" y2="5" style="stroke:var(--series-1)" stroke-width="2" stroke-dasharray="5 4"/></svg>IndexedDB with Chromium's SQLite backend forced on (Chromium column)</span>` : ""}
</div>
${grid}
<h2>All numbers</h2>
<div class="wrap">${table}</div>
</div>
<div id="tip"></div>
<script>
const tip = document.getElementById("tip");
document.querySelectorAll(".pt").forEach((el) => {
  el.addEventListener("mousemove", (e) => { tip.textContent = el.dataset.tip; tip.style.display = "block"; tip.style.left = e.clientX + 14 + "px"; tip.style.top = e.clientY + 14 + "px"; });
  el.addEventListener("mouseleave", () => { tip.style.display = "none"; });
});
</script>
</body>
</html>
`;
await writeFile(join(dir, "index.html"), html);
console.log(`wrote ${join(dir, "index.html")} from ${docs.length} result files`);
