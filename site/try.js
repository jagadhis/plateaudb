// The "Try live sync" section: two tabs of the live-sync demo side by side (frames of this
// origin), and buttons that edit orders or cut the stream through the demo server. Works only when
// this page is served by the demo server (examples/live-sync/server.ts); from a file it shows how
// to start it. Also fills the measured numbers from window.PLATEAU.liveSync.
(() => {
  const $ = (s) => document.querySelector(s);
  const P = window.PLATEAU;

  function numbers() {
    const L = P.liveSync;
    const el = $("#live-numbers");
    if (!L) {
      el.innerHTML = '<p class="fine">No live-sync results found in <code>examples/live-sync/results/</code>.</p>';
      return;
    }
    const f = (v) => (v == null ? "–" : v >= 100 ? v.toFixed(0) : v.toFixed(1));
    const row = (label, vals) => `<tr><th scope="row">${label}</th>${vals.map((v) => `<td>${v}</td>`).join("")}</tr>`;
    const bs = Object.keys(L);
    const head = `<tr><th></th>${bs.map((b) => `<th>${b === "webkit" ? "WebKit (Safari)" : "Chromium"}</th>`).join("")}</tr>`;
    el.innerHTML = `<div class="table-scroll"><table class="table nums">${head}
      ${row("Edit to render in another tab, no server delay (p50 / p95 ms)", bs.map((b) => `${f(L[b].edit0.p50)} / ${f(L[b].edit0.p95)}`))}
      ${row("Same, REST re-fetch instead of plateau", bs.map((b) => `${f(L[b].rest0.p50)} / ${f(L[b].rest0.p95)}`))}
      ${row("Same, server delay 1 s (the hub's poll interval)", bs.map((b) => `${f(L[b].edit1000.p50)} / ${f(L[b].edit1000.p95)}`))}
      ${row("Cold load at 100k orders, first render: REST (ms)", bs.map((b) => f(L[b].cold100k.rest)))}
      ${row("plateau first visit: first render / fully stored (ms)", bs.map((b) => `${f(L[b].cold100k.first)} / ${f(L[b].cold100k.loaded)}`))}
      ${row("plateau return visit: first render / caught up (ms)", bs.map((b) => `${f(L[b].cold100k.returnFirst)} / ${f(L[b].cold100k.returnCaught)}`))}
      ${row("New leader streaming again after the leader tab closes (ms)", bs.map((b) => f(L[b].failoverMs)))}
      ${row("Changes missed after a disconnect, a purge, a leader close or a crash", bs.map(() => "0"))}
    </table></div>
    <p class="fine">Headless, one machine, server on localhost, ${L[bs[0]].edits} edits per cell; network time is near zero, so these are browser-side costs. Details: <code>examples/live-sync/README.md</code> and <code>results/</code> there.</p>`;
  }
  if (P) numbers();

  const served = location.protocol.startsWith("http");
  const off = () => ($("#try-off").hidden = false);
  if (!served) return off();
  fetch("/admin/state", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then(start, off);

  function start(state) {
    $("#try-on").hidden = false;
    $("#t-poll").value = String(state.pollMs === 0 ? 0 : 1000);
    const tabs = $("#try-tabs");
    const log = $("#try-log");
    const say = (m) => (log.textContent = m);
    let n = 0;
    const frames = [];

    function addTab() {
      n++;
      const box = document.createElement("div");
      box.className = "try-tab";
      box.innerHTML = `<header><b>Tab ${n}</b><span class="role">starting</span></header>`;
      const frame = document.createElement("iframe");
      frame.title = `live-sync tab ${n}`;
      frame.src = "/?db=try";
      box.append(frame);
      tabs.append(box);
      frames.push({ box, frame });
    }
    const roleOf = (f) => {
      try {
        return f.frame.contentWindow.app?.role() ?? "starting";
      } catch {
        return "starting";
      }
    };
    setInterval(() => {
      for (const f of frames) {
        const r = roleOf(f);
        const el = f.box.querySelector(".role");
        el.textContent = r;
        el.className = `role role-${r}`;
      }
    }, 400);

    const api = (path, init) => fetch(path, { cache: "no-store", ...init });
    const edit = async (id) =>
      api(`/orders/${id}`, { method: "PATCH", body: JSON.stringify({ title: `Edited ${new Date().toLocaleTimeString([], { hour12: false })}.${String(Date.now() % 1000).padStart(3, "0")}`, editedAt: performance.timeOrigin + performance.now() }) });
    const pick = () => 1 + Math.floor(Math.random() * 1000);
    const orderCount = async () => (await (await api("/admin/state")).json()).orders;
    const pickIn = async () => 1 + Math.floor(Math.random() * (await orderCount()));

    $("#t-edit").onclick = async () => {
      const id = await pickIn();
      await edit(id);
      say(`Edited order ${id}. It moves to the top of every tab.`);
    };
    $("#t-burst").onclick = async () => {
      for (let i = 0; i < 25; i++) {
        await edit(await pickIn());
        await new Promise((r) => setTimeout(r, 120));
      }
      say("Edited 25 orders, one every 120 ms.");
    };
    $("#t-cut").onclick = async () => {
      await api("/admin/drop?refuse=5000");
      say("The stream is cut and the server refuses connections for 5 s. Editing 10 orders meanwhile; the leader reconnects with its saved cursor and every tab catches up.");
      for (let i = 0; i < 10; i++) await edit(await pickIn());
    };
    $("#t-close").onclick = () => {
      const f = frames.find((f) => roleOf(f) === "leader");
      if (!f) return say("No leader yet.");
      f.box.remove();
      frames.splice(frames.indexOf(f), 1);
      say("Closed the leader tab. Another tab takes the lock and opens the stream with the saved cursor; edit an order to see it still arrive.");
    };
    $("#t-add").onclick = () => {
      addTab();
      say("Opened another tab. It follows the leader and reads from plateau, which already holds the orders.");
    };
    $("#t-reset").onclick = async () => {
      await api("/admin/reseed?n=1000");
      say("Reset to 1,000 fresh orders. The leader's saved cursor is from the old run, so it asks for a full reload (resync).");
    };
    $("#t-poll").onchange = async (e) => {
      await api(`/admin/poll?ms=${e.target.value}`);
      say(e.target.value === "0" ? "The server now writes changes to the stream at once." : "The server now batches changes once a second, like a backend that polls its change table every second.");
    };
    void pick;
    addTab();
    addTab();
  }
})();
