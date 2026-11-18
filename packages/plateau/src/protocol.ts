// Messages between the main-thread API and the worker that hosts the engine.

import type { KeyPath, WireRange } from "./key";

export type ColumnKind = "u32" | "u32_multi" | "f64" | "str";

/** A field the app declares on a store (plateau's `columns` option): stored as a typed engine
 * column, with the engine's bitmap or ordered index if asked. */
export interface ColumnDecl {
  name: string;
  kind: ColumnKind;
  index?: "bitmap" | "ordered";
  group?: string;
}

export interface IndexDef {
  /** Unique within the database; names the index's engine column (`_i<id>`). */
  id: number;
  name: string;
  keyPath: KeyPath;
  unique: boolean;
  multiEntry: boolean;
}

export interface StoreDef {
  /** Unique within the database for its life; names the store's file. */
  id: number;
  /** The store's engine file; a new one when an index is created or deleted on a store. */
  file: string;
  name: string;
  keyPath: KeyPath | null;
  autoIncrement: boolean;
  indexes: IndexDef[];
  /** Declared typed fields; when present the store's key path is one of them, an f64 column, and
   * the engine's primary key. */
  columns?: ColumnDecl[];
}

export interface Catalog {
  version: number;
  nextId: number;
  stores: StoreDef[];
}

export type Direction = "next" | "nextunique" | "prev" | "prevunique";

/** One operation of a transaction. Each yields one result per request it carries. */
export type Op =
  /** Point gets of a store by encoded key; one result per key. */
  | { o: "get"; s: string; ks: string[] }
  /** First record (or key) in a range, of a store or an index. */
  | { o: "first"; s: string; i?: string; r: WireRange; key: boolean }
  | { o: "all"; s: string; i?: string; r: WireRange | null; n: number; key: boolean }
  | { o: "count"; s: string; i?: string; r: WireRange | null }
  /** Puts; one result per row (its encoded key). `t` holds a typed store's declared fields in
   * column order; `v` the stored form of the rest of the value (or of the whole value). */
  | { o: "put"; s: string; rows: PutRow[] }
  /** Puts into a typed store, as columns: per declared column a Float64Array (f64), Uint32Array
   * (u32), string array (str) or [offsets, values] Uint32Arrays (u32_multi); `v` the stored rests
   * (null when all are empty); `add` the rows that must not overwrite, `gen` the rows whose key the
   * store generates. One result per row: the generated key, else nothing. */
  | { o: "tput"; s: string; n: number; cols: unknown[]; v: string[] | null; add: number[]; gen: number[] }
  | { o: "del"; s: string; r: WireRange }
  /** Deletes of single keys; one result per key. */
  | { o: "delk"; s: string; ks: string[]; nums?: number[] }
  | { o: "clear"; s: string }
  /** A cursor step; with `pre`, up to that many following entries come along (`more`). */
  | { o: "cur"; s: string; i?: string; r: WireRange | null; d: Direction; at?: [string, string]; to?: [string, string?]; n: number; v: boolean; pre?: number }
  /** getAllRecords: up to `n` records (key, primary key, value) in direction `d`. */
  | { o: "recs"; s: string; i?: string; r: WireRange | null; n: number; d: Direction }
  | { o: "query"; s: string; q: string }
  | { o: "mkStore"; def: StoreDef }
  | { o: "rmStore"; s: string }
  | { o: "mkIndex"; s: string; def: IndexDef }
  | { o: "rmIndex"; s: string; i: string };

export interface PutRow {
  k?: string;
  v: string;
  t?: unknown[];
  add: boolean;
}

/** A cursor step's answer: encoded key, encoded primary key, value if asked. */
export interface CursorHit {
  k: string;
  p: string;
  v?: unknown;
  /** Prefetched next steps, in order. */
  more?: CursorHit[];
}

export interface TxMessage {
  t: "tx";
  tx: number;
  db: string;
  begin?: { mode: "readonly" | "readwrite" | "versionchange"; stores: string[]; version?: number };
  ops: Op[];
  /** `commitIfClean`: commit unless a request of the transaction failed (then reply `Deferred`). */
  end?: "commit" | "abort" | "commitIfClean";
}

export interface TxReply {
  t: "tx";
  tx: number;
  /** One per request, in order. */
  res: unknown[];
  /** Requests that failed: [index into res, DOMException name, message]. */
  errs: [number, string, string][];
  /** Set when the message ended the transaction. */
  end?: { ok: true } | { ok: false; name: string; message: string };
}

export type CallMessage =
  | { t: "open"; id: number; db: string }
  | { t: "close"; id: number; db: string }
  | { t: "delete"; id: number; db: string }
  /** Sets the runtime's memory budget in bytes; null for no limit. */
  | { t: "budget"; id: number; bytes: number | null }
  /** Memory facts, and the file sizes of `db` if it is open. */
  | { t: "stats"; id: number; db?: string }
  /** Compacts every store file of an open database. */
  | { t: "compact"; id: number; db: string }
  /** Checks that the worker runs the engine on OPFS; fails where it cannot. */
  | { t: "probe"; id: number };

/** A call message without its id, per variant. */
export type CallRequest = CallMessage extends infer M ? (M extends CallMessage ? Omit<M, "id"> : never) : never;

/** What `memoryStats` reports. */
export interface MemoryStats {
  /** The worker's WASM memory: its peak, since WASM memory never shrinks. */
  wasmMemoryBytes: number;
  /** The memory budget for loaded sections; Infinity when there is none. */
  budgetBytes: number;
  /** Bytes the loaded sections of every open database hold. */
  cachedBytes: number;
  /** The database's files (catalog and one per store), when it is open. */
  fileBytes?: number;
  files?: Record<string, number>;
  /** Of `fileBytes`, the bytes the committed states use; the rest is free space. */
  usedBytes?: number;
}

export type CallReply = { t: "call"; id: number; ok: true; value: any } | { t: "call"; id: number; ok: false; name: string; message: string };
