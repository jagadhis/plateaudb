// One tab of the multi-tab tests: `?impl=native` drives the browser's IndexedDB, `?impl=plateau`
// plateau's API, `?impl=fallback` plateau's API forced onto the browser's IndexedDB. The runner (multitab.ts) opens several of these pages in one browser context and
// calls `window.tab`; every event a connection or request sees goes to `window.tab.log`.

import { plateau, runtime, startRuntime, type PlateauDatabase } from "../src/index";

const asked = new URLSearchParams(location.search).get("impl");
const impl = asked === "plateau" || asked === "fallback" ? asked : "native";
const factory: IDBFactory = impl === "native" ? indexedDB : (plateau as unknown as IDBFactory);
if (impl === "plateau") runtime();
if (impl === "fallback") startRuntime({ backend: "indexeddb" });

const log: string[] = [];
let leaderWait = false;
const dbs = new Map<string, IDBDatabase>();

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.addEventListener("success", () => resolve(r.result));
    r.addEventListener("error", () => reject(r.error));
  });

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("abort", () => reject(tx.error ?? new DOMException("aborted", "AbortError")));
  });

const db = (h: string) => {
  const d = dbs.get(h);
  if (!d) throw new Error(`no connection ${h}`);
  return d;
};

interface Writer {
  stop: boolean;
  committed: number[];
  aborted: { i: number; error: string }[];
  finished: Promise<void>;
}
const writers = new Map<string, Writer>();

