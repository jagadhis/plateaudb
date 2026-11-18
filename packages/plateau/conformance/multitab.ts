// Multi-tab tests: several pages of one origin in one browser context, each driving the same
// database, run against native IndexedDB and plateau's API in Chromium and WebKit (headless,
// Playwright, persistent profiles). Shared tests must pass on both; plateau-only tests check what
// native IndexedDB does not have: leader failover.
//
//   bun conformance/multitab.ts [--browsers chromium,webkit] [--filter text] [--json out.json]
// Exits non-zero if a test fails on plateau or a shared test's outcome differs from native.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, type BrowserContext, type BrowserType, type Page } from "playwright";
import { createServer } from "vite";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const browsers = arg("browsers", "chromium,webkit").split(",").filter(Boolean);
const filter = arg("filter", "");
const jsonOut = arg("json", "");
const types: Record<string, BrowserType> = { chromium, webkit };

type Impl = "native" | "plateau";

interface Ctx {
  browser: string;
  impl: Impl;
  ctx: BrowserContext;
  /** A fresh database name for this test. */
  name: string;
  /** Opens `n` pages, each ready (on plateau: knows its leader). */
  pages(n: number): Promise<Page[]>;
  /** Facts the test reports (timings, counts), printed with its result. */
  note: Record<string, unknown>;
}

interface Result {
  name: string;
  scope: "shared" | "plateau";
  status: "pass" | "fail";
  message?: string;
  note?: Record<string, unknown>;
  ms: number;
}

const tests: { name: string; scope: Result["scope"]; body: (t: Ctx) => Promise<void> }[] = [];
const test = (name: string, body: (t: Ctx) => Promise<void>) => tests.push({ name, scope: "shared", body });
const plateauTest = (name: string, body: (t: Ctx) => Promise<void>) => tests.push({ name, scope: "plateau", body });

class AssertionError extends Error {}
function assert(ok: unknown, msg: string): asserts ok {
  if (!ok) throw new AssertionError(msg);
}
function assertEq(a: unknown, b: unknown, msg: string): void {
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
  if (x !== y) throw new AssertionError(`${msg}: expected ${y} but got ${x}`);
}

/** Calls `window.tab[fn](...args)` in the page. */
const call = <T = any>(p: Page, fn: string, ...args: unknown[]): Promise<T> =>
  p.evaluate(([fn, args]) => (window.tab as any)[fn as string](...(args as unknown[])), [fn, args] as const) as Promise<T>;
