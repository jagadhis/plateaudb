// The plateau engine in a dedicated worker. The database file lives in OPFS and is read through a
// FileSystemSyncAccessHandle straight into WASM memory: opening reads the header slots and the
// manifest, and each query reads the blocks it touches. Results cross back to the main thread as
// plain objects, like the other worker engine.
//
// The worker is the runtime and lives as long as the page: the main thread compiles the WASM and
// posts the Module (`init`); `close` frees the database and its file handle, not the instance.

import { Db, initSync, memoryBudget, setMemoryBudget } from "plateau-engine";
import { issues, PLATEAU_COMMIT_ROWS, replacementFor, updateBatches, type Query, q1Query, q2Query, q3Query, q4Query, type Issue, type Q1, type Q2, type Q3, type Q4 } from "../workload";
import { serve, WithPlan } from "./rpc";

interface SyncAccessHandle {
  read(buf: Uint8Array, o?: { at: number }): number;
  write(buf: Uint8Array, o?: { at: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

/** The memory budget the API's runtime defaults to: 64 MiB, or 24 MiB where navigator.deviceMemory
 * is 4 or less. */
function defaultBudget(): number {
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return mem !== undefined && mem <= 4 ? 24 << 20 : 64 << 20;
}

/** Applies a budget variant's budget (`undefined` keeps the default; `null` is no limit). */
function useBudget(bytes: number | null | undefined): void {
  if (bytes !== undefined) setMemoryBudget(bytes ?? Infinity);
}

/** When this script started running, in the worker's clock. */
const evaluatedAt = performance.now();

const FILE = "plateau-bench.db";
const SCHEMA = JSON.stringify({
  primaryKey: "id",
  columns: [
    { name: "id", kind: "f64" },
    { name: "teamId", kind: "u32", index: "bitmap" },
    { name: "stateId", kind: "u32", index: "bitmap" },
    { name: "assigneeId", kind: "u32", index: "bitmap" },
    { name: "labelIds", kind: "u32_multi", index: "bitmap" },
    { name: "priority", kind: "u32", index: "bitmap" },
    { name: "createdAt", kind: "f64" },
    { name: "updatedAt", kind: "f64", index: "ordered", group: "teamId" },
    { name: "title", kind: "str" },
  ],
});

let db: Db | null = null;
let access: SyncAccessHandle | null = null;
let memory: WebAssembly.Memory | null = null;
/** Resolves once `init` has instantiated the WASM; `open` and `create` may arrive before it. */
let markReady = () => {};
const wasmReady = new Promise<void>((resolve) => (markReady = resolve));
const encoder = new TextEncoder();

/** Reads through the handle since it was opened: count and time, for `details`. */
const reads = { count: 0, ms: 0 };

/** The engine's storage: each call wraps the Rust buffer (pointer, length) in a fresh view, since
 * a memory.grow detaches the previous `memory.buffer`. */
const storage = {
  read: (ptr: number, len: number, at: number) => {
    const t = performance.now();
    const n = access!.read(new Uint8Array(memory!.buffer, ptr, len), { at });
    reads.ms += performance.now() - t;
    reads.count++;
    return n;
  },
  write: (ptr: number, len: number, at: number) => access!.write(new Uint8Array(memory!.buffer, ptr, len), { at }),
  size: () => access!.getSize(),
  truncate: (size: number) => access!.truncate(size),
  flush: () => access!.flush(),
};

/** The database file's handle, looked up on first open and kept. */
let fileHandle: Promise<FileSystemFileHandle> | null = null;

/** Takes the file's sync access handle: the exclusive lock a database holds while it is open. */
async function lock(parts: Record<string, number>): Promise<void> {
  const t = performance.now();
  fileHandle ??= navigator.storage.getDirectory().then((root) => root.getFileHandle(FILE, { create: true }));
  const file = await fileHandle;
  access = await (file as unknown as { createSyncAccessHandle(): Promise<SyncAccessHandle> }).createSyncAccessHandle();
  parts.openSyncHandle = performance.now() - t;
  reads.count = 0;
  reads.ms = 0;
}

function info(): Record<string, unknown> {
  return {
    storage:
      "one OPFS file via FileSystemSyncAccessHandle: two header slots, immutable segments (column chunks, indexes in checksummed blocks, row records), a manifest; read lazily into WASM memory, every section and block checksummed",
    indexes: ["primary key: sorted keys and row ids in chunks", "roaring bitmaps: teamId, stateId, assigneeId, labelIds, priority", "ordered: updatedAt, grouped by teamId"],
    resultTransport: "engine returns JSON; worker parses and posts objects (structured clone)",
  };
}

interface Columns {
  n: number;
  id: Float64Array;
  team: Uint32Array;
  state: Uint32Array;
  assignee: Uint32Array;
  priority: Uint32Array;
  created: Float64Array;
  updated: Float64Array;
  labelOffsets: Uint32Array;
  labels: Uint32Array;
  titleOffsets: Uint32Array;
  titles: Uint8Array;
}

let titleBuf = new Uint8Array(1 << 16);

/** Rows as the engine's column arrays. */
function toColumns(rows: Issue[]): Columns {
  const n = rows.length;
  const id = new Float64Array(n);
  const team = new Uint32Array(n);
  const state = new Uint32Array(n);
  const assignee = new Uint32Array(n);
  const priority = new Uint32Array(n);
  const created = new Float64Array(n);
  const updated = new Float64Array(n);
  const labelOffsets = new Uint32Array(n + 1);
  const titleOffsets = new Uint32Array(n + 1);
  let labelCount = 0;
  for (const r of rows) labelCount += r.labelIds.length;
  const labels = new Uint32Array(labelCount);
  let li = 0;
  let ti = 0;
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    id[i] = r.id;
    team[i] = r.teamId;
    state[i] = r.stateId;
    assignee[i] = r.assigneeId;
    priority[i] = r.priority;
    created[i] = r.createdAt;
    updated[i] = r.updatedAt;
    for (const l of r.labelIds) labels[li++] = l;
    labelOffsets[i + 1] = li;
    if (titleBuf.length - ti < r.title.length * 3) {
      const grown = new Uint8Array(titleBuf.length * 2 + r.title.length * 3);
      grown.set(titleBuf.subarray(0, ti));
      titleBuf = grown;
    }
    ti += encoder.encodeInto(r.title, titleBuf.subarray(ti)).written;
    titleOffsets[i + 1] = ti;
  }
  return { n, id, team, state, assignee, priority, created, updated, labelOffsets, labels, titleOffsets, titles: titleBuf.slice(0, ti) };
}

/** Starts a batch holding `c`; the caller commits it as an append or a put. */
function setBatch(c: Columns): void {
  db!.beginBatch(c.n);
  db!.setF64("id", c.id);
  db!.setU32("teamId", c.team);
  db!.setU32("stateId", c.state);
  db!.setU32("assigneeId", c.assignee);
  db!.setMulti("labelIds", c.labelOffsets, c.labels);
  db!.setU32("priority", c.priority);
  db!.setF64("createdAt", c.created);
  db!.setF64("updatedAt", c.updated);
  db!.setStr("title", c.titleOffsets, c.titles);
}

/** The prepared update batch. */
let pending: { cols: Columns; remove: Float64Array } | null = null;

/** Split of the last query's worker time: the WASM call (engine plus result JSON) and JSON.parse. */
export const lastSplit = { engineMs: 0, parseMs: 0 };

function q(json: Query): { plan: string; rows?: Issue[]; count?: number } {
  const t0 = performance.now();
  const out = db!.query(JSON.stringify(json));
  const t1 = performance.now();
  const parsed = JSON.parse(out);
  lastSplit.engineMs = t1 - t0;
  lastSplit.parseMs = performance.now() - t1;
  return parsed;
}

serve({
  init(module: WebAssembly.Module) {
    const t = performance.now();
    memory = initSync({ module }).memory;
    setMemoryBudget(defaultBudget());
    markReady();
    // Absolute times (ms since the epoch), so the page can place the worker's start-up on its clock.
    const at = (ms: number) => performance.timeOrigin + ms;
    return { wasmInstantiate: performance.now() - t, workerCreatedAt: at(0), workerEvaluatedAt: at(evaluatedAt), initReceivedAt: at(t) };
  },

  async create(budget?: number | null) {
    const t = performance.now();
    const parts: Record<string, number> = {};
    await Promise.all([lock(parts), wasmReady]);
    useBudget(budget);
    db = Db.create(storage, SCHEMA);
    return { totalMs: performance.now() - t, parts, info: info() };
  },

  async open(budget?: number | null) {
    const t = performance.now();
    const parts: Record<string, number> = {};
    // The file lock does not need the WASM: take it while the Module is still on its way.
    await Promise.all([lock(parts), wasmReady.then(() => (parts.waitWasm = performance.now() - t))]);
    useBudget(budget);
    const t1 = performance.now();
    db = Db.open(storage);
    parts.openDb = performance.now() - t1;
    return { totalMs: performance.now() - t, parts, info: info() };
  },

  close() {
    db?.free();
    db = null;
    access?.close();
    access = null;
    return null;
  },

  /** Appends chunk by chunk, saves every `PLATEAU_COMMIT_ROWS` rows, then compacts: the table
   * ends as one segment, while the unsaved rows never exceed one commit's. */
  load(seed: number, size: number, chunk: number) {
    const parts = { toColumns: 0, append: 0, save: 0, compact: 0 };
    let unsaved = 0;
    for (let start = 0; start < size; start += chunk) {
      const rows = issues(seed, start, Math.min(chunk, size - start));
      let t = performance.now();
      const cols = toColumns(rows);
      parts.toColumns += performance.now() - t;
      t = performance.now();
      setBatch(cols);
      db!.commitBatch();
      parts.append += performance.now() - t;
      unsaved += rows.length;
      if (unsaved >= PLATEAU_COMMIT_ROWS || start + chunk >= size) {
        t = performance.now();
        db!.save();
        parts.save += performance.now() - t;
        unsaved = 0;
      }
    }
    const t = performance.now();
    db!.compact();
    parts.compact = performance.now() - t;
    const totalMs = Object.values(parts).reduce((a, b) => a + b, 0);
    return { totalMs, parts };
  },

  prepareUpdate(seed: number, size: number, batch: number) {
    const b = updateBatches(seed, size)[batch];
    pending = { cols: toColumns(b.replace.map((id) => replacementFor(seed, id))), remove: Float64Array.from(b.remove) };
    return null;
  },

  /** put of the replaced rows (one batch), delete of the ids, then save. */
  applyUpdate() {
    const b = pending;
    if (!b) throw new Error("plateau: no update prepared");
    pending = null;
    let t = performance.now();
    setBatch(b.cols);
    db!.putBatch();
    const put = performance.now() - t;
    t = performance.now();
    db!.delete(b.remove);
    const del = performance.now() - t;
    t = performance.now();
    db!.save();
    const save = performance.now() - t;
    return { totalMs: put + del + save, parts: { put, delete: del, save } };
  },

  compact() {
    const t = performance.now();
    db!.compact();
    const ms = performance.now() - t;
    return { totalMs: ms, parts: { compact: ms } };
  },

  getMany(ids: number[]) {
    return JSON.parse(db!.getMany(Float64Array.from(ids)));
  },

  q1(p: Q1) {
    const r = q(q1Query(p));
    return new WithPlan(r.rows, `${r.plan} | engine ${lastSplit.engineMs.toFixed(3)} ms, parse ${lastSplit.parseMs.toFixed(3)} ms`);
  },

  q2(p: Q2) {
    const r = q(q2Query(p));
    return new WithPlan(r.rows, `${r.plan} | engine ${lastSplit.engineMs.toFixed(3)} ms, parse ${lastSplit.parseMs.toFixed(3)} ms`);
  },

  q3(p: Q3) {
    const r = q(q3Query(p));
    return new WithPlan(r.count, `${r.plan} | engine ${lastSplit.engineMs.toFixed(3)} ms, parse ${lastSplit.parseMs.toFixed(3)} ms`);
  },

  q4(p: Q4) {
    const r = q(q4Query(p));
    return new WithPlan(r.rows, `${r.plan} | engine ${lastSplit.engineMs.toFixed(3)} ms, parse ${lastSplit.parseMs.toFixed(3)} ms`);
  },

  details() {
    return {
      fileBytes: access?.getSize() ?? null,
      wasmMemoryBytes: memory?.buffer.byteLength ?? null,
      budgetBytes: memoryBudget(),
      rows: db?.len() ?? null,
      ...(db ? JSON.parse(db.details()) : {}),
      storageReads: reads.count,
      storageReadMs: Math.round(reads.ms * 1000) / 1000,
      lastQueryEngineMs: Math.round(lastSplit.engineMs * 1000) / 1000,
    };
  },
});