const tab = {
  impl,
  log,
  role: () => (impl === "native" ? "native" : runtime().role),
  backend: () => plateau.backend,

  /** Starts waiting on `plateau.whenLeader()`; `led()` says whether it has resolved. */
  waitLeader() {
    leaderWait = false;
    void plateau.whenLeader().then(() => (leaderWait = true));
  },
  led: () => leaderWait,

  /** Opens connection `h`. In upgradeneeded it creates `stores`, and with `slowUpgradeMs` keeps the
   * upgrade running that long. On versionchange the connection closes unless `stay`. */
  async open(h: string, name: string, version?: number, o: { stores?: string[]; stay?: boolean; slowUpgradeMs?: number } = {}) {
    const r = version === undefined ? factory.open(name) : factory.open(name, version);
    r.onblocked = (e) => log.push(`${h} blocked ${e.oldVersion}->${e.newVersion}`);
    r.onupgradeneeded = (e) => {
      log.push(`${h} upgradeneeded ${e.oldVersion}->${e.newVersion}`);
      const d = r.result;
      for (const s of o.stores ?? []) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
      if (o.slowUpgradeMs && o.stores?.length) {
        const store = r.transaction!.objectStore(o.stores[0]);
        const until = performance.now() + o.slowUpgradeMs;
        const step = () => {
          if (performance.now() < until) store.get(0).onsuccess = step;
        };
        step();
      }
    };
    const d = await req(r);
    log.push(`${h} opened v${d.version}`);
    d.onversionchange = (e) => {
      log.push(`${h} versionchange ${e.oldVersion}->${e.newVersion}`);
      if (!o.stay) {
        d.close();
        log.push(`${h} closed`);
      }
    };
    dbs.set(h, d);
    return { version: d.version, stores: [...d.objectStoreNames].sort() };
  },

  close(h: string) {
    db(h).close();
    dbs.delete(h);
    log.push(`${h} closed`);
  },

  async deleteDatabase(h: string, name: string) {
    const r = factory.deleteDatabase(name);
    r.onblocked = (e) => log.push(`${h} blocked ${e.oldVersion}->${e.newVersion}`);
    await req(r);
    log.push(`${h} deleted`);
  },

  async put(h: string, store: string, entries: [IDBValidKey, unknown][]) {
    const tx = db(h).transaction(store, "readwrite");
    const s = tx.objectStore(store);
    for (const [k, v] of entries) s.put(v, k);
    await done(tx);
  },

  async getAll(h: string, store: string): Promise<[IDBValidKey, unknown][]> {
    const tx = db(h).transaction(store, "readonly");
    const s = tx.objectStore(store);
    const [keys, values] = await Promise.all([req(s.getAllKeys()), req(s.getAll())]);
    return keys.map((k, i) => [k, values[i]]);
  },

  async count(h: string, store: string): Promise<number> {
    return req(db(h).transaction(store, "readonly").objectStore(store).count());
  },

  /** plateau only: logs each commit another tab (or this one) makes to `store`, with the count a
   * read started in the callback sees. */
  observe(h: string, store: string) {
    const d = db(h) as unknown as PlateauDatabase;
    d.observe(store, (e) => {
      void req(db(h).transaction(store, "readonly").objectStore(store).count()).then((n) => log.push(`${h} change ${e.stores.join(",")} count ${n}`));
    });
  },

  /** Mean ms of `n` one-get readonly transactions run one after another, then of `n` one-put
   * readwrite transactions to their complete event (a mean: the page's clock is coarse). */
  async latency(h: string, store: string, n: number) {
    let t0 = performance.now();
    for (let i = 0; i < n; i++) await req(db(h).transaction(store, "readonly").objectStore(store).get(i % 100));
    const get = (performance.now() - t0) / n;
    t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const tx = db(h).transaction(store, "readwrite");
      tx.objectStore(store).put(i, `p${i % 100}`);
      await done(tx);
    }
    const putCommit = (performance.now() - t0) / n;
    return { getMs: +get.toFixed(3), putCommitMs: +putCommit.toFixed(3) };
  },

  /** `times` read-modify-write transactions on `key`, one after another. */
  async increment(h: string, store: string, key: IDBValidKey, times: number) {
    for (let i = 0; i < times; i++) {
      const tx = db(h).transaction(store, "readwrite");
      const s = tx.objectStore(store);
      s.get(key).onsuccess = (e) => {
        s.put(((e.target as IDBRequest).result ?? 0) + 1, key);
      };
      await done(tx);
    }
  },

  /** Puts `${prefix}-${i}` for i = 0, 1, ... one transaction each, until stopped; records which
   * committed (their complete event fired) and which aborted. */
  startWriter(h: string, store: string, prefix: string) {
    const w: Writer = { stop: false, committed: [], aborted: [], finished: Promise.resolve() };
    w.finished = (async () => {
      for (let i = 0; !w.stop; i++) {
        try {
          const tx = db(h).transaction(store, "readwrite");
          tx.objectStore(store).put({ i, at: Date.now() }, `${prefix}-${i}`);
          await done(tx);
          w.committed.push(i);
        } catch (e) {
          w.aborted.push({ i, error: (e as Error)?.name ?? String(e) });
        }
      }
    })();
    writers.set(prefix, w);
  },

  writerCommitted(prefix: string) {
    return writers.get(prefix)!.committed.slice();
  },

  writerState(prefix: string) {
    const w = writers.get(prefix)!;
    return { committed: w.committed.length, aborted: w.aborted.length };
  },

  async stopWriter(prefix: string) {
    const w = writers.get(prefix)!;
    w.stop = true;
    await w.finished;
    return { committed: w.committed, aborted: w.aborted };
  },

  /** Starts a readwrite transaction that puts `key` and then stays alive (chained gets) until the
   * page closes. */
  holdTransaction(h: string, store: string, key: IDBValidKey) {
    const tx = db(h).transaction(store, "readwrite");
    const s = tx.objectStore(store);
    s.put("uncommitted", key);
    const step = () => {
      s.get(key).onsuccess = step;
    };
    step();
    return new Promise<void>((r) => setTimeout(r, 50));
  },
};

declare global {
  interface Window {
    tab: typeof tab;
  }
}
window.tab = tab;
document.getElementById("status")!.textContent = "ready";