const logOf = (p: Page): Promise<string[]> => p.evaluate(() => window.tab.log.slice());
const role = (p: Page): Promise<string> => p.evaluate(() => window.tab.role());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, ok: () => Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new AssertionError(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

const has = (log: string[], line: string) => log.includes(line);

// Shared tests.

test("a write in one tab is visible to reads in every other tab", async (t) => {
  const [a, b, c] = await t.pages(3);
  await call(a, "open", "x", t.name, 1, { stores: ["s"] });
  await call(b, "open", "x", t.name);
  await call(c, "open", "x", t.name);
  for (let i = 0; i < 10; i++) {
    const writer = [a, b, c][i % 3];
    const entries = Array.from({ length: 10 }, (_, j) => [i * 10 + j, `v${i * 10 + j}`]);
    await call(writer, "put", "x", "s", entries);
    for (const reader of [a, b, c]) assertEq(await call(reader, "count", "x", "s"), (i + 1) * 10, `count after write ${i}`);
  }
  const all = await call(c, "getAll", "x", "s");
  assertEq(all, Array.from({ length: 100 }, (_, k) => [k, `v${k}`]), "every row, read in another tab");
});

test("readwrite transactions in different tabs never interleave", async (t) => {
  const [a, b, c] = await t.pages(3);
  await call(a, "open", "x", t.name, 1, { stores: ["s"] });
  await call(b, "open", "x", t.name);
  await call(c, "open", "x", t.name);
  await Promise.all([a, b, c].map((p) => call(p, "increment", "x", "s", "n", 100)));
  assertEq(await call(b, "getAll", "x", "s"), [["n", 300]], "300 read-modify-write increments from three tabs");
});

test("versionchange fires in every other tab, and blocked until the last connection closes", async (t) => {
  const [a, b, c] = await t.pages(3);
  await call(a, "open", "x", t.name, 1, { stores: ["s"] });
  await call(b, "open", "x", t.name, undefined, { stay: true });
  const upgraded = call(c, "open", "x", t.name, 2, { stores: ["s", "t"] });
  await until("blocked in the upgrading tab", async () => has(await logOf(c), "x blocked 1->2"));
  assert(has(await logOf(a), "x versionchange 1->2"), "versionchange in the first tab");
  assert(has(await logOf(b), "x versionchange 1->2"), "versionchange in the tab that stays open");
  await sleep(100);
  assert(!(await logOf(c)).some((l) => l.includes("upgradeneeded")), "no upgrade while a connection is open");
  await call(b, "close", "x");
  assertEq(await upgraded, { version: 2, stores: ["s", "t"] }, "the upgrade runs once the last connection closed");
  assertEq(await logOf(c), ["x blocked 1->2", "x upgradeneeded 1->2", "x opened v2"], "events in the upgrading tab");
});

test("no blocked event when every other tab closes on versionchange", async (t) => {
  const [a, b, c] = await t.pages(3);
  await call(b, "open", "x", t.name, 1, { stores: ["s"] });
  await call(c, "open", "x", t.name);
  await call(a, "open", "x2", t.name, 2, { stores: ["s", "t"] });
  assertEq(await logOf(a), ["x2 upgradeneeded 1->2", "x2 opened v2"], "events in the upgrading tab");
  for (const p of [b, c]) assert(has(await logOf(p), "x versionchange 1->2"), "versionchange in each other tab");
});

test("deleteDatabase in one tab fires versionchange to null in the others and waits for them", async (t) => {
  const [a, b, c] = await t.pages(3);
  await call(a, "open", "x", t.name, 1, { stores: ["s"] });
  await call(a, "put", "x", "s", [[1, "one"]]);
  await call(c, "open", "x", t.name, undefined, { stay: true });
  const deleted = call(b, "deleteDatabase", "d", t.name);
  await until("blocked in the deleting tab", async () => has(await logOf(b), "d blocked 1->null"));
  assert(has(await logOf(a), "x versionchange 1->null"), "versionchange to null in the first tab");
  assert(has(await logOf(c), "x versionchange 1->null"), "versionchange to null in the tab that stays open");
  await call(c, "close", "x");
  await deleted;
  await call(a, "open", "y", t.name, 1, { stores: ["s"] });
  assert(has(await logOf(a), "y upgradeneeded 0->1"), "the database is new after the delete");
  assertEq(await call(a, "count", "y", "s"), 0, "no rows after the delete");
});

test("an open in one tab waits for another tab's upgrade to finish", async (t) => {
  const [a, b] = await t.pages(2);
  const upgraded = call(a, "open", "x", t.name, 2, { stores: ["s", "t"], slowUpgradeMs: 400 });
  await until("the upgrade to start", async () => has(await logOf(a), "x upgradeneeded 0->2"));
  const opened = await call(b, "open", "y", t.name);
  assertEq(opened, { version: 2, stores: ["s", "t"] }, "the later open sees the upgraded database");
  await upgraded;
});

test("a tab closed with a connection open does not block a later upgrade", async (t) => {
  const [a, b] = await t.pages(2);
  await call(a, "open", "x", t.name, 1, { stores: ["s"] });
  await call(b, "open", "x", t.name, undefined, { stay: true });
  await b.close();
  assertEq(await call(a, "open", "x2", t.name, 2, { stores: ["s", "t"] }), { version: 2, stores: ["s", "t"] }, "the upgrade runs");
});

test("a tab closed during a readwrite transaction holds no other tab, and its writes roll back", async (t) => {
  const [a, b] = await t.pages(2);
  await call(a, "open", "x", t.name, 1, { stores: ["s"] });
  await call(a, "put", "x", "s", [["before", 1]]);
  await call(b, "open", "x", t.name);
  await call(b, "holdTransaction", "x", "s", "held");
  await b.close();
  await call(a, "put", "x", "s", [["after", 2]]);
  assertEq(await call(a, "getAll", "x", "s"), [["after", 2], ["before", 1]], "the closed tab's put is gone, the later one is in");
});

// plateau only: the leader tab runs the worker.

async function leaderOf(pages: Page[]): Promise<Page> {
  let leader: Page | undefined;
  await until("one leader", async () => {
    const roles = await Promise.all(pages.map(role));
    leader = pages[roles.indexOf("leader")];
    return roles.filter((r) => r === "leader").length === 1 && roles.every((r) => r === "leader" || r === "follower");
  });
  return leader!;
}

/** Writers in every page; the leader is closed (or crashed) mid-stream; the rest go on. Every write
 * that committed must be readable afterwards, in every remaining tab and in a new one. */
async function failover(t: Ctx, n: number, rounds: number, kill: (p: Page) => Promise<void>): Promise<void> {
  let pages = await t.pages(n);
  await call(pages[0], "open", "x", t.name, 1, { stores: ["s"] });
  for (const p of pages.slice(1)) await call(p, "open", "x", t.name);
  const prefixes = new Map(pages.map((p, i) => [p, `w${i}`]));
  for (const p of pages) await call(p, "startWriter", "x", "s", prefixes.get(p));
  const committed = new Map<string, number[]>();
  const failovers: number[] = [];
  let aborted = 0;
  for (let r = 0; r < rounds; r++) {
    await sleep(300);
    const leader = await leaderOf(pages);
    // What the leader committed so far, while it keeps writing; what it commits after this and
    // before it dies is not checked.
    committed.set(prefixes.get(leader)!, await call(leader, "writerCommitted", prefixes.get(leader)));
    pages = pages.filter((p) => p !== leader);
    const killedAt = Date.now();
    await kill(leader);
    await leaderOf(pages);
    failovers.push(Date.now() - killedAt);
  }
  await sleep(300);
  for (const p of pages) {
    const after = await call(p, "writerState", prefixes.get(p));
    assert(after.committed > 0, "writers commit after the failover");
  }
  for (const p of pages) {
    const out = await call<{ committed: number[]; aborted: { i: number; error: string }[] }>(p, "stopWriter", prefixes.get(p));
    committed.set(prefixes.get(p)!, out.committed);
    aborted += out.aborted.length;
    for (const a of out.aborted) assert(a.error === "UnknownError", `a transaction cut by the failover aborts with UnknownError (got ${a.error})`);
  }
  const [fresh] = await t.pages(1);
  await call(fresh, "open", "x", t.name);
  for (const reader of [...pages, fresh]) {
    const keys = new Set((await call<[string, unknown][]>(reader, "getAll", "x", "s")).map(([k]) => k));
    for (const [prefix, list] of committed) {
      const missing = list.filter((i) => !keys.has(`${prefix}-${i}`));
      assert(!missing.length, `${missing.length} committed writes of ${prefix} missing, first ${prefix}-${missing[0]}`);
    }
  }
  t.note.committed = [...committed.values()].reduce((a, l) => a + l.length, 0);
  t.note.abortedByFailover = aborted;
  t.note.failoverMs = failovers;
}

plateauTest("the leader tab closes mid-session: another tab takes over and no committed write is lost", (t) =>
  failover(t, 3, 1, (p) => p.close()),
);

plateauTest("leaders close one after another until one tab is left: no committed write is lost", (t) =>
  failover(t, 4, 3, (p) => p.close({ runBeforeUnload: false })),
);

plateauTest("the leader tab crashes mid-session (Chromium, renderer killed): no committed write is lost", async (t) => {
  if (t.browser !== "chromium") {
    t.note.skipped = "Page.crash is a Chromium DevTools command";
    return;
  }
  await failover(t, 3, 1, async (p) => {
    const cdp = await t.ctx.newCDPSession(p);
    const crashed = p.waitForEvent("crash");
    // The command never answers: the page it would answer from is gone.
    void cdp.send("Page.crash").catch(() => {});
    await crashed;
  });
});

plateauTest("whenLeader resolves in the leader at once and in a follower only once it takes over", async (t) => {
  const pages = await t.pages(2);
  for (const p of pages) await call(p, "waitLeader");
  const leader = await leaderOf(pages);
  const follower = pages.find((p) => p !== leader)!;
  await until("the leader's whenLeader to resolve", () => call(leader, "led"));
  await sleep(100);
  assert(!(await call(follower, "led")), "the follower's whenLeader resolved while another tab leads");
  await leader.close({ runBeforeUnload: false });
  await until("the follower's whenLeader to resolve after the failover", () => call(follower, "led"));
});

plateauTest("a tab opened after a failover joins the new leader", async (t) => {
  const pages = await t.pages(2);
  await call(pages[0], "open", "x", t.name, 1, { stores: ["s"] });
  await call(pages[0], "put", "x", "s", [["k", 1]]);
  const leader = await leaderOf(pages);
  await leader.close();
  const rest = pages.filter((p) => p !== leader);
  await leaderOf(rest);
  const [late] = await t.pages(1);
  assertEq(await role(late), "follower", "the new tab follows");
  await call(late, "open", "x", t.name);
  await call(late, "put", "x", "s", [["late", 2]]);
  await call(rest[0], "open", "x", t.name);
  assertEq(await call(rest[0], "getAll", "x", "s"), [["k", 1], ["late", 2]], "the new leader reads the late tab's write");
});

plateauTest("a commit in one tab calls the observers of its stores in every tab, and their reads see it", async (t) => {
  const [a, b, c] = await t.pages(3);
  await call(a, "open", "x", t.name, 1, { stores: ["s", "t"] });
  await call(b, "open", "x", t.name);
  await call(c, "open", "x", t.name);
  for (const p of [a, b, c]) await call(p, "observe", "x", "s");
  await call(c, "put", "x", "t", [[1, "not observed"]]);
  await call(b, "put", "x", "s", [[1, "a"], [2, "b"], [3, "c"]]);
  for (const p of [a, b, c]) await until("the observer's call", async () => has(await logOf(p), "x change s count 3"));
  for (const p of [a, b, c]) assertEq((await logOf(p)).filter((l) => l.includes("change")), ["x change s count 3"], "one call, for the observed store only");
});

plateauTest("latency of a get and of a put commit, from the leader tab and from a follower", async (t) => {
  const pages = await t.pages(2);
  await call(pages[0], "open", "x", t.name, 1, { stores: ["s"] });
  await call(pages[0], "put", "x", "s", Array.from({ length: 100 }, (_, i) => [i, { i }]));
  await call(pages[1], "open", "x", t.name);
  const leader = await leaderOf(pages);
  const follower = pages.find((p) => p !== leader)!;
  t.note.leader = await call(leader, "latency", "x", "s", 300);
  t.note.follower = await call(follower, "latency", "x", "s", 300);
});

// Runner.

const server = await createServer({ configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)), server: { port: 0, host: "127.0.0.1" } });
await server.listen();
const url = `${server.resolvedUrls!.local[0]}multitab.html`;

