// Native IndexedDB on the main thread, where apps (Linear included) use it; no worker hop.
//
// Indexes a careful developer would declare for the four queries:
//   team_state_updated [teamId, stateId, updatedAt]  Q1: one reverse range per state, merged
//   assignee_priority  [assigneeId, priority]        Q2: range on priority, label filtered in JS
//   team_updated       [teamId, updatedAt]           Q3: count() over a key range
//   Q4 reuses team_state_updated with the priority bound checked per row.
// What IndexedDB cannot express, and the workaround:
//   - IN on a compound key part: one request per value, merged in JS (Q1).
//   - A multiEntry key inside a compound index: not allowed, so `labelIds` cannot join
//     [assigneeId, priority]; the label is checked per row in JS (Q2).
//   - ORDER BY + LIMIT across several ranges: each range is read in reverse and merged (Q1).
// Q1 uses `getAllRecords({ direction: "prev", count })` where the browser has it, else a cursor.

import { take } from "../boot";
import type { Engine, Timed } from "../types";
import { issues, replacementFor, updateBatches, type Issue, type Q1, type Q2, type Q3, type Q4 } from "../workload";

const DB = "plateau-bench";
const STORE = "issues";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

type IndexWithRecords = IDBIndex & {
  getAllRecords?: (o: { query?: IDBKeyRange; count?: number; direction?: IDBCursorDirection }) => IDBRequest<{ value: Issue }[]>;
};

const byUpdatedDesc = (a: Issue, b: Issue) => b.updatedAt - a.updatedAt || b.id - a.id;

/** Where an IndexedDB-shaped engine comes from: the browser's, or plateau's API on a generic store
 * (no declared columns), which runs this same code. */
export interface IdbSource {
  name: "idb" | "plateau-idb-generic";
  factory: IDBFactory;
  KeyRange: typeof IDBKeyRange;
  db: string;
  /** Called before create and open (plateau starts its runtime, or attaches to the bootstrap's,
   * and sets a budget variant's memory budget). */
  start?: () => void | Promise<void>;
  /** plateau: its own compaction of the database. */
  compact?: (db: IDBDatabase) => Promise<void>;
  /** plateau: memory and file facts. */
  details?: () => Promise<Record<string, unknown>>;
}

const NATIVE: () => IdbSource = () => ({ name: "idb", factory: indexedDB, KeyRange: IDBKeyRange, db: DB });

export class IdbEngine implements Engine {
  readonly name: "idb" | "plateau-idb-generic";
  readonly where = "main thread" as const;
  private db: IDBDatabase | null = null;
  private src: IdbSource;
  private hasRecords = false;

  /** Only where the source has one (plateau's API). */
  readonly compact?: () => Promise<Timed>;
  readonly details?: () => Promise<Record<string, unknown>>;

  constructor(src: IdbSource = NATIVE()) {
    this.src = src;
    this.name = src.name;
    const compact = src.compact;
    if (compact)
      this.compact = async () => {
        const t = performance.now();
        await compact(this.handle);
        const ms = performance.now() - t;
        return { totalMs: ms, parts: { compact: ms } };
      };
    if (src.details) this.details = src.details;
  }
  private q1Path = "";
  private pending: { rows: Issue[]; remove: number[] } | null = null;

  async create(): Promise<Timed> {
    await this.src.start?.();
    const t = performance.now();
    await req(this.src.factory.deleteDatabase(this.src.db));
    const open = this.src.factory.open(this.src.db, 1);
    open.onupgradeneeded = () => {
      const store = open.result.createObjectStore(STORE, { keyPath: "id" });
      store.createIndex("team_state_updated", ["teamId", "stateId", "updatedAt"]);
      store.createIndex("assignee_priority", ["assigneeId", "priority"]);
      store.createIndex("team_updated", ["teamId", "updatedAt"]);
    };
    this.db = await req(open);
    const ms = performance.now() - t;
    return { totalMs: ms, parts: { open: ms } };
  }

  /** Attaches to the head bootstrap's open request if this page has one, else opens. */
  async open(): Promise<Timed> {
    await this.src.start?.();
    const t = performance.now();
    const boot = this.src.name === "idb" ? take("idb", "idb") : undefined;
    const r = boot?.value ?? this.src.factory.open(this.src.db, 1);
    if (r.readyState === "done" && r.error) throw r.error;
    this.db = r.readyState === "done" ? r.result : await req(r);
    const ms = performance.now() - t;
    return { totalMs: ms, parts: boot ? { open: ms, bootstrap: 1 } : { open: ms } };
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  private get handle(): IDBDatabase {
    if (!this.db) throw new Error("idb: not open");
    return this.db;
  }

  async load(seed: number, size: number, chunk: number): Promise<Timed> {
    let ms = 0;
    for (let start = 0; start < size; start += chunk) {
      const rows = issues(seed, start, Math.min(chunk, size - start));
      const t = performance.now();
      const tx = this.handle.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const row of rows) store.put(row);
      await done(tx);
      ms += performance.now() - t;
    }
    return { totalMs: ms, parts: { putAndCommit: ms } };
  }

