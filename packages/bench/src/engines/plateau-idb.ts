// plateau through its IndexedDB-compatible API (plateaudb): the same calls an app makes
// on IndexedDB (open with an upgrade, readwrite transactions of put and delete, a get per id), with
// the store's fields declared as typed columns, and Q1-Q4 through the API's `store.query`, which
// runs the engine's planner. The engine runs in the package's worker; this file runs on the main
// thread, where the app's code runs, so every call is timed with the API's own work included.

import type { IdbSource } from "./idb";
import { plateau, PlateauKeyRange, startRuntime, type PlateauDatabase, type PlateauRequest, type PlateauTransaction } from "plateaudb";
import { take } from "../boot";
import type { Engine, Timed } from "../types";
import { issues, PLATEAU_COMMIT_ROWS, q1Query, q2Query, q3Query, q4Query, replacementFor, updateBatches, type Issue, type Q1, type Q2, type Q3, type Q4, type Query } from "../workload";

const DB = "plateau-idb-bench";
const STORE = "issues";

/** The fields every issue has, as typed columns with the engine's indexes (the same as the
 * engine-direct plateau schema). */
const COLUMNS = {
  id: { kind: "f64" },
  teamId: { kind: "u32", index: "bitmap" },
  stateId: { kind: "u32", index: "bitmap" },
  assigneeId: { kind: "u32", index: "bitmap" },
  labelIds: { kind: "u32_multi", index: "bitmap" },
  priority: { kind: "u32", index: "bitmap" },
  createdAt: { kind: "f64" },
  updatedAt: { kind: "f64", index: "ordered", group: "teamId" },
  title: { kind: "str" },
};

function req<T>(r: PlateauRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result as T);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: PlateauTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

/** Starts the API's runtime (worker and WASM), attaching to the head bootstrap's if this page has
 * one; an app does this by importing the library. */
export function startPlateauIdb(engine: "plateau-idb" | "plateau-idb-generic" = "plateau-idb"): void {
  const boot = take(engine, "worker");
  startRuntime(boot ? { worker: boot.value } : undefined);
}

/** Applies a budget variant's memory budget to the API's runtime (`undefined` keeps the default). */
async function useBudget(bytes: number | null | undefined): Promise<void> {
  if (bytes !== undefined) await plateau.setMemoryBudget(bytes);
}

/** Memory and file facts through the API's own `memoryStats`. */
async function memoryDetails(db: string): Promise<Record<string, unknown>> {
  const m = await plateau.memoryStats(db);
  return { wasmMemoryBytes: m.wasmMemoryBytes, fileBytes: m.fileBytes ?? null, usedBytes: m.usedBytes ?? null, cachedBytes: m.cachedBytes, budgetBytes: m.budgetBytes, files: m.files };
}

/** The native IndexedDB engine's code on plateau's API, with a generic store. Its load is that
 * code's: a readwrite transaction per 10,000-row chunk. */
export function genericSource(budget?: number | null): IdbSource {
  const db = "plateau-idb-generic-bench";
  return {
    name: "plateau-idb-generic",
    factory: plateau as unknown as IDBFactory,
    KeyRange: PlateauKeyRange as unknown as typeof IDBKeyRange,
    db,
    start: async () => {
      startPlateauIdb("plateau-idb-generic");
      await useBudget(budget);
    },
    compact: (handle) => (handle as unknown as PlateauDatabase).compact(),
    details: () => memoryDetails(db),
  };
}

export class PlateauIdbEngine implements Engine {
  readonly name = "plateau-idb" as const;
  readonly where = "main thread" as const;
  private db: PlateauDatabase | null = null;
  private pending: { rows: Issue[]; remove: number[] } | null = null;
  lastPlan: string | undefined;

  /** `budget`: the API runtime's memory budget for this variant (`undefined` the default). */
  constructor(private readonly budget?: number | null) {}

  private get handle(): PlateauDatabase {
    if (!this.db) throw new Error("plateau-idb: not open");
    return this.db;
  }

  async create(): Promise<Timed> {
    startPlateauIdb();
    await useBudget(this.budget);
    const t = performance.now();
    await req(plateau.deleteDatabase(DB));
    const open = plateau.open(DB, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(STORE, { keyPath: "id", columns: COLUMNS } as never);
    };
    this.db = await req<PlateauDatabase>(open);
    const ms = performance.now() - t;
    return { totalMs: ms, parts: { open: ms } };
  }

