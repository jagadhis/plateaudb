// Measures the live-sync example in Chromium and WebKit (headless, Playwright, persistent profiles
// so OPFS works). It starts its own server (server.ts) and builds the client first.
//
//   bun measure.ts [--browsers chromium,webkit] [--only latency,catchup,cold,failover]
//                  [--edits 100] [--sizes 10000,100000] [--reps 3] [--out results]
//
// 1. latency   PATCH to render, in a follower tab and in the leader tab, at POLL_MS 0 and 1000, for
//              plateau and for the REST-only mode. The edit carries editedAt (epoch ms taken just
//              before the PATCH); the tab records the epoch ms of the DOM update that first showed
//              the edited version; both clocks are the machine's.
// 2. catchup   a forced disconnect with edits during the gap (and with the server's history purged):
//              every order must end at the server's version.
// 3. cold      navigation to first render at 10k and 100k orders: REST, plateau first visit,
//              plateau return visit.
// 4. failover  the leader tab closes (or, in Chromium, crashes) during continuous edits: a new
//              leader reconnects with the stored cursor and nothing is missed.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, webkit, type BrowserContext, type BrowserType, type Page } from "playwright";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const browsers = arg("browsers", "chromium,webkit").split(",").filter(Boolean);
const only = arg("only", "latency,catchup,cold,failover").split(",");
const EDITS = Number(arg("edits", "100"));
const SIZES = arg("sizes", "10000,100000").split(",").map(Number);
const REPS = Number(arg("reps", "3"));
const OUT = resolve(import.meta.dir, arg("out", "results"));
const PORT = Number(arg("port", "5193"));
const types: Record<string, BrowserType> = { chromium, webkit };
const BASE = `http://localhost:${PORT}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const epoch = () => performance.timeOrigin + performance.now();

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN);
  const r = (n: number) => Math.round(n * 10) / 10;
  return { n: s.length, p50: r(q(0.5)), p95: r(q(0.95)), min: r(s[0] ?? NaN), max: r(s[s.length - 1] ?? NaN) };
}

// Server.

async function run(cmd: string[], cwd: string): Promise<void> {
  const p = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")} failed`);
}

const admin = async <T = any>(path: string): Promise<T> => (await fetch(`${BASE}/admin/${path}`)).json() as Promise<T>;
let server = null as { kill(): void } | null;