  async prepareUpdate(seed: number, size: number, batch: number): Promise<void> {
    const b = updateBatches(seed, size)[batch];
    this.pending = { rows: b.replace.map((id) => replacementFor(seed, id)), remove: b.remove };
  }

  /** One readwrite transaction: put per replaced row, delete per id, then commit. */
  async applyUpdate(): Promise<Timed> {
    const b = this.pending;
    if (!b) throw new Error("idb: no update prepared");
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
    const tx = this.handle.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const out = await Promise.all(ids.map((id) => req(store.get(id) as IDBRequest<Issue | undefined>)));
    return out.map((r) => r ?? null);
  }

  async q1(p: Q1): Promise<Issue[]> {
    const tx = this.handle.transaction(STORE, "readonly");
    const index = tx.objectStore(STORE).index("team_state_updated") as IndexWithRecords;
    const parts = await Promise.all(
      p.stateIds.map((s) => {
        const range = this.src.KeyRange.bound([p.teamId, s, -Infinity], [p.teamId, s, Infinity]);
        if (index.getAllRecords) {
          this.hasRecords = true;
          this.q1Path = "getAllRecords(prev) per state, merged";
          return req(index.getAllRecords({ query: range, count: p.limit, direction: "prev" })).then((rs) => rs.map((r) => r.value));
        }
        this.q1Path = "cursor(prev) per state, merged";
        return new Promise<Issue[]>((resolve, reject) => {
          const rows: Issue[] = [];
          const c = index.openCursor(range, "prev");
          c.onerror = () => reject(c.error);
          c.onsuccess = () => {
            const cur = c.result;
            if (!cur || rows.length >= p.limit) return resolve(rows);
            rows.push(cur.value as Issue);
            cur.continue();
          };
        });
      }),
    );
    return parts.flat().sort(byUpdatedDesc).slice(0, p.limit);
  }

  async q2(p: Q2): Promise<Issue[]> {
    const tx = this.handle.transaction(STORE, "readonly");
    const index = tx.objectStore(STORE).index("assignee_priority");
    const rows = (await req(index.getAll(this.src.KeyRange.bound([p.assigneeId, 0], [p.assigneeId, p.maxPriority])))) as Issue[];
    return rows.filter((r) => r.labelIds.includes(p.labelId)).sort((a, b) => a.id - b.id);
  }

  async q3(p: Q3): Promise<number> {
    const tx = this.handle.transaction(STORE, "readonly");
    const index = tx.objectStore(STORE).index("team_updated");
    return req(index.count(this.src.KeyRange.bound([p.teamId, p.updatedAfter], [p.teamId, Infinity], true, false)));
  }

  /** Q1 plus a priority bound IndexedDB cannot put in the key: one reverse cursor per state, the
   * bound checked per row, each cursor stopping at `limit` passing rows, then merged. */
  async q4(p: Q4): Promise<Issue[]> {
    const tx = this.handle.transaction(STORE, "readonly");
    const index = tx.objectStore(STORE).index("team_state_updated");
    const parts = await Promise.all(
      p.stateIds.map(
        (s) =>
          new Promise<Issue[]>((resolve, reject) => {
            const rows: Issue[] = [];
            const c = index.openCursor(this.src.KeyRange.bound([p.teamId, s, -Infinity], [p.teamId, s, Infinity]), "prev");
            c.onerror = () => reject(c.error);
            c.onsuccess = () => {
              const cur = c.result;
              if (!cur) return resolve(rows);
              const row = cur.value as Issue;
              if (row.priority <= p.maxPriority) rows.push(row);
              if (rows.length >= p.limit) return resolve(rows);
              cur.continue();
            };
          }),
      ),
    );
    return parts.flat().sort(byUpdatedDesc).slice(0, p.limit);
  }

  info(): Record<string, unknown> {
    return {
      indexes: ["team_state_updated [teamId, stateId, updatedAt]", "assignee_priority [assigneeId, priority]", "team_updated [teamId, updatedAt]"],
      q1Path: this.q1Path,
      q2Path: "getAll on assignee_priority range, label filtered in JS",
      q3Path: "count() on team_updated range",
      q4Path: "cursor(prev) per state on team_state_updated, priority checked per row, merged",
      loadPath: "put per row, one readwrite transaction per chunk, default durability",
      updatePath: "one readwrite transaction per batch: put per replaced row, delete per id, default durability",
      getAllRecords: this.hasRecords,
      ...(this.src.name === "idb" ? {} : { api: "plateaudb on a generic store (no declared columns): every index key path is an engine keys index; this engine's code is the native IndexedDB engine's" }),
    };
  }
}
