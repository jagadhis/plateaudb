// Renders every number and chart on the page from window.PLATEAU (site/data.js).
(() => {
  const P = window.PLATEAU;
  const SIZES = ["10000", "100000", "1000000"];
  const SIZE_LABEL = { "10000": "10k rows", "100000": "100k rows", "1000000": "1M rows" };
  const BROWSER_LABEL = { chromium: "Chromium", webkit: "WebKit (Safari)", firefox: "Firefox" };
  const ENGINES = [
    { key: "idb", label: "Native IndexedDB", color: "var(--idb)" },
    { key: "sqlite", label: "SQLite-WASM (OPFS)", color: "var(--sqlite)" },
    { key: "plateau-idb", label: "plateau API, typed store", color: "var(--plateau-idb)" },
    { key: "plateau-idb-generic", label: "plateau API, generic store", color: "var(--plateau-gen)" },
    { key: "plateau", label: "plateau engine-direct", color: "var(--plateau)", optional: true },
  ];
  const QUERIES = [
    { key: "q1", label: "Q1" },
    { key: "q2", label: "Q2" },
    { key: "q3", label: "Q3" },
    { key: "q4", label: "Q4" },
    { key: "gets", label: "1,000 gets" },
  ];
  const state = { browser: "chromium", size: "1000000", engineDirect: false };

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const ms = (v) => (v == null ? "–" : v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} s` : v >= 100 ? `${v.toFixed(0)} ms` : v >= 10 ? `${v.toFixed(1)} ms` : v >= 1 ? `${v.toFixed(2)} ms` : `${v.toFixed(3)} ms`);
  const mib = (b) => (b == null ? "–" : `${(b / 1048576).toFixed(b >= 100 * 1048576 ? 0 : 1)} MiB`);
  const ratio = (a, b) => (a && b ? a / b : null);
  const xfmt = (r) => (r == null ? "" : r >= 1 ? `${r >= 100 ? r.toFixed(0) : r >= 10 ? r.toFixed(0) : r.toFixed(1)}×` : `${(1 / r).toFixed(1)}× slower`);
  const svg = (w, h, body) => `<svg viewBox="0 0 ${w} ${h}" role="img">${body}</svg>`;
  const browsersOk = () => Object.entries(P.browsers).filter(([, b]) => b.status === "ok").map(([k]) => k);
  const eng = (browser, size, key) => P.browsers[browser]?.sizes?.[size]?.engines?.[key] ?? null;
  const shown = () => ENGINES.filter((e) => !e.optional || state.engineDirect);

  // Hero: plateau's API (typed store) against native IndexedDB at 1M rows.
  function hero() {
    const size = "1000000";
    const pick = (b, k, f) => f(eng(b, size, k));
    const items = [
      { what: "Multi-key query (Q2)", f: (e) => e?.warm.q2?.median },
      { what: "Latest 50 by team, state, priority (Q4)", f: (e) => e?.warm.q4?.median },
      { what: "1,000 point reads", f: (e) => e?.warm.gets?.median },
      { what: "Update commit (1k + 1k rows)", f: (e) => e?.updateCommits?.[0]?.ms },
      { what: "Bulk load, 1M rows", f: (e) => e?.loadMs },
      { what: "Fresh page to first answer", f: (e) => e?.fresh?.median },
    ];
    $("#hero-stats").innerHTML = items
      .map((it) => {
        const a = pick("chromium", "idb", it.f), b = pick("chromium", "plateau-idb", it.f);
        const wa = pick("webkit", "idb", it.f), wb = pick("webkit", "plateau-idb", it.f);
        const r = ratio(a, b), wr = ratio(wa, wb);
        return `<div class="stat"><div class="stat-x ${r < 1 ? "slower" : ""}">${xfmt(r)}</div><div class="stat-what">${it.what}</div><div class="stat-from">${ms(a)} → ${ms(b)}${wr ? ` · WebKit ${xfmt(wr)}` : ""}</div></div>`;
      })
      .join("");
    const c = P.browsers.chromium;
    $("#hero-note").textContent = `plateau's IndexedDB-compatible API (typed store) against the browser's own IndexedDB, 1M rows, Chromium ${c.version.split(".")[0]} on an ${c.machine.cpu}; WebKit alongside. Medians of ${c.runs} runs. Fresh page is where plateau is still slower.`;
  }

  function timeline() {
    const M = [
      ["M0", "kill", "Spike and benchmark", "In-memory engine with bitmaps and a snapshot file. 5-58x faster than IndexedDB, but SQLite-WASM within 2x on two queries: kill by the rule. The project went on with a fairer rule."],
      ["M0b", "kill", "Persisted indexes, fair SQLite", "SQLite behind the same query layer, a fixed-size Q4 added. Median 1.8x / 1.4x over SQLite, short of 2x. One more iteration was chosen."],
      ["M0c", "iter", "Grouped ordered index", "Counts and ordered walks inside one team. Chromium passes, WebKit 1.6x short: iterate."],
      ["M1a", "done", "Lazy paged open", "Cold open at 1M rows from 67 ms to 5 ms; 4.7 MB read of a 133 MB file to answer the first query."],
      ["M1b", "done", "Beat IndexedDB on reopen", "Reopen plus first query 0.36 ms against IndexedDB's 0.96 ms."],
      ["M1c", "done", "Fresh page start-up", "Engines start at navigation; gap to IndexedDB narrowed to 1-3 ms."],
      ["M1d", "kill", "Main-thread reader spike", "A first-query reader outside the worker failed its gate; dropped."],
      ["M1e", "done", "Updates, deletes, compaction", "Crash-safe across 1,410 tear points. 1k+1k commit 3-6 ms against IndexedDB 96-264 ms."],
      ["M2a", "done", "IndexedDB-compatible API", "84/85 conformance, hybrid values: declared fields become typed columns."],
      ["M1f", "done", "Memory budget", "1M rows in 59 MiB by default, 29 MiB at a 24 MiB budget; files stay at their used size."],
      ["M2c", "next", "API start-up", "Close the fresh-page gap with native IndexedDB."],
    ];
    const V = { done: ["v-done", "shipped"], iter: ["v-iter", "iterate"], kill: ["v-kill", "rule said kill"], next: ["v-next", "next"] };
    $("#timeline").innerHTML = M.map(([tag, v, title, body]) => `<li class="${v === "next" ? "next" : ""}"><span class="tag">${tag}</span><span class="verdict ${V[v][0]}">${V[v][1]}</span><div class="t-title">${title}</div><div class="t-body">${body}</div></li>`).join("");
  }

  function plans() {
    const b = "chromium", size = "1000000";
    const words = {
      idb: "Reads each state's newest rows for the team from a compound index, one range per state, then merges them.",
      sqlite: "Walks the team's index in updatedAt order and checks the state on each row until it has 50.",
      "plateau-idb": (() => {
        const m = /group:teamId=(\d+):(\d+).*steps=(\d+)/.exec(eng(b, size, "plateau-idb")?.plans?.q1 ?? "");
        return m ? `Takes team ${m[1]}'s bitmap (${Number(m[2]).toLocaleString("en")} rows), keeps the rows in the wanted states, then walks that team's updatedAt list from the top: ${m[3]} steps for 50 rows.` : "";
      })(),
    };
    const rows = [
      ["idb", "Native IndexedDB", (e) => (e?.info?.q1Path ? `${e.info.q1Path}, on the compound index ${e.info.indexes?.[0] ?? ""}` : null)],
      ["sqlite", "SQLite-WASM", (e) => e?.plans?.q1],
      ["plateau-idb", "plateau", (e) => e?.plans?.q1],
    ];
    $("#plans").innerHTML = rows
      .map(([k, label, f]) => {
        const e = eng(b, size, k);
        return `<div class="plan"><div><div class="who">${label}</div><div class="ms">${ms(e?.warm.q1?.median)}</div></div><div><code>${esc(f(e) ?? "not recorded")}</code><div class="fine">${esc(words[k])}</div></div></div>`;
      })
      .join("");
  }

  // Controls
  function controls() {
    const bs = Object.keys(P.browsers);
    $("#ctl-browser").innerHTML = bs.map((b) => `<button role="radio" data-b="${b}" ${P.browsers[b].status !== "ok" ? `disabled title="Not measured: ${esc(P.browsers[b].launchError || "blocked")}"` : ""}>${BROWSER_LABEL[b] || b}</button>`).join("");
    $("#ctl-size").innerHTML = SIZES.map((s) => `<button role="radio" data-s="${s}">${SIZE_LABEL[s]}</button>`).join("");
    $("#ctl-browser").addEventListener("click", (e) => { const t = e.target.closest("button[data-b]"); if (t && !t.disabled) { state.browser = t.dataset.b; render(); } });
    $("#ctl-size").addEventListener("click", (e) => { const t = e.target.closest("button[data-s]"); if (t) { state.size = t.dataset.s; render(); } });
    $("#ctl-engine").addEventListener("change", (e) => { state.engineDirect = e.target.checked; render(); });
  }
  function syncControls() {
    document.querySelectorAll("#ctl-browser button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.b === state.browser)));
    document.querySelectorAll("#ctl-size button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.s === state.size)));
    $("#legend").innerHTML = shown().map((e) => `<span><i style="background:${e.color}"></i>${e.label}</span>`).join("");
  }

  // Horizontal grouped bars. groups: [{label, items: [{engine, value, note, noteClass, tip}]}]
  function hbars(el, groups, { log = false, fmt = ms, right = 0 } = {}) {
    const all = groups.flatMap((g) => g.items.map((i) => i.value)).filter((v) => v != null && v > 0);
    if (!all.length) { el.innerHTML = `<div class="empty">Not measured for this selection.</div>`; return; }
    const W = Math.max(320, Math.round(el.clientWidth || 900)), L = W < 420 ? 70 : W < 600 ? 92 : 110, R = right || (W < 420 ? 112 : W < 600 ? 150 : 170), bar = 15, gap = 4, ggap = 18;
    const n = groups.reduce((s, g) => s + g.items.length, 0);
    const H = n * (bar + gap) + groups.length * ggap + 26;
    let lo = log ? Math.pow(10, Math.floor(Math.log10(Math.min(...all)))) : 0;
    let hi = log ? Math.pow(10, Math.ceil(Math.log10(Math.max(...all)))) : Math.max(...all) * 1.05;
    if (log && hi === lo) hi = lo * 10;
    const sx = (v) => L + (log ? (Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) : v / hi) * (W - L - R);
    let ticks = "";
    const step = log && W < 500 && Math.log10(hi / lo) > 3 ? 100 : 10;
    if (log) for (let t = lo; t <= hi * 1.0001; t *= step) ticks += `<line x1="${sx(t)}" x2="${sx(t)}" y1="0" y2="${H - 22}"/><text x="${sx(t)}" y="${H - 6}" text-anchor="middle">${fmt(t).replace(".000", "").replace(/\.0+ /, " ")}</text>`;
    else for (let k = 0; k <= 4; k++) { const t = (hi * k) / 4; ticks += `<line x1="${sx(t)}" x2="${sx(t)}" y1="0" y2="${H - 22}"/><text x="${sx(t)}" y="${H - 6}" text-anchor="middle">${fmt(t)}</text>`; }
    let y = 4, body = `<g class="grid">${ticks}</g>`;
    for (const g of groups) {
      const gh = g.items.length * (bar + gap);
      body += `<text class="lbl" x="0" y="${y + gh / 2 + 4}">${esc(g.label)}</text>`;
      for (const it of g.items) {
        const e = ENGINES.find((x) => x.key === it.engine);
        if (it.value != null && it.value > 0) {
          const x1 = sx(Math.max(it.value, lo)), w = Math.max(2, x1 - L);
          body += `<rect x="${L}" y="${y}" width="${w}" height="${bar}" rx="3" fill="${e?.color ?? "var(--ink-3)"}"><title>${esc(`${it.label ?? e?.label}: ${fmt(it.value)}${it.tip ? " · " + it.tip : ""}`)}</title></rect>`;
          body += `<text class="val" x="${x1 + 6}" y="${y + bar - 3}">${fmt(it.value)}${it.note ? ` <tspan class="x ${it.noteClass || ""}">${esc(it.note)}</tspan>` : ""}</text>`;
        } else {
          body += `<text class="val" x="${L + 4}" y="${y + bar - 3}">not measured</text>`;
        }
        y += bar + gap;
      }
      y += ggap;
    }
    el.innerHTML = svg(W, H, body);
  }

  const vsIdb = (b, s, key, f) => {
    if (key === "idb") return {};
    const r = ratio(f(eng(b, s, "idb")), f(eng(b, s, key)));
    return r == null ? {} : { note: xfmt(r), noteClass: r < 1 ? "slow" : "" };
  };

  function chartQueries() {
    const { browser: b, size: s } = state;
    hbars(
      $("#chart-queries"),
      QUERIES.map((q) => ({
        label: q.label,
        items: shown().map((e) => {
          const f = (x) => x?.warm?.[q.key]?.median;
          const v = eng(b, s, e.key);
          return { engine: e.key, value: f(v), tip: v?.warm?.[q.key] ? `p95 ${ms(v.warm[q.key].p95)}` : "", ...vsIdb(b, s, e.key, f) };
        }),
      })),
      { log: true },
    );
  }

  function chartGrowth() {
    const b = state.browser;
    const subs = {
      q1: "Always 50 rows", q2: "Answer grows with the table", q3: "Counts a growing range", q4: "Always 50 rows", gets: "1,000 reads by key",
    };
    $("#chart-growth").innerHTML = QUERIES.map((q) => {
      const W = 260, H = 170, L = 40, R = 10, T = 8, B = 24;
      const vals = shown().flatMap((e) => SIZES.map((s) => eng(b, s, e.key)?.warm?.[q.key]?.median)).filter((v) => v > 0);
      if (!vals.length) return "";
      const lo = Math.pow(10, Math.floor(Math.log10(Math.min(...vals)))), hi = Math.pow(10, Math.ceil(Math.log10(Math.max(...vals))));
      const sy = (v) => T + (1 - (Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * (H - T - B);
      const sx = (i) => L + (i / (SIZES.length - 1)) * (W - L - R);
      let g = `<g class="grid">`;
      for (let t = lo; t <= hi * 1.0001; t *= 10) g += `<line x1="${L}" x2="${W - R}" y1="${sy(t)}" y2="${sy(t)}"/><text x="${L - 4}" y="${sy(t) + 3}" text-anchor="end">${t >= 1 ? t : t.toString().replace(/^0/, "")}</text>`;
      g += `</g>` + SIZES.map((s, i) => `<text x="${sx(i)}" y="${H - 6}" text-anchor="middle">${SIZE_LABEL[s].split(" ")[0]}</text>`).join("");
      for (const e of shown()) {
        const pts = SIZES.map((s, i) => [i, eng(b, s, e.key)?.warm?.[q.key]?.median, s]).filter(([, v]) => v > 0);
        if (!pts.length) continue;
        g += `<polyline fill="none" stroke="${e.color}" stroke-width="2.2" points="${pts.map(([i, v]) => `${sx(i)},${sy(v)}`).join(" ")}"/>`;
        g += pts.map(([i, v, s]) => `<circle cx="${sx(i)}" cy="${sy(v)}" r="3.4" fill="${e.color}"><title>${esc(`${e.label}, ${SIZE_LABEL[s]}: ${ms(v)}`)}</title></circle>`).join("");
        const first = pts[0][1], last = pts[pts.length - 1][1];
        if (pts.length === 3) g += `<title>${esc(e.label)} grows ${(last / first).toFixed(1)}x</title>`;
      }
      const growth = shown().map((e) => {
        const a = eng(b, "10000", e.key)?.warm?.[q.key]?.median, z = eng(b, "1000000", e.key)?.warm?.[q.key]?.median;
        return a && z ? `<span style="color:${e.color}">●</span> ${(z / a).toFixed(1)}×` : "";
      }).filter(Boolean).join(" &nbsp;");
      return `<div><h4>${q.label}</h4><div class="sub">${subs[q.key]} · 10k→1M: ${growth}</div>${svg(W, H, g)}</div>`;
    }).join("");
  }

  function chartStartup() {
    const { browser: b, size: s } = state;
    const cats = [["reopen", "Reopen"], ["fresh", "Fresh page"], ["freshFirstLoad", "First-ever load"]];
    hbars(
      $("#chart-startup"),
      cats.map(([k, label]) => ({
        label,
        items: shown().map((e) => {
          const f = (x) => x?.[k]?.median;
          return { engine: e.key, value: f(eng(b, s, e.key)), ...vsIdb(b, s, e.key, f) };
        }),
      })),
      { log: true },
    );
  }

  function chartWrites() {
    const { browser: b, size: s } = state;
    hbars(
      $("#chart-writes"),
      [
        { label: "Update commit", f: (x) => x?.updateCommits?.[0]?.ms },
        { label: "Bulk load", f: (x) => x?.loadMs },
      ].map(({ label, f }) => ({ label, items: shown().map((e) => ({ engine: e.key, value: f(eng(b, s, e.key)), ...vsIdb(b, s, e.key, f) })) })),
      { log: true },
    );
  }

  function chartMemory() {
    const b = state.browser, bud = P.browsers[b]?.sizes?.["1000000"]?.budgets ?? {};
    const variants = [["@24mb", "24 MiB budget"], ["", "Default (64 MiB)"], ["@unbounded", "No limit"]];
    const bases = [["plateau-idb", "Typed store"], ["plateau-idb-generic", "Generic store"]];
    if (state.engineDirect) bases.unshift(["plateau", "Engine-direct"]);
    hbars(
      $("#chart-memory"),
      bases.map(([k, label]) => ({
        label,
        items: variants.map(([v, vl]) => {
          const d = bud[k + v];
          return { engine: k, label: vl, value: d?.wasmMemoryBytes, note: `${vl.replace(" (64 MiB)", "")}${d?.gets ? ` · gets ${ms(d.gets.median)}` : ""}`, tip: d?.q2 ? `Q2 ${ms(d.q2.median)}` : "" };
        }),
      })),
      { fmt: mib, right: 250 },
    );
  }

  function chartDisk() {
    const { browser: b, size: s } = state;
    hbars(
      $("#chart-disk"),
      [{ label: SIZE_LABEL[s], items: shown().filter((e) => e.key !== "sqlite").map((e) => ({ engine: e.key, value: eng(b, s, e.key)?.fileBytes })) }],
      { fmt: mib },
    );
  }

  function tableAll() {
    const { browser: b, size: s } = state;
    const cols = [
      ...QUERIES.map((q) => [q.label, (e) => e?.warm?.[q.key]]),
      ["Reopen", (e) => e?.reopen],
      ["Fresh page", (e) => e?.fresh],
      ["First-ever", (e) => e?.freshFirstLoad],
      ["Update commit", (e) => (e?.updateCommits?.[0] ? { median: e.updateCommits[0].ms } : null)],
      ["Bulk load", (e) => (e?.loadMs ? { median: e.loadMs } : null)],
    ];
    const rows = shown().map((e) => [e, eng(b, s, e.key)]);
    const best = cols.map(([, f]) => Math.min(...rows.map(([, d]) => f(d)?.median ?? Infinity)));
    $("#table-all").innerHTML =
      `<thead><tr><th>Engine</th>${cols.map(([h]) => `<th>${h}</th>`).join("")}<th>WASM memory</th><th>On disk</th></tr></thead><tbody>` +
      rows.map(([e, d]) => `<tr><th><span style="color:${e.color}">●</span> ${e.label}</th>${cols.map(([, f], i) => { const v = f(d); return `<td class="${v?.median === best[i] ? "best" : ""}">${ms(v?.median)}${v?.p95 != null ? ` <small>(${ms(v.p95).replace(" ms", "")})</small>` : ""}</td>`; }).join("")}<td>${d?.wasmMemoryBytes ? mib(d.wasmMemoryBytes) : "–"}</td><td>${mib(d?.fileBytes)}</td></tr>`).join("") +
      `</tbody>`;
  }

  function method() {
    const items = browsersOk().map((k) => { const x = P.browsers[k]; return `${BROWSER_LABEL[k]} ${x.version} (Playwright ${x.playwright}, headless), ${x.date}`; });
    const c = P.browsers.chromium;
    const blocked = Object.entries(P.browsers).filter(([, b]) => b.status !== "ok").map(([k, b]) => `${BROWSER_LABEL[k]}: not measured (${esc(b.launchError || "blocked")}).`);
    $("#method").innerHTML = `<ul>
      <li>Machine: ${esc(c.machine.cpu)}, ${c.machine.cores} cores, ${c.machine.memoryGiB} GiB, ${esc(c.machine.os)}. Browsers: ${items.map(esc).join("; ")}. ${blocked.join(" ")}</li>
      <li>Warm: ${c.runs} timed runs per query after an untimed warm-up of 100 calls per query shape. Start-up: ${c.coldRuns} runs each. The median is shown; p95 is in the table and on hover.</li>
      <li>Every query is timed on the main thread from call to result. IndexedDB runs there with no hop; SQLite and plateau run in a worker, so their times include the message round trip and the result copy.</li>
      <li>SQLite-WASM uses the <code>opfs-sahpool</code> VFS behind a thin layer that takes the same query object plateau takes, compiles it to SQL and caches prepared statements, with indexes matching each query.</li>
      <li>IndexedDB gets the best compound indexes a careful developer would declare. ${esc(c.idbBackend || "")}</li>
      <li>Correctness: every engine returns identical results for every query at every size in both browsers (compared by result signatures).</li>
      <li>"plateau API" goes through <code>plateaudb</code> on the main thread, as an app would. "Engine-direct" calls the worker engine without the API. "Generic store" declares no columns.</li>
      <li>Caveats: one machine, headless, OS file cache warm even for "first-ever" loads. No phones. The pass/fail rules for each milestone were written before its run; the M0b rule was written after M0's numbers were known.</li>
    </ul>`;
  }

  function render() {
    syncControls();
    chartQueries();
    chartGrowth();
    chartStartup();
    chartWrites();
    chartMemory();
    chartDisk();
    tableAll();
  }

  // Nav highlight
  function navSpy() {
    const links = [...document.querySelectorAll(".nav a")];
    const io = new IntersectionObserver((es) => es.forEach((en) => { if (en.isIntersecting) links.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === `#${en.target.id}`)); }), { rootMargin: "-40% 0px -55% 0px" });
    links.forEach((a) => { const t = document.querySelector(a.getAttribute("href")); if (t) io.observe(t); });
  }

  $("#gen").textContent = P.generated;
  hero();
  timeline();
  plans();
  controls();
  method();
  render();
  navSpy();
  let rt;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 120); });
})();