async function startServer(): Promise<void> {
  server = Bun.spawn(["bun", "server.ts", "--port", String(PORT), "--orders", "1000", "--poll-ms", "0"], { cwd: import.meta.dir, stdout: "ignore", stderr: "inherit" });
  for (let i = 0; i < 100; i++) {
    try {
      await admin("state");
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error("server did not start");
}

async function patch(id: number): Promise<{ version: number; editedAt: number }> {
  const editedAt = epoch();
  const res = await fetch(`${BASE}/orders/${id}`, { method: "PATCH", body: JSON.stringify({ editedAt }) });
  const o = (await res.json()) as { version: number };
  return { version: o.version, editedAt };
}

// Browsers.

interface Session {
  ctx: BrowserContext;
  open(query: string): Promise<Page>;
  close(): Promise<void>;
}

async function session(type: BrowserType): Promise<Session> {
  const dir = await mkdtemp(join(tmpdir(), "live-sync-"));
  const ctx = await type.launchPersistentContext(dir, { headless: true });
  return {
    ctx,
    async open(query) {
      const page = await ctx.newPage();
      page.on("pageerror", (e) => console.error(`  page error: ${e.message}\n${e.stack}`));
      await page.goto(`${BASE}/?${query}`);
      return page;
    },
    async close() {
      await ctx.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const app = <T>(p: Page, fn: (a: Window["app"]) => T | Promise<T>): Promise<T> => p.evaluate(`(${fn.toString()})(window.app)`) as Promise<T>;

async function untilTrue(what: string, ok: () => Promise<boolean>, ms = 30_000, step = 20): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(step);
  }
}

const firstRendered = (p: Page, ms = 60_000) => untilTrue("first render", async () => (await app(p, (a) => a.firstRender)) !== null, ms, 10);
const caughtUp = (p: Page, ms = 60_000) => untilTrue("caught up", async () => (await app(p, (a) => a.caughtUp)) !== null, ms, 10);
const roleOf = (p: Page) => app(p, (a) => a.role());

async function leaderAmong(pages: Page[]): Promise<Page> {
  let found: Page | null = null;
  await untilTrue("a leader", async () => {
    for (const p of pages) if ((await roleOf(p)) === "leader") (found = p);
    return found !== null;
  });
  return found!;
}

/** Waits until `p`'s plateau holds every order at the server's version. */
async function matchesServer(p: Page, ids: number[] | null, ms = 30_000): Promise<{ missing: number; stale: number }> {
  const want = await admin<Record<number, number>>("versions");
  const check = ids ?? Object.keys(want).map(Number);
  let missing = 0;
  let stale = 0;
  await untilTrue("tab to hold the server's versions", async () => {
    const have = await p.evaluate(([ids]) => window.app.versionsOf(ids as number[] | null), [ids] as const);
    missing = stale = 0;
    for (const id of check) {
      if (have[id] === undefined) missing++;
      else if (have[id] !== want[id]) stale++;
    }
    return missing === 0 && stale === 0;
  }, ms, 100).catch(() => {});
  return { missing, stale };
}

// 1. Latency.

async function latency(name: string, type: BrowserType): Promise<unknown> {
  const out: Record<string, unknown> = {};
  for (const mode of ["plateau", "rest"] as const) {
    for (const pollMs of [0, 1000]) {
      await admin("reseed?n=1000");
      await admin(`poll?ms=${pollMs}`);
      const s = await session(type);
      const db = `lat-${mode}-${pollMs}`;
      const pages = [await s.open(`mode=${mode}&db=${db}`), await s.open(`mode=${mode}&db=${db}`)];
      for (const p of pages) await firstRendered(p);
      await sleep(300);
      let leader = pages[0];
      if (mode === "plateau") leader = await leaderAmong(pages);
      const follower = pages.find((p) => p !== leader)!;
      const lat: Record<"leader" | "follower", number[]> = { leader: [], follower: [] };
      const stage = { eventAfterEdit: [] as number[], fetch: [] as number[], commit: [] as number[], renderAfterCommit: [] as number[] };
      let missed = 0;
      for (let i = 0; i < EDITS; i++) {
        // The edit lands at a random point of the server's poll interval.
        await sleep(Math.random() * (pollMs || 100));
        const { version, editedAt } = await patch(1 + (i % 900));
        const [a, b] = await Promise.all([leader, follower].map((p) => p.evaluate(([id, v]) => window.app.rendered(id, v, 10_000), [1 + (i % 900), version] as const)));
        if (!a || !b) {
          missed++;
          continue;
        }
        const seen = await Promise.all([leader, follower].map((p) => p.evaluate(([k]) => window.app.seen.get(k as string) ?? null, [`${1 + (i % 900)}:${version}`] as const)));
        lat.leader.push(seen[0]! - editedAt);
        lat.follower.push(seen[1]! - editedAt);
        if (mode === "plateau") {
          const st = await leader.evaluate(([k]) => window.app.stages.get(k as string) ?? null, [`${1 + (i % 900)}:${version}`] as const);
          if (st) {
            stage.eventAfterEdit.push(st.event - editedAt);
            stage.fetch.push(st.fetched - st.event);
            stage.commit.push(st.committed - st.fetched);
            stage.renderAfterCommit.push(seen[0]! - st.committed);
          }
        }
      }
      const key = `${mode}@poll${pollMs}`;
      out[key] = {
        edits: EDITS,
        missed,
        leader: stats(lat.leader),
        follower: stats(lat.follower),
        ...(mode === "plateau" ? { leaderStages: Object.fromEntries(Object.entries(stage).map(([k, v]) => [k, stats(v)])) } : {}),
      };
      console.log(`[${name}] latency ${key}: follower p50 ${stats(lat.follower).p50} p95 ${stats(lat.follower).p95} ms, leader p50 ${stats(lat.leader).p50} p95 ${stats(lat.leader).p95} ms (missed ${missed})`);
      await s.close();
    }
  }
  return out;
}

// 2. Catch-up after a forced disconnect.

async function catchup(name: string, type: BrowserType): Promise<unknown> {
  const out: Record<string, unknown> = {};
  for (const variant of ["history kept", "history purged"] as const) {
    await admin("reseed?n=1000");
    await admin("poll?ms=0");
    const s = await session(type);
    const db = `catch-${variant.replace(" ", "-")}`;
    const pages = [await s.open(`mode=plateau&db=${db}`), await s.open(`mode=plateau&db=${db}`)];
    for (const p of pages) await firstRendered(p);
    await sleep(300);
    const leader = await leaderAmong(pages);
    const before = await app(leader, (a) => a.opened.length);
    await admin("drop");
    const droppedAt = epoch();
    // Edits during the gap: 40 distinct orders, ten of them twice.
    const edited: number[] = [];
    for (let i = 0; i < 40; i++) {
      await patch(1 + i);
      edited.push(1 + i);
    }
    for (let i = 0; i < 10; i++) await patch(1 + i);
    if (variant === "history purged") await admin("purge");
    await untilTrue("the leader to reconnect", async () => (await app(leader, (a) => a.opened.length)) > before, 20_000);
    const reconnectedAt = epoch();
    const results: Record<string, { missing: number; stale: number }> = {};
    for (const [i, p] of pages.entries()) results[i === pages.indexOf(leader) ? "leader" : "follower"] = await matchesServer(p, null, 30_000);
    const appliedAt = epoch();
    const orders = (await admin("state")).orders;
    out[variant] = {
      orders,
      gapEdits: 50,
      distinctEditedOrders: edited.length,
      reconnectAfterDropMs: Math.round(reconnectedAt - droppedAt),
      allAppliedAfterDropMs: Math.round(appliedAt - droppedAt),
      leader: results.leader,
      follower: results.follower,
    };
    console.log(`[${name}] catch-up (${variant}): reconnect ${Math.round(reconnectedAt - droppedAt)} ms, all applied ${Math.round(appliedAt - droppedAt)} ms, missing/stale leader ${results.leader.missing}/${results.leader.stale}, follower ${results.follower.missing}/${results.follower.stale}`);
    await s.close();
  }
  return out;
}

// 3. Cold load.

async function cold(name: string, type: BrowserType): Promise<unknown> {
  const out: Record<string, unknown> = {};
  for (const n of SIZES) {
    await admin(`reseed?n=${n}`);
    await admin("poll?ms=1000");
    const runs: Record<string, number[]> = { restFirstRender: [], restRepeatFirstRender: [], plateauFirstVisitFirstRender: [], plateauFirstVisitLoaded: [], plateauReturnFirstRender: [], plateauReturnCaughtUp: [] };
    let mismatches = 0;
    for (let r = 0; r < REPS; r++) {
      {
        const s = await session(type);
        const p1 = await s.open("mode=rest");
        await firstRendered(p1);
        runs.restFirstRender.push((await app(p1, (a) => a.firstRender))!);
        await p1.close();
        const p2 = await s.open("mode=rest");
        await firstRendered(p2);
        runs.restRepeatFirstRender.push((await app(p2, (a) => a.firstRender))!);
        await s.close();
      }
      {
        const s = await session(type);
        const db = `cold-${n}-${r}`;
        const p1 = await s.open(`mode=plateau&db=${db}`);
        await firstRendered(p1);
        await caughtUp(p1);
        runs.plateauFirstVisitFirstRender.push((await app(p1, (a) => a.firstRender))!);
        runs.plateauFirstVisitLoaded.push((await app(p1, (a) => a.caughtUp))!);
        await p1.close();
        // Edits while the app is closed: the return visit applies them from its cursor.
        const ids = Array.from({ length: 50 }, (_, i) => 1 + i * 7);
        for (const id of ids) await patch(id);
        const p2 = await s.open(`mode=plateau&db=${db}`);
        await firstRendered(p2);
        await caughtUp(p2);
        runs.plateauReturnFirstRender.push((await app(p2, (a) => a.firstRender))!);
        runs.plateauReturnCaughtUp.push((await app(p2, (a) => a.caughtUp))!);
        const check = await matchesServer(p2, ids, 20_000);
        mismatches += check.missing + check.stale;
        const count = await app(p2, (a) => a.stored());
        if (count !== n) mismatches++;
        await s.close();
      }
      // The next repetition starts from the same data.
      await admin(`reseed?n=${n}`);
    }
    out[`${n} orders`] = { reps: REPS, mismatches, ...Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, { ...stats(v), runsMs: v.map((x) => Math.round(x)) }])) };
    const m = (k: string) => stats(runs[k]).p50;
    console.log(`[${name}] cold ${n}: rest ${m("restFirstRender")} ms (repeat ${m("restRepeatFirstRender")}), plateau first visit ${m("plateauFirstVisitFirstRender")} ms (loaded ${m("plateauFirstVisitLoaded")}), plateau return ${m("plateauReturnFirstRender")} ms (caught up ${m("plateauReturnCaughtUp")}), mismatches ${mismatches}`);
  }
  return out;
}