const report: Record<string, Record<string, Result[]>> = {};
let bad = false;
const stamp = Date.now().toString(36);
let counter = 0;
for (const b of browsers) {
  report[b] = {};
  for (const impl of ["native", "plateau"] as Impl[]) {
    const results: Result[] = [];
    const profile = await mkdtemp(join(tmpdir(), "plateau-multitab-"));
    const ctx = await types[b].launchPersistentContext(profile, { headless: true });
    const errors: string[] = [];
    for (const { name, scope, body } of tests) {
      if (filter && !name.includes(filter)) continue;
      if (scope === "plateau" && impl !== "plateau") continue;
      const opened: Page[] = [];
      const t: Ctx = {
        browser: b,
        impl,
        ctx,
        name: `tabs-${stamp}-${++counter}`,
        note: {},
        async pages(n) {
          const out: Page[] = [];
          for (let i = 0; i < n; i++) {
            const p = await ctx.newPage();
            p.on("pageerror", (e) => errors.push(e.message));
            await p.goto(`${url}?impl=${impl}`);
            await p.waitForFunction(() => document.getElementById("status")?.textContent === "ready");
            if (impl === "plateau") await p.waitForFunction(() => window.tab.role() !== "pending");
            out.push(p);
            opened.push(p);
          }
          return out;
        },
      };
      const start = performance.now();
      let status: Result["status"] = "pass";
      let message: string | undefined;
      try {
        await Promise.race([body(t), sleep(30_000).then(() => Promise.reject(new AssertionError("timed out after 30 s")))]);
      } catch (e) {
        status = "fail";
        message = e instanceof Error ? e.message : String(e);
      }
      for (const p of opened) await p.close().catch(() => {});
      results.push({ name, scope, status, message, note: Object.keys(t.note).length ? t.note : undefined, ms: Math.round(performance.now() - start) });
    }
    await ctx.close();
    await rm(profile, { recursive: true, force: true });
    report[b][impl] = results;
    const shared = results.filter((r) => r.scope === "shared");
    const own = results.filter((r) => r.scope === "plateau");
    const pass = (rs: Result[]) => rs.filter((r) => r.status === "pass").length;
    console.log(`[${b}] ${impl.padEnd(7)} ${pass(shared)}/${shared.length} pass${own.length ? `; plateau-only tests ${pass(own)}/${own.length} pass` : ""}`);
    for (const r of results) {
      if (r.status !== "pass") console.log(`    FAIL ${r.name}: ${r.message}`);
      if (r.note) console.log(`    ${r.name}: ${JSON.stringify(r.note)}`);
    }
    if (errors.length && process.env.VERBOSE) console.log(`    page errors:\n      ${errors.join("\n      ")}`);
  }
  const native = new Map((report[b].native ?? []).map((r) => [r.name, r.status]));
  for (const r of report[b].plateau ?? []) {
    if (r.status !== "pass") bad = true;
    if (r.scope === "shared" && native.get(r.name) !== r.status) {
      console.log(`[${b}] DIFFERS: ${r.name}: native ${native.get(r.name)}, plateau ${r.status}`);
      bad = true;
    }
  }
}
if (jsonOut) await writeFile(jsonOut, JSON.stringify(report, null, 2));
await server.close();
process.exit(bad ? 1 : 0);