  async open(): Promise<Timed> {
    startPlateauIdb();
    if (this.budget !== undefined) await useBudget(this.budget);
    const t = performance.now();
    this.db = await req<PlateauDatabase>(plateau.open(DB, 1));
    const ms = performance.now() - t;
    return { totalMs: ms, parts: { open: ms } };
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  /** A readwrite transaction per `PLATEAU_COMMIT_ROWS` rows, its puts issued a chunk at a time
   * (the next chunk once the previous chunk's last put has succeeded, which keeps the transaction
   * active), then the API's compaction: the same shape as the engine-direct load, which saves
   * every `PLATEAU_COMMIT_ROWS` rows and compacts, so both start the measured runs from one
   * segment and the comparison is the API's cost. */
  async load(seed: number, size: number, chunk: number): Promise<Timed> {
    let gen = 0;
    const t0 = performance.now();
    for (let first = 0; first < size; first += PLATEAU_COMMIT_ROWS) {
      const end = Math.min(first + PLATEAU_COMMIT_ROWS, size);
      const tx = this.handle.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const finished = done(tx);
      for (let start = first; start < end; start += chunk) {
        const g = performance.now();
        const rows = issues(seed, start, Math.min(chunk, end - start));
        gen += performance.now() - g;
        let last: PlateauRequest | null = null;
        for (const row of rows) last = store.put(row);
        if (start + chunk < end) await req(last!);
      }
      await finished;
    }
    const putAndCommit = performance.now() - t0 - gen;
    const t1 = performance.now();
    await this.handle.compact();
    const compact = performance.now() - t1;
    return { totalMs: putAndCommit + compact, parts: { putAndCommit, compact } };
  }

  /** The API's compaction (plateau's own `db.compact()`). */
  async compact(): Promise<Timed> {
    const t = performance.now();
    await this.handle.compact();
    const ms = performance.now() - t;
    return { totalMs: ms, parts: { compact: ms } };
  }

  details(): Promise<Record<string, unknown>> {
    return memoryDetails(DB);
  }

  async prepareUpdate(seed: number, size: number, batch: number): Promise<void> {
    const b = updateBatches(seed, size)[batch];
    this.pending = { rows: b.replace.map((id) => replacementFor(seed, id)), remove: b.remove };
  }

  /** One readwrite transaction: put per replaced row, delete per id, then commit. */
  async applyUpdate(): Promise<Timed> {
    const b = this.pending;
    if (!b) throw new Error("plateau-idb: no update prepared");
    this.pending = null;
    const t = performance.now();
    const tx = this.handle.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const row of b.rows) store.put(row);
    for (const id of b.remove) store.delete(id);
    await done(tx);
    const ms = performance.now() - t;
    return { totalMs: ms, parts: { putDeleteAndCommit: ms } };
  }

  async getMany(ids: number[]): Promise<(Issue | null)[]> {
    const store = this.handle.transaction(STORE, "readonly").objectStore(STORE);
    const out = await Promise.all(ids.map((id) => req<Issue | undefined>(store.get(id))));
    return out.map((r) => r ?? null);
  }

  private async query<T>(q: Query): Promise<T> {
    const store = this.handle.transaction(STORE, "readonly").objectStore(STORE);
    const r = store.query(q as never);
    const out = await req<T>(r);
    this.lastPlan = r.plan;
    return out;
  }

  q1(p: Q1): Promise<Issue[]> {
    return this.query(q1Query(p));
  }

  q2(p: Q2): Promise<Issue[]> {
    return this.query(q2Query(p));
  }

  q3(p: Q3): Promise<number> {
    return this.query(q3Query(p));
  }

  q4(p: Q4): Promise<Issue[]> {
    return this.query(q4Query(p));
  }

  info(): Record<string, unknown> {
    return {
      api: "plateaudb (IndexedDB-compatible API); engine in the package's worker",
      store: "keyPath id; declared typed columns (the engine-direct schema); the rest of each value would go to _v (empty for these rows)",
      queryPath: "store.query({where, orderBy, limit, count}) on the declared columns: the engine's planner",
      loadPath: `put per row, a readwrite transaction per ${PLATEAU_COMMIT_ROWS} rows (a chunk of puts at a time), then db.compact() (the engine-direct load's shape: save every ${PLATEAU_COMMIT_ROWS} rows, then compact)`,
      updatePath: "one readwrite transaction per batch: put per replaced row, delete per id",
      getsPath: "store.get per id in one readonly transaction",
    };
  }
}