// 4. Leader failover during continuous edits.

async function failover(name: string, type: BrowserType): Promise<unknown> {
  const out: Record<string, unknown> = {};
  const variants: ("close" | "crash")[] = name === "chromium" ? ["close", "crash"] : ["close"];
  for (const how of variants) {
    await admin("reseed?n=1000");
    await admin("poll?ms=0");
    const s = await session(type);
    const db = `fail-${how}`;
    const tabs = how === "close" ? 3 : 2;
    let pages = [] as Page[];
    for (let i = 0; i < tabs; i++) pages.push(await s.open(`mode=plateau&db=${db}`));
    for (const p of pages) await untilTrue("tab rendered", async () => (await app(p, (a) => a.firstRender)) !== null || (await app(p, (a) => a.role())) !== "pending", 20_000).catch(() => {});
    await sleep(500);
    let editing = true;
    const edited = new Set<number>();
    const editor = (async () => {
      let i = 0;
      while (editing) {
        const id = 1 + ((i++ * 37) % 900);
        await patch(id).catch(() => {});
        edited.add(id);
        await sleep(15);
      }
    })();
    const failovers: Record<string, unknown>[] = [];
    const rounds = how === "close" ? 2 : 1;
    for (let round = 0; round < rounds; round++) {
      await sleep(500);
      const leader = await leaderAmong(pages);
      const rest = pages.filter((p) => p !== leader);
      const opened = await Promise.all(rest.map((p) => app(p, (a) => a.opened.length)));
      const readyCounts = await Promise.all(rest.map((p) => app(p, (a) => a.readies.length)));
      const killedAt = epoch();
      if (how === "close") await leader.close({ runBeforeUnload: false });
      else {
        const cdp = await s.ctx.newCDPSession(leader);
        const crashed = leader.waitForEvent("crash");
        void cdp.send("Page.crash").catch(() => {});
        await crashed;
      }
      pages = rest;
      // The tab that takes over opens the stream with the cursor plateau holds.
      let newLeader: Page | null = null;
      let newIndex = -1;
      await untilTrue("a new leader's stream", async () => {
        for (const [i, p] of rest.entries()) {
          if ((await app(p, (a) => a.role())) === "leader" && (await app(p, (a) => a.opened.length)) > opened[i]) {
            newLeader = p;
            newIndex = i;
            return true;
          }
        }
        return false;
      }, 20_000);
      const readiesBefore = readyCounts[newIndex];
      await untilTrue("the new leader's ready", async () => (await app(newLeader!, (a) => a.readies.length)) > readiesBefore, 20_000);
      const stream = await app(newLeader!, (a) => ({ opened: a.opened, readies: a.readies }));
      const reconnectedAt = stream.opened[stream.opened.length - 1];
      const readyAt = stream.readies[stream.readies.length - 1];
      failovers.push({ round: round + 1, leaderTabsLeft: rest.length, newLeaderStreamOpenMs: Math.round(reconnectedAt - killedAt), newLeaderReadyMs: Math.round(readyAt - killedAt) });
    }
    await sleep(1000);
    editing = false;
    await editor;
    const survivors = pages;
    const verdicts: { missing: number; stale: number }[] = [];
    for (const p of survivors) verdicts.push(await matchesServer(p, null, 30_000));
    // An edit after the failover reaches every surviving tab.
    const probe = await patch(999);
    const rendered = await Promise.all(survivors.map((p) => p.evaluate(([id, v]) => window.app.rendered(id, v, 5000), [999, probe.version] as const)));
    out[how] = { editsDuringRun: edited.size, failovers, survivors: survivors.length, versionsVsServer: verdicts, editAfterFailoverRenderedEverywhere: rendered.every(Boolean) };
    console.log(`[${name}] failover (${how}): ${JSON.stringify(failovers)}; missing/stale ${verdicts.map((v) => `${v.missing}/${v.stale}`).join(", ")}; later edit rendered everywhere: ${rendered.every(Boolean)}`);
    await s.close();
  }
  return out;
}

// Main.

await run(["bunx", "vite", "build"], import.meta.dir);
await mkdir(OUT, { recursive: true });
await startServer();
try {
  for (const b of browsers) {
    const type = types[b];
    const result: Record<string, unknown> = { browser: b, version: type.name(), at: new Date().toISOString(), edits: EDITS };
    if (only.includes("latency")) result.latency = await latency(b, type);
    if (only.includes("catchup")) result.catchup = await catchup(b, type);
    if (only.includes("cold")) result.cold = await cold(b, type);
    if (only.includes("failover")) result.failover = await failover(b, type);
    const file = join(OUT, `live-sync-${b}${only.length < 4 ? `-${only.join("+")}` : ""}.json`);
    await writeFile(file, JSON.stringify(result, null, 2) + "\n");
    console.log(`wrote ${file}`);
  }
} finally {
  server?.kill();
}
