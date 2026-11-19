// The worker that hosts plateau's engine for the IndexedDB-compatible API.
//
// Files: one OPFS directory per database, holding `catalog` (an engine file with no rows whose
// meta string is the catalog: version, stores, indexes, and the intent of a group commit) and one
// engine file `s<id>` per object store. Every file is an engine database, so every commit is the
// engine's crash-safe save: the new state goes into space the old one does not use, then a header
// slot flips.
//
// A store's engine schema:
//   - generic store: `_rid` (f64, the engine's primary key: an internal row id), `_k` (the record's
//     key) and `_v` (str: the stored value);
//   - typed store (declared `columns`): the declared fields as typed engine columns, the key path
//     field as the engine's f64 primary key, and `_v` holding the rest of the value ("" if none);
//   - both: `_i<id>` per IndexedDB index, holding the record's index entries (index key, then
//     primary key; one per distinct element for multiEntry).
// `_k` and `_i<id>` are str columns with the engine's keys index, holding keys in the sortable
// encoding written as ASCII digits, so key order, ranges and cursors are engine index walks that
// read blocks on first touch: nothing is scanned at open or first use. A typed store's primary key
// order is the engine's own. Creating or deleting an index moves the store to a new file with the
// new columns, the one time records are read in bulk.

// Transactions: the API on the main thread starts a transaction only when no earlier, unfinished
// transaction with an overlapping scope writes, so this worker runs each message as it comes. Every
// readwrite commit saves, so a store's engine holds no unsaved changes when a transaction starts,
// and abort is the engine's rollback. A commit that writes more
// than one file first records each file's committed sequence number in the catalog (the intent);
// opening a database that still has an intent reopens those files at the recorded sequence.

import { Db, cachedBytes, initSync, memoryBudget, setMemoryBudget } from "plateau-engine";
import { decodeKey, encodeNumberKey, encodedNumber, indexKeys, injectKey, skipKey, spelledKey, type SpelledKey, type WireRange } from "./key";
import type { CallMessage, CallReply, Catalog, ColumnDecl, CursorHit, IndexDef, MemoryStats, Op, PutRow, StoreDef, TxMessage, TxReply } from "./protocol";
import { decodeValue, encodeValue } from "./value";

interface SyncAccessHandle {
  read(buf: Uint8Array, o?: { at: number }): number;
  write(buf: Uint8Array, o?: { at: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

let memory: WebAssembly.Memory | null = null;
let markReady = () => {};
let markFailed: (e: Error) => void = () => {};
const wasmReady = new Promise<void>((resolve, reject) => {
  markReady = resolve;
  markFailed = reject;
});
wasmReady.catch(() => {});
const encoder = new TextEncoder();

class IdbError extends Error {
  constructor(
    readonly name: string,
    message: string,
  ) {
    super(message);
  }
}

/** The engine's storage over one sync access handle; views are built per call because a
 * memory.grow detaches the previous buffer. */
function storageOf(access: SyncAccessHandle) {
  return {
    read: (ptr: number, len: number, at: number) => access.read(new Uint8Array(memory!.buffer, ptr, len), { at }),
    write: (ptr: number, len: number, at: number) => access.write(new Uint8Array(memory!.buffer, ptr, len), { at }),
    size: () => access.getSize(),
    truncate: (size: number) => access.truncate(size),
    flush: () => access.flush(),
  };
}

const CATALOG_SCHEMA = JSON.stringify({ primaryKey: "k", columns: [{ name: "k", kind: "f64" }] });
const MAX_KEY = 2 ** 53;
/** How long a database's files stay open after its last connection closes. */
const CLOSE_DELAY_MS = 2000;

/** The memory budget for loaded sections: 64 MiB, or 24 MiB on a device reporting 4 GiB of memory
 * or less (`navigator.deviceMemory`, where the browser has it). `plateau.setMemoryBudget` sets
 * another. */
function defaultBudget(): number {
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return mem !== undefined && mem <= 4 ? 24 << 20 : 64 << 20;
}

/** Takes a file's sync access handle. Another context may still hold it for a moment (a page
 * that is being replaced, whose worker has not released its handles yet), so a refusal is retried
 * for up to two seconds. */
async function lockFile(dir: FileSystemDirectoryHandle, name: string): Promise<SyncAccessHandle> {
  const file = (await fileHandle(dir, name)) as unknown as { createSyncAccessHandle(): Promise<SyncAccessHandle> };
  for (let wait = 1; ; wait *= 2) {
    try {
      return await file.createSyncAccessHandle();
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (wait > 1024 || (name !== "NoModificationAllowedError" && name !== "InvalidStateError")) throw e;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

function dirName(db: string): string {
  return "db-" + encodeURIComponent(db);
}

// Handles are looked up once and kept: a reopen takes the same handle's lock again, as the engine's
// own worker does.
let root: Promise<FileSystemDirectoryHandle> | null = null;
const dirs = new Map<string, Promise<FileSystemDirectoryHandle>>();
const files = new Map<FileSystemDirectoryHandle, Map<string, Promise<FileSystemFileHandle>>>();

function rootDir(): Promise<FileSystemDirectoryHandle> {
  root ??= navigator.storage.getDirectory().then((r) => r.getDirectoryHandle("plateau", { create: true }));
  return root;
}

function dbDir(db: string): Promise<FileSystemDirectoryHandle> {
  let d = dirs.get(db);
  if (!d) {
    d = rootDir().then((r) => r.getDirectoryHandle(dirName(db), { create: true }));
    dirs.set(db, d);
  }
  return d;
}

function fileHandle(dir: FileSystemDirectoryHandle, name: string): Promise<FileSystemFileHandle> {
  let m = files.get(dir);
  if (!m) files.set(dir, (m = new Map()));
  let f = m.get(name);
  if (!f) {
    f = dir.getFileHandle(name, { create: true });
    m.set(name, f);
  }
  return f;
}

/** Removes a file and forgets its handle. */
function removeFile(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  files.get(dir)?.delete(name);
  return dir.removeEntry(name).catch(() => {});
}

// Keys in the engine. The sortable key encoding (a JS string, see key.ts) goes into the engine as
// ASCII: each 16-bit code unit as three digits of a 41-character alphabet in ascending byte order,
// so byte order is key order, and a string column's keys index serves it. A space separates the
// keys of one row; "~" sorts above every digit, " " below.
//
// A key that holds -0 is stored as its encoding, then "!" and its raw encoding (`spelledKey`), so it
// can be handed back as -0. "!" sorts below every digit, so the entry still sorts, matches and
// counts as its encoding does; a bound just past an entry is '"', above "!" and below every digit.
// Files without -0 keys hold no "!", as before.
const SPELL = "!";
const PAST = '"';
const DIG = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcde";
const DIGV = new Uint8Array(128);
for (let i = 0; i < DIG.length; i++) DIGV[DIG.charCodeAt(i)] = i;

function digits(s: string): string {
  let o = "";
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    o += DIG[(u / 1681) | 0] + DIG[((u / 41) | 0) % 41] + DIG[u % 41];
  }
  return o;
}

function undigits(d: string): string {
  const units = new Array<number>(d.length / 3);
  for (let i = 0, j = 0; i < d.length; i += 3, j++) {
    units[j] = DIGV[d.charCodeAt(i)] * 1681 + DIGV[d.charCodeAt(i + 1)] * 41 + DIGV[d.charCodeAt(i + 2)];
  }
  let s = "";
  for (let i = 0; i < units.length; i += 8192) s += String.fromCharCode(...units.slice(i, i + 8192));
  return s;
}

/** The stored form of an entry: its encoding `e`, spelled by `raw` where it holds -0. */
function stored(e: string, raw: string | undefined): string {
  return raw === undefined ? digits(e) : digits(e) + SPELL + digits(raw);
}

/** A stored entry's encoding, and its raw encoding where it is spelled. */
function unstored(d: string): [string, string | undefined] {
  const at = d.indexOf(SPELL);
  return at < 0 ? [undigits(d), undefined] : [undigits(d.slice(0, at)), undigits(d.slice(at + 1))];
}

/** An index entry: index key, then primary key, spelled where either holds -0. */
function indexEntry(ik: SpelledKey, pk: string, spk: string | undefined): string {
  return stored(ik.k + pk, ik.sk === undefined && spk === undefined ? undefined : (ik.sk ?? ik.k) + (spk ?? pk));
}

/** The raw encoding of the number key -0. */
const NEG_ZERO = spelledKey(-0)!;

/** A lower bound on entries (sortable strings): at or above `s`, above it, or above every entry
 * that starts with the key `s`. */
type Lo = { s: string; m: "ge" | "gt" | "after" };
/** An upper bound: below `s`, at or below it, or through every entry that starts with `s`. */
type Hi = { s: string; m: "lt" | "le" | "through" };

const loDigits = (b: Lo | null) => (b === null ? "" : digits(b.s) + (b.m === "ge" ? "" : b.m === "gt" ? PAST : "~"));
const hiDigits = (b: Hi | null) => (b === null ? undefined : digits(b.s) + (b.m === "lt" ? "" : b.m === "le" ? PAST : "~"));
const rangeLo = (r: WireRange | null): Lo | null => (r && r.lo !== undefined ? { s: r.lo, m: r.loOpen ? "after" : "ge" } : null);
const rangeHi = (r: WireRange | null): Hi | null => (r && r.hi !== undefined ? { s: r.hi, m: r.hiOpen ? "lt" : "through" } : null);

/** An index or store entry: key, primary key (sortable strings), and the engine row id; `sk` and
 * `sp` are the raw encodings of a key and primary key that hold -0. */
interface Ent {
  k: string;
  p: string;
  rid: number;
  sk?: string;
  sp?: string;
}

interface Meta {
  gen: number;
  rid: number;
}

interface PendingRow {
  rid: number;
  k: string;
  v: string;
  t?: unknown[];
  ix: string[];
}

class StoreHost {
  db: Db | null = null;
  access: SyncAccessHandle | null = null;
  meta: Meta = { gen: 1, rid: 1 };
  metaDirty = false;
  written = false;
  /** Created by the running upgrade; removed if it aborts. */
  created = false;
  /** Rows put since the last flush to the engine, and what lookups need of them. */
  pending = { keys: new Set<number>(), byPk: new Map<string, number>(), unique: new Map<number, Map<string, string>>(), rows: [] as PendingRow[] };
  /** The engine and file this store had before an index change in the running upgrade. */
  replaced: { db: Db; access: SyncAccessHandle; file: string } | null = null;

  constructor(
    public def: StoreDef,
    readonly owner: DatabaseHost,
  ) {}

  get typed(): boolean {
    return !!this.def.columns;
  }

  get engine(): Db {
    if (!this.db) throw new IdbError("UnknownError", `plateau: store ${this.def.name} is not open`);
    return this.db;
  }

  schema(): string {
    const ix = this.def.indexes.map((i) => ({ name: `_i${i.id}`, kind: "str", index: "keys" }));
    if (!this.def.columns) {
      return JSON.stringify({
        primaryKey: "_rid",
        columns: [{ name: "_rid", kind: "f64" }, { name: "_k", kind: "str", index: "keys" }, { name: "_v", kind: "str" }, ...ix],
      });
    }
    return JSON.stringify({
      primaryKey: this.def.keyPath,
      columns: [...this.def.columns.map((c) => ({ name: c.name, kind: c.kind, index: c.index ?? "none", group: c.group })), { name: "_v", kind: "str", omit_empty: true }, ...ix],
    });
  }

  async open(create: boolean): Promise<void> {
    if (this.db) return;
    await wasmReady;
    this.access = await lockFile(this.owner.dir!, this.def.file);
    const storage = storageOf(this.access);
    this.db = create || this.access.getSize() === 0 ? Db.create(storage as never, this.schema()) : Db.open(storage as never);
    this.loadMeta();
  }

  loadMeta(): void {
    const m = this.db!.meta();
    this.meta = m ? JSON.parse(m) : { gen: 1, rid: 1 };
    this.metaDirty = false;
  }

  close(): void {
    this.db?.free();
    this.db = null;
    this.access?.close();
    this.access = null;
  }

  clearPending(): void {
    this.pending = { keys: new Set(), byPk: new Map(), unique: new Map(), rows: [] };
  }

  /** Writes the buffered puts to the engine as one batch. */
  flush(): void {
    const p = this.pending;
    if (!p.rows.length) return;
    const db = this.engine;
    const n = p.rows.length;
    db.beginBatch(n);
    if (!this.def.columns) {
      db.setF64("_rid", Float64Array.from(p.rows, (r) => r.rid));
      setStrings(db, "_k", p.rows.map((r) => r.k));
    } else {
      this.def.columns.forEach((c, ci) => setColumn(db, c, p.rows.map((r) => r.t![ci])));
    }
    setStrings(db, "_v", p.rows.map((r) => r.v));
    this.def.indexes.forEach((ix, i) => setStrings(db, `_i${ix.id}`, p.rows.map((r) => r.ix[i])));
    db.putBatch();
    this.clearPending();
  }

  /** Values (or `undefined`) for engine row ids. */
  fetch(rids: number[]): unknown[] {
    this.flush();
    if (!rids.length) return [];
    const rows = JSON.parse(this.engine.getMany(Float64Array.from(rids))) as (Record<string, unknown> | null)[];
    return rows.map((r) => (r ? this.toValue(r) : undefined));
  }

  toValue(row: Record<string, unknown>): unknown {
    const v = row._v as string | undefined;
    if (!this.typed) return decodeValue(v!);
    if (v === undefined) return row;
    delete row._v;
    return Object.assign(row, decodeValue(v) as object);
  }

  index(name: string): IndexDef {
    const ix = this.def.indexes.find((x) => x.name === name);
    if (!ix) throw new IdbError("NotFoundError", `No index named ${name}.`);
    return ix;
  }

  /** Live entries between the bounds, ascending or descending, at most `limit`: of an index, or
   * of the store's primary key. */
  scan(ix: IndexDef | null, lo: Lo | null, hi: Hi | null, desc: boolean, limit: number): Ent[] {
    this.flush();
    if (ix === null && this.typed) return this.scanNumbers(lo, hi, desc, limit);
    const col = ix === null ? "_k" : `_i${ix.id}`;
    const text = this.engine.keyScan(col, loDigits(lo), hiDigits(hi), desc, Math.min(limit, 0xffffffff));
    if (!text) return [];
    return text.split("\n").map((line): Ent => {
      const tab = line.indexOf("\t");
      const [e, raw] = unstored(line.slice(0, tab));
      const rid = Number(line.slice(tab + 1));
      if (ix === null) return raw === undefined ? { k: e, p: e, rid } : { k: e, p: e, rid, sk: raw, sp: raw };
      const kl = skipKey(e, 0);
      const ent: Ent = { k: e.slice(0, kl), p: e.slice(kl), rid };
      if (raw !== undefined) {
        // A raw encoding has the same length as the encoding it spells.
        if (raw.slice(0, kl) !== ent.k) ent.sk = raw.slice(0, kl);
        if (raw.slice(kl) !== ent.p) ent.sp = raw.slice(kl);
      }
      return ent;
    });
  }

  /** A typed store's primary key order: the engine's own f64 primary key. Keys of other types
   * sort above every number. The key 0 is spelled as its record holds it (`spell`). */
  scanNumbers(lo: Lo | null, hi: Hi | null, desc: boolean, limit: number, spell = true): Ent[] {
    let l = -Infinity;
    let lOpen = false;
    let h = Infinity;
    let hOpen = false;
    if (lo) {
      const n = encodedNumber(lo.s);
      if (n === undefined) return [];
      l = n;
      lOpen = lo.m !== "ge";
    }
    if (hi) {
      const n = encodedNumber(hi.s);
      if (n !== undefined) {
        h = n;
        hOpen = hi.m === "lt";
      }
    }
    const keys = this.engine.pkScan(l, lOpen, h, hOpen, desc, Math.min(limit, 0xffffffff));
    const ents = Array.from(keys, (n): Ent => {
      const k = encodeNumberKey(n);
      return { k, p: k, rid: n };
    });
    const zero = spell ? keys.indexOf(0) : -1;
    if (zero >= 0) {
      const [row] = JSON.parse(this.engine.getMany(Float64Array.of(0))) as (Record<string, unknown> | null)[];
      if (row && Object.is(row[this.def.keyPath as string], -0)) ents[zero].sk = ents[zero].sp = NEG_ZERO;
    }
    return ents;
  }

  count(ix: IndexDef | null, r: WireRange | null): number {
    this.flush();
    if (ix === null && this.typed) return r === null ? this.engine.len() : this.scanNumbers(rangeLo(r), rangeHi(r), false, Infinity, false).length;
    return this.engine.keyCount(ix === null ? "_k" : `_i${ix.id}`, loDigits(rangeLo(r)), hiDigits(rangeHi(r)));
  }

  /** The engine row id of the record with this primary key, if there is one. */
  ridOf(pk: string): number | undefined {
    if (this.typed) {
      const n = encodedNumber(pk);
      if (n === undefined) return undefined;
      if (this.pending.keys.has(n)) return n;
      return this.engine.pkScan(n, false, n, false, false, 1).length ? n : undefined;
    }
    const r = this.pending.byPk.get(pk);
    if (r !== undefined) return r;
    const d = digits(pk);
    const text = this.engine.keyScan("_k", d, d + PAST, false, 1);
    return text ? Number(text.slice(text.indexOf("\t") + 1)) : undefined;
  }

  generate(): number {
    if (this.meta.gen > MAX_KEY) throw new IdbError("ConstraintError", "The key generator has reached its maximum.");
    this.metaDirty = true;
    return this.meta.gen++;
  }

  bump(n: number): void {
    if (n >= this.meta.gen) {
      this.meta.gen = Math.floor(Math.min(n, MAX_KEY)) + 1;
      this.metaDirty = true;
    }
  }

  /** A record's index keys per index, checked against unique indexes. */
  indexKeysOf(value: unknown, pk: string): SpelledKey[][] {
    return this.def.indexes.map((ix) => {
      const keys = indexKeys(value, ix.keyPath, ix.multiEntry);
      if (ix.unique) {
        const mine = this.pending.unique.get(ix.id);
        for (const { k: ik } of keys) {
          const other = mine?.get(ik);
          if (other !== undefined && other !== pk) throw new IdbError("ConstraintError", `Unique index ${ix.name} already holds this key.`);
          const d = digits(ik);
          const text = this.engine.keyScan(`_i${ix.id}`, d, d + "~", false, 2);
          for (const line of text ? text.split("\n") : []) {
            const [e] = unstored(line.slice(0, line.indexOf("\t")));
            if (e.slice(skipKey(e, 0)) !== pk) throw new IdbError("ConstraintError", `Unique index ${ix.name} already holds this key.`);
          }
        }
      }
      return keys;
    });
  }

  put(row: PutRow): string {
    const def = this.def;
    let k = row.k;
    let generated = false;
    if (k === undefined) {
      k = encodeNumberKey(this.generate());
      generated = true;
    } else if (def.autoIncrement) {
      const n = encodedNumber(k);
      if (n !== undefined) this.bump(n);
    }
    let v = row.v;
    let t = row.t;
    let value: unknown;
    if (generated && typeof def.keyPath === "string") {
      if (this.typed) {
        t = t!.slice();
        t[def.columns!.findIndex((c) => c.name === def.keyPath)] = encodedNumber(k);
      } else {
        value = decodeValue(v);
        injectKey(value, def.keyPath, decodeKey(k));
        v = encodeValue(value);
      }
    }
    const old = this.ridOf(k);
    if (row.add && old !== undefined) throw new IdbError("ConstraintError", "A record with this key already exists.");
    let ix: SpelledKey[][] = [];
    if (def.indexes.length) {
      if (value === undefined) value = this.typed ? this.typedValue(t!, v) : decodeValue(v);
      ix = this.indexKeysOf(value, k);
    }
    let rid: number;
    if (this.typed) rid = encodedNumber(k)!;
    else if (old !== undefined) rid = old;
    else {
      rid = this.meta.rid++;
      this.metaDirty = true;
    }
    if (this.pending.keys.has(rid)) this.flush();
    const p = this.pending;
    p.keys.add(rid);
    if (!this.typed) p.byPk.set(k, rid);
    def.indexes.forEach((x, i) => {
      if (!x.unique) return;
      let m = p.unique.get(x.id);
      if (!m) p.unique.set(x.id, (m = new Map()));
      for (const ik of ix[i]) m.set(ik.k, k!);
    });
    const sk = generated ? undefined : row.sk;
    p.rows.push({ rid, k: this.typed ? "" : stored(k, sk), v, t, ix: ix.map((keys) => keys.map((ik) => indexEntry(ik, k!, sk)).join(" ")) });
    return sk ?? k;
  }

  /** A typed batch of puts: straight to the engine when nothing needs a per-row decision, else
   * row by row. Results: `undefined` for a key the caller gave, the key for a generated one. */
  putColumns(op: Extract<Op, { o: "tput" }>, res: unknown[], fail: (e: unknown, i: number) => void): void {
    const def = this.def;
    const cols = def.columns!;
    const pkAt = cols.findIndex((c) => c.name === def.keyPath);
    const keys = op.cols[pkAt] as Float64Array;
    let fast = def.indexes.length === 0 && op.add.length === 0 && op.gen.length === 0;
    if (fast) {
      const seen = new Set<number>();
      for (let i = 0; i < op.n && fast; i++) {
        const k = keys[i];
        if (seen.has(k) || this.pending.keys.has(k)) fast = false;
        seen.add(k);
      }
    }
    if (fast) {
      if (def.autoIncrement) for (let i = 0; i < op.n; i++) this.bump(keys[i]);
      this.flush();
      const db = this.engine;
      db.beginBatch(op.n);
      cols.forEach((c, ci) => setWire(db, c, op.cols[ci]));
      if (op.v) setStrings(db, "_v", op.v);
      else db.setStr("_v", new Uint32Array(op.n + 1), new Uint8Array(0));
      db.putBatch();
      for (let i = 0; i < op.n; i++) res.push(undefined);
      return;
    }
    const adds = new Set(op.add);
    const gens = new Set(op.gen);
    for (let i = 0; i < op.n; i++) {
      const t = cols.map((c, ci) => wireAt(c, op.cols[ci], i));
      const row: PutRow = { v: op.v ? op.v[i] : "", t, add: adds.has(i) };
      if (!gens.has(i)) {
        row.k = encodeNumberKey(keys[i]);
        if (Object.is(keys[i], -0)) row.sk = NEG_ZERO;
      }
      try {
        const k = this.put(row);
        res.push(gens.has(i) ? k : undefined);
      } catch (e) {
        fail(e, res.length);
        res.push(undefined);
      }
    }
  }

  typedValue(t: unknown[], rest: string): unknown {
    const row: Record<string, unknown> = {};
    this.def.columns!.forEach((c, i) => (row[c.name] = t[i]));
    return rest === "" ? row : Object.assign(row, decodeValue(rest) as object);
  }

  /** Deletes single keys. */
  deleteKeys(ks: string[]): void {
    this.flush();
    if (this.typed) {
      const nums = ks.map((k) => encodedNumber(k)).filter((n): n is number => n !== undefined);
      if (nums.length) this.engine.delete(Float64Array.from(nums));
      return;
    }
    const rids: number[] = [];
    for (const k of ks) {
      const r = this.ridOf(k);
      if (r !== undefined) rids.push(r);
    }
    if (rids.length) this.engine.delete(Float64Array.from(rids));
  }

  deleteRange(r: WireRange | null): void {
    const rids = this.scan(null, rangeLo(r), rangeHi(r), false, Infinity).map((e) => e.rid);
    if (rids.length) this.engine.delete(Float64Array.from(rids));
  }

  values(ents: Ent[]): unknown[] {
    return this.fetch(ents.map((e) => e.rid));
  }
}

/** An entry as a cursor step hands it back. */
function hitOf(e: Ent): CursorHit {
  const h: CursorHit = { k: e.k, p: e.p };
  if (e.sk !== undefined) h.sk = e.sk;
  if (e.sp !== undefined) h.sp = e.sp;
  return h;
}

const ASCII = /^[\x00-\x7f]*$/;

function setStrings(db: Db, name: string, strs: string[]): void {
  const n = strs.length;
  const offsets = new Uint32Array(n + 1);
  // ASCII text (the common case) encodes in one call, its offsets being string lengths.
  const joined = strs.join("");
  if (ASCII.test(joined)) {
    for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + strs[i].length;
    db.setStr(name, offsets, encoder.encode(joined));
    return;
  }
  let size = 0;
  for (const s of strs) size += s.length * 3;
  const bytes = new Uint8Array(size);
  let at = 0;
  strs.forEach((s, i) => {
    at += encoder.encodeInto(s, bytes.subarray(at)).written;
    offsets[i + 1] = at;
  });
  db.setStr(name, offsets, bytes.subarray(0, at));
}

/** Sets a column from the wire form the API sends for a typed batch. */
function setWire(db: Db, c: ColumnDecl, w: unknown): void {
  switch (c.kind) {
    case "f64":
      db.setF64(c.name, w as Float64Array);
      break;
    case "u32":
      db.setU32(c.name, w as Uint32Array);
      break;
    case "str":
      setStrings(db, c.name, w as string[]);
      break;
    case "u32_multi": {
      const [offsets, values] = w as [Uint32Array, Uint32Array];
      db.setMulti(c.name, offsets, values);
      break;
    }
  }
}

/** Row `i`'s value of a column in wire form. */
function wireAt(c: ColumnDecl, w: unknown, i: number): unknown {
  if (c.kind === "u32_multi") {
    const [offsets, values] = w as [Uint32Array, Uint32Array];
    return Array.from(values.subarray(offsets[i], offsets[i + 1]));
  }
  return (w as ArrayLike<unknown>)[i];
}

function setColumn(db: Db, c: ColumnDecl, vals: unknown[]): void {
  switch (c.kind) {
    case "f64":
      db.setF64(c.name, Float64Array.from(vals as number[]));
      break;
    case "u32":
      db.setU32(c.name, Uint32Array.from(vals as number[]));
      break;
    case "str":
      setStrings(db, c.name, vals as string[]);
      break;
    case "u32_multi": {
      const offsets = new Uint32Array(vals.length + 1);
      let total = 0;
      for (const v of vals) total += (v as number[]).length;
      const values = new Uint32Array(total);
      let at = 0;
      vals.forEach((v, i) => {
        for (const x of v as number[]) values[at++] = x;
        offsets[i + 1] = at;
      });
      db.setMulti(c.name, offsets, values);
      break;
    }
  }
}

class DatabaseHost {
  dir: FileSystemDirectoryHandle | null = null;
  catalogAccess: SyncAccessHandle | null = null;
  catalogDb: Db | null = null;
  /** The committed catalog. */
  cat: Catalog = { version: 0, nextId: 1, stores: [] };
  stores = new Map<string, StoreHost>();
  conns = 0;
  /** The running upgrade: the catalog before it, and stores it deleted. */
  upgrade: { before: Catalog; deleted: StoreHost[] } | null = null;
  /** Stores written by each running readwrite transaction. */
  txStores = new Map<number, Set<StoreHost>>();
  /** Set while the files stay open after the last connection closed. */
  closeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Running transactions that had a request fail. */
  failed = new Set<number>();

  constructor(readonly name: string) {}

  async open(): Promise<void> {
    if (this.dir) return;
    await wasmReady;
    this.dir = await dbDir(this.name);
    this.catalogAccess = await lockFile(this.dir, "catalog");
    if (this.catalogAccess.getSize() > 0) {
      this.catalogDb = Db.open(storageOf(this.catalogAccess) as never);
      const meta = JSON.parse(this.catalogDb.meta()) as Catalog & { intent?: Record<string, number> | null };
      if (meta.intent) await this.recover(meta.intent);
      this.cat = { version: meta.version, nextId: meta.nextId, stores: meta.stores };
    }
    for (const def of this.cat.stores) this.stores.set(def.name, new StoreHost(def, this));
    // Every store's file opens with the database (header slots and manifest only), as the engine
    // opens its file, so a transaction never waits for a file lock.
    for (const s of this.stores.values()) await s.open(false);
  }

  /** A group commit was cut short: put each file it may have saved back at its recorded state. */
  async recover(intent: Record<string, number>): Promise<void> {
    for (const [file, seq] of Object.entries(intent)) {
      const access = await lockFile(this.dir!, file);
      if (access.getSize() > 0) {
        const db = Db.openAt(storageOf(access) as never, seq);
        db.save();
        db.free();
      }
      access.close();
    }
    const meta = JSON.parse(this.catalogDb!.meta());
    meta.intent = null;
    this.catalogDb!.setMeta(JSON.stringify(meta));
    this.catalogDb!.save();
  }

  writeCatalog(cat: Catalog, intent: Record<string, number> | null): void {
    if (!this.catalogDb) this.catalogDb = Db.create(storageOf(this.catalogAccess!) as never, CATALOG_SCHEMA);
    this.catalogDb.setMeta(JSON.stringify({ ...cat, intent }));
    this.catalogDb.save();
  }

  close(): void {
    for (const s of this.stores.values()) s.close();
    this.catalogDb?.free();
    this.catalogDb = null;
    this.catalogAccess?.close();
    this.catalogAccess = null;
    this.dir = null;
    this.stores.clear();
  }

  store(name: string): StoreHost {
    const s = this.stores.get(name);
    if (!s) throw new IdbError("NotFoundError", `No object store named ${name}.`);
    return s;
  }

  /** Whether `begin` must wait for files to open. */
  beginIsAsync(b: NonNullable<TxMessage["begin"]>): boolean {
    if (b.mode === "versionchange") return [...this.stores.values()].some((s) => !s.db);
    return b.stores.some((n) => this.stores.get(n)?.db === null);
  }

  async begin(tx: number, b: NonNullable<TxMessage["begin"]>): Promise<void> {
    if (b.mode === "versionchange") {
      this.upgrade = { before: structuredClone(this.cat), deleted: [] };
      this.cat = structuredClone(this.cat);
      this.cat.version = b.version!;
      // Store hosts follow the working catalog's defs.
      for (const def of this.cat.stores) this.stores.get(def.name)!.def = def;
      for (const s of this.stores.values()) await s.open(false);
    } else {
      for (const name of b.stores) {
        const s = this.store(name);
        if (!s.db) await s.open(false);
      }
    }
    if (b.mode !== "readonly") this.txStores.set(tx, new Set());
  }

  touched(tx: number, s: StoreHost): StoreHost {
    s.written = true;
    this.txStores.get(tx)?.add(s);
    return s;
  }

  run(tx: number, op: Op, res: unknown[], errs: [number, string, string][]): void {
    const at = res.length;
    const fail = (e: unknown, i: number) => {
      const err = e instanceof IdbError ? e : new IdbError("UnknownError", e instanceof Error ? e.message : String(e));
      if (!(e instanceof IdbError)) console.error(e);
      errs.push([i, err.name, err.message]);
    };
    switch (op.o) {
      case "get": {
        const s = this.store(op.s);
        try {
          s.flush();
          // A typed store's row id is its key; getMany answers null for a missing one.
          const rids = op.ks.map((k) => (s.typed ? encodedNumber(k) : s.ridOf(k)));
          const vals = s.fetch(rids.filter((r): r is number => r !== undefined));
          let j = 0;
          for (const r of rids) res.push(r === undefined ? undefined : vals[j++]);
        } catch (e) {
          for (let i = 0; i < op.ks.length; i++) {
            fail(e, at + i);
            res.push(undefined);
          }
        }
        return;
      }
      case "delk": {
        const n = op.nums ? op.nums.length : op.ks.length;
        try {
          const s = this.touched(tx, this.store(op.s));
          if (op.nums) {
            s.flush();
            s.engine.delete(Float64Array.from(op.nums));
          } else s.deleteKeys(op.ks);
        } catch (e) {
          for (let i = 0; i < n; i++) fail(e, at + i);
        }
        for (let i = 0; i < n; i++) res.push(undefined);
        return;
      }
      case "tput": {
        this.touched(tx, this.store(op.s)).putColumns(op, res, fail);
        return;
      }
      case "put": {
        const s = this.touched(tx, this.store(op.s));
        for (const row of op.rows) {
          try {
            res.push(s.put(row));
          } catch (e) {
            fail(e, res.length);
            res.push(undefined);
          }
        }
        return;
      }
    }
    try {
      res.push(this.one(tx, op));
    } catch (e) {
      fail(e, at);
      res.push(undefined);
    }
  }

  one(tx: number, op: Op): unknown {
    switch (op.o) {
      case "first": {
        const s = this.store(op.s);
        const ix = op.i === undefined ? null : s.index(op.i);
        const [e] = s.scan(ix, rangeLo(op.r), rangeHi(op.r), false, 1);
        if (!e) return undefined;
        return op.key ? (e.sp ?? e.p) : s.values([e])[0];
      }
      case "all": {
        const s = this.store(op.s);
        const ix = op.i === undefined ? null : s.index(op.i);
        const ents = s.scan(ix, rangeLo(op.r), rangeHi(op.r), false, op.n > 0 ? op.n : Infinity);
        return op.key ? ents.map((e) => e.sp ?? e.p) : s.values(ents);
      }
      case "recs": {
        const s = this.store(op.s);
        const ix = op.i === undefined ? null : s.index(op.i);
        const desc = op.d === "prev" || op.d === "prevunique";
        let ents = s.scan(ix, rangeLo(op.r), rangeHi(op.r), desc, op.d.endsWith("unique") ? Infinity : op.n > 0 ? op.n : Infinity);
        if (op.d.endsWith("unique")) {
          const firsts = new Map<string, Ent>();
          // Per key the entry with the lowest primary key: the first ascending, the last descending.
          for (const e of ents) if (desc || !firsts.has(e.k)) firsts.set(e.k, e);
          ents = [...firsts.values()];
          if (op.n > 0) ents = ents.slice(0, op.n);
        }
        const vals = s.values(ents);
        return ents.map((e, i) => ({ ...hitOf(e), v: vals[i] }));
      }
      case "count": {
        const s = this.store(op.s);
        return s.count(op.i === undefined ? null : s.index(op.i), op.r);
      }
      case "del":
        this.touched(tx, this.store(op.s)).deleteRange(op.r);
        return undefined;
      case "clear":
        this.touched(tx, this.store(op.s)).deleteRange(null);
        return undefined;
      case "cur":
        return this.cursor(op);
      case "query": {
        const s = this.store(op.s);
        if (!s.typed) throw new IdbError("NotSupportedError", "plateau: query() needs a store with declared columns.");
        s.flush();
        const out = JSON.parse(s.engine.query(op.q)) as { plan: string; rows?: Record<string, unknown>[]; count?: number };
        return { plan: out.plan, value: out.rows ? out.rows.map((r) => s.toValue(r)) : out.count };
      }
      case "rmStore": {
        const s = this.store(op.s);
        this.stores.delete(op.s);
        this.cat.stores = this.cat.stores.filter((d) => d !== s.def);
        if (!s.created) this.upgrade!.deleted.push(s);
        else s.close();
        return undefined;
      }
    }
    throw new IdbError("UnknownError", `plateau: unknown op ${(op as Op).o}`);
  }

  /** Creates a store's file and engine; part of the running upgrade. */
  async createStore(tx: number, def: StoreDef): Promise<void> {
    const s = new StoreHost(def, this);
    s.created = true;
    this.cat.stores.push(def);
    this.cat.nextId = Math.max(this.cat.nextId, def.id + 1);
    this.stores.set(def.name, s);
    await s.open(true);
    this.touched(tx, s);
  }

  /** Creates or deletes an index: the store moves to a new file whose schema has a column per
   * index, filled from the records (the only time records are read in bulk). A unique index over
   * records that share a key fails with ConstraintError. */
  async changeIndex(tx: number, op: Extract<Op, { o: "mkIndex" } | { o: "rmIndex" }>): Promise<void> {
    const s = this.store(op.s);
    const before = s.def.indexes;
    if (op.o === "mkIndex") {
      s.def.indexes = [...before, op.def];
      this.cat.nextId = Math.max(this.cat.nextId, op.def.id + 1);
    } else {
      s.index(op.i);
      s.def.indexes = before.filter((x) => x.name !== op.i);
    }
    s.flush();
    const old = { db: s.engine, access: s.access!, file: s.def.file };
    const m = /^(.*?)(?:\.(\d+))?$/.exec(old.file)!;
    const file = `${m[1]}.${Number(m[2] ?? 0) + 1}`;
    // Every record, read before the store switches engines.
    const ents = s.scan(null, null, null, false, Infinity);
    const values = s.fetch(ents.map((e) => e.rid));
    const meta = s.meta;
    s.db = null;
    s.access = null;
    s.def.file = file;
    try {
      await s.open(true);
      s.meta = meta;
      s.metaDirty = true;
      for (let i = 0; i < ents.length; i++) {
        const v = values[i] as Record<string, unknown>;
        if (s.typed) {
          const cols = s.def.columns!;
          const t = cols.map((c) => v[c.name]);
          const rest: Record<string, unknown> = {};
          for (const key of Object.keys(v)) if (!cols.some((c) => c.name === key)) rest[key] = v[key];
          s.put({ k: ents[i].p, sk: ents[i].sp, v: Object.keys(rest).length ? encodeValue(rest) : "", t, add: false });
        } else {
          const rid = ents[i].rid;
          const { p: pk, sp } = ents[i];
          const ix = s.indexKeysOf(v, pk);
          if (s.pending.keys.has(rid)) s.flush();
          s.pending.keys.add(rid);
          s.pending.byPk.set(ents[i].p, rid);
          s.def.indexes.forEach((x, j) => {
            if (!x.unique) return;
            let mm = s.pending.unique.get(x.id);
            if (!mm) s.pending.unique.set(x.id, (mm = new Map()));
            for (const ik of ix[j]) mm.set(ik.k, pk);
          });
          s.pending.rows.push({ rid, k: stored(pk, sp), v: encodeValue(v), ix: ix.map((keys) => keys.map((ik) => indexEntry(ik, pk, sp)).join(" ")) });
        }
        if (s.pending.rows.length >= 10000) s.flush();
      }
      s.flush();
    } catch (e) {
      s.close();
      void removeFile(this.dir!, file);
      s.db = old.db;
      s.access = old.access;
      s.def.file = old.file;
      s.def.indexes = before;
      throw e;
    }
    if (!s.replaced && !s.created) s.replaced = old;
    else {
      // A file made earlier in this upgrade is not referenced by any committed catalog.
      old.db.free();
      old.access.close();
      void removeFile(this.dir!, old.file);
    }
    this.touched(tx, s);
  }

  cursor(op: Extract<Op, { o: "cur" }>): CursorHit | null {
    const s = this.store(op.s);
    const ix = op.i === undefined ? null : s.index(op.i);
    const lo0 = rangeLo(op.r);
    const hi0 = rangeHi(op.r);
    let at: Ent | null = op.at ? { k: op.at[0], p: op.at[1], rid: 0 } : null;
    const entry = (e: { k: string; p: string }) => (ix === null ? e.p : e.k + e.p);
    let hit: Ent | null = null;
    for (let step = 0; step < op.n; step++) {
      const to = step === 0 ? op.to : undefined;
      let found: Ent | undefined;
      switch (op.d) {
        case "next": {
          const lo: Lo | null = to ? { s: to[1] === undefined ? to[0] : to[0] + to[1], m: "ge" } : at ? { s: entry(at), m: "gt" } : lo0;
          found = s.scan(ix, lo, hi0, false, 1)[0];
          break;
        }
        case "nextunique": {
          const lo: Lo | null = to ? { s: to[0], m: "ge" } : at ? { s: at.k, m: "after" } : lo0;
          found = s.scan(ix, lo, hi0, false, 1)[0];
          break;
        }
        case "prev": {
          const hi: Hi | null = to ? (to[1] === undefined ? { s: to[0], m: "through" } : { s: to[0] + to[1], m: "le" }) : at ? { s: entry(at), m: "lt" } : hi0;
          found = s.scan(ix, lo0, hi, true, 1)[0];
          break;
        }
        case "prevunique": {
          const hi: Hi | null = to ? { s: to[0], m: "through" } : at ? { s: at.k, m: "lt" } : hi0;
          const last = s.scan(ix, lo0, hi, true, 1)[0];
          found = last && s.scan(ix, { s: last.k, m: "ge" }, hi, false, 1)[0];
          break;
        }
      }
      if (!found) return null;
      at = hit = found;
    }
    const out: CursorHit = hitOf(hit!);
    if (op.v) out.v = s.values([hit!])[0];
    if (op.pre && (op.d === "next" || op.d === "prev")) {
      const more = op.d === "next" ? s.scan(ix, { s: entry(hit!), m: "gt" }, hi0, false, op.pre) : s.scan(ix, lo0, { s: entry(hit!), m: "lt" }, true, op.pre);
      const vals = op.v ? s.values(more) : [];
      out.more = more.map((e, i) => (op.v ? { ...hitOf(e), v: vals[i] } : hitOf(e)));
    }
    return out;
  }

  commit(tx: number): void {
    const written = [...(this.txStores.get(tx) ?? [])].filter((s) => this.stores.get(s.def.name) === s);
    this.txStores.delete(tx);
    const up = this.upgrade;
    const existing = written.filter((s) => !s.created && !s.replaced);
    const group = up ? existing.length > 0 : written.length > 1;
    if (group) {
      const intent: Record<string, number> = {};
      for (const s of existing) intent[s.def.file] = s.engine.seq();
      this.writeCatalog(up ? up.before : this.cat, intent);
      // Recovery reopens these files at the recorded states, so their bytes stay until the
      // catalog drops the intent.
      for (const s of existing) s.engine.setKeepPrevious(true);
    }
    try {
      for (const s of written) {
        s.flush();
        if (s.metaDirty || s.created || s.replaced) s.engine.setMeta(JSON.stringify(s.meta));
        s.engine.save();
        s.metaDirty = false;
        s.written = false;
      }
      if (up || group) this.writeCatalog(this.cat, null);
    } finally {
      if (group) for (const s of existing) s.engine.setKeepPrevious(false);
    }
    if (group) for (const s of existing) s.engine.releasePrevious();
    for (const s of written) {
      s.created = false;
      if (s.replaced) {
        s.replaced.db.free();
        s.replaced.access.close();
        void removeFile(this.dir!, s.replaced.file);
        s.replaced = null;
      }
    }
    if (up) {
      this.upgrade = null;
      for (const s of up.deleted) {
        s.close();
        void removeFile(this.dir!, s.def.file);
      }
    }
  }

  abort(tx: number): void {
    const written = this.txStores.get(tx) ?? new Set();
    this.txStores.delete(tx);
    const up = this.upgrade;
    if (up) {
      for (const s of [...this.stores.values(), ...up.deleted]) {
        if (s.created) {
          s.close();
          void removeFile(this.dir!, s.def.file);
        } else if (s.replaced) {
          s.close();
          void removeFile(this.dir!, s.def.file);
          s.db = s.replaced.db;
          s.access = s.replaced.access;
          s.replaced = null;
        }
      }
      for (const s of up.deleted) if (!s.created) written.add(s);
      this.cat = up.before;
      this.upgrade = null;
      const hosts = new Map<string, StoreHost>();
      for (const s of [...this.stores.values(), ...up.deleted]) {
        const def = this.cat.stores.find((d) => d.id === s.def.id);
        if (def && s.db) {
          s.def = def;
          hosts.set(def.name, s);
        }
      }
      this.stores = hosts;
    }
    for (const s of written) {
      if (!s.db) continue;
      s.clearPending();
      s.engine.rollback();
      s.loadMeta();
      s.written = false;
    }
  }
}

const hosts = new Map<string, DatabaseHost>();

async function host(name: string): Promise<DatabaseHost> {
  let h = hosts.get(name);
  if (!h) {
    h = new DatabaseHost(name);
    hosts.set(name, h);
  }
  await h.open();
  return h;
}

let probed: Promise<void> | null = null;

/** Whether this worker can run the engine on OPFS: the WASM started, and a sync access handle on
 * a file in plateau's directory opens. Fails in a WebKit ephemeral session (getDirectory throws
 * UnknownError) and where FileSystemSyncAccessHandle is missing. */
function probe(): Promise<void> {
  probed ??= (async () => {
    await wasmReady;
    try {
      const access = await lockFile(await rootDir(), "probe");
      access.close();
    } catch (e) {
      throw new IdbError("NotSupportedError", `plateau: OPFS sync access is not available here: ${(e as Error)?.name ?? ""} ${(e as Error)?.message ?? String(e)}`.trim());
    }
  })();
  return probed;
}

async function call(m: CallMessage): Promise<unknown> {
  switch (m.t) {
    case "probe":
      await probe();
      return null;
    case "open": {
      const h = await host(m.db);
      if (h.closeTimer !== null) clearTimeout(h.closeTimer);
      h.closeTimer = null;
      h.conns++;
      return { version: h.cat.version, nextId: h.cat.nextId, stores: h.cat.stores };
    }
    case "close": {
      const h = hosts.get(m.db);
      // As Chromium keeps a database's backing store open for two seconds after its last
      // connection closes, the files stay open that long, so a quick reopen finds them ready.
      if (h && --h.conns <= 0) {
        h.closeTimer = setTimeout(() => {
          h.closeTimer = null;
          if (h.conns > 0 || hosts.get(m.db) !== h) return;
          h.close();
          hosts.delete(m.db);
        }, CLOSE_DELAY_MS);
      }
      return null;
    }
    case "budget":
      await wasmReady;
      setMemoryBudget(m.bytes ?? Infinity);
      return memoryBudget();
    case "stats": {
      await wasmReady;
      const out: MemoryStats = { wasmMemoryBytes: memory?.buffer.byteLength ?? 0, budgetBytes: memoryBudget(), cachedBytes: cachedBytes() };
      const h = m.db === undefined ? undefined : hosts.get(m.db);
      if (h?.dir) {
        const files: Record<string, number> = {};
        let used = 0;
        if (h.catalogAccess) files.catalog = h.catalogAccess.getSize();
        used += h.catalogDb?.usedBytes() ?? files.catalog ?? 0;
        for (const s of h.stores.values()) {
          if (!s.access || !s.db) continue;
          files[s.def.file] = s.access.getSize();
          used += s.db.usedBytes();
        }
        out.files = files;
        out.fileBytes = Object.values(files).reduce((a, b) => a + b, 0);
        out.usedBytes = used;
      }
      return out;
    }
    case "compact": {
      const h = hosts.get(m.db);
      if (!h?.dir) throw new IdbError("InvalidStateError", `plateau: database ${m.db} is not open`);
      if (h.txStores.size || h.upgrade) throw new IdbError("InvalidStateError", "plateau: a readwrite transaction is running");
      for (const s of h.stores.values()) if (s.db) s.engine.compact();
      return null;
    }
    case "delete": {
      // A database whose files do not open (corrupt, or written by a format this build does not
      // read) is still deleted; its version is then unknown, reported as 0.
      let version = 0;
      try {
        const h = await host(m.db);
        if (h.closeTimer !== null) clearTimeout(h.closeTimer);
        version = h.cat.version;
      } catch (e) {
        console.warn(`plateau: deleting ${m.db}, which does not open: ${e instanceof Error ? e.message : String(e)}`);
      }
      hosts.get(m.db)?.close();
      hosts.delete(m.db);
      const dir = await dbDir(m.db);
      files.delete(dir);
      dirs.delete(m.db);
      await (await rootDir()).removeEntry(dirName(m.db), { recursive: true }).catch(() => {});
      return version;
    }
  }
}

/** Whether a transaction message has to wait for something (files to open). */
function txIsAsync(m: TxMessage): boolean {
  const h = hosts.get(m.db);
  if (!h) return false;
  return (m.begin !== undefined && (m.begin.mode === "versionchange" || h.beginIsAsync(m.begin))) || m.ops.some((op) => op.o === "mkStore" || op.o === "mkIndex" || op.o === "rmIndex");
}

async function txAsync(m: TxMessage): Promise<TxReply> {
  const h = hosts.get(m.db);
  if (!h) throw new IdbError("InvalidStateError", `plateau: database ${m.db} is not open`);
  if (m.begin) await h.begin(m.tx, m.begin);
  const res: unknown[] = [];
  const errs: [number, string, string][] = [];
  for (const op of m.ops) {
    if (op.o !== "mkStore" && op.o !== "mkIndex" && op.o !== "rmIndex") h.run(m.tx, op, res, errs);
    else {
      try {
        if (op.o === "mkStore") await h.createStore(m.tx, op.def);
        else await h.changeIndex(m.tx, op);
      } catch (e) {
        const x = e instanceof IdbError ? e : new IdbError("UnknownError", e instanceof Error ? e.message : String(e));
        errs.push([res.length, x.name, x.message]);
      }
      res.push(undefined);
    }
  }
  return finishTx(h, m, res, errs);
}

function txSync(m: TxMessage): TxReply {
  const h = hosts.get(m.db);
  if (!h) throw new IdbError("InvalidStateError", `plateau: database ${m.db} is not open`);
  if (m.begin && m.begin.mode !== "readonly") h.txStores.set(m.tx, new Set());
  const res: unknown[] = [];
  const errs: [number, string, string][] = [];
  for (const op of m.ops) h.run(m.tx, op, res, errs);
  return finishTx(h, m, res, errs);
}

function finishTx(h: DatabaseHost, m: TxMessage, res: unknown[], errs: [number, string, string][]): TxReply {
  if (errs.length && h.txStores.has(m.tx)) h.failed.add(m.tx);
  const reply: TxReply = { t: "tx", tx: m.tx, res, errs };
  if (m.end === "commitIfClean" && h.failed.has(m.tx)) {
    reply.end = { ok: false, name: "Deferred", message: "a request failed" };
    return reply;
  }
  if (m.end) h.failed.delete(m.tx);
  if (m.end === "abort") {
    h.abort(m.tx);
    reply.end = { ok: true };
  } else if (m.end) {
    try {
      h.commit(m.tx);
      reply.end = { ok: true };
    } catch (e) {
      h.abort(m.tx);
      const err = e instanceof IdbError ? e : new IdbError("UnknownError", e instanceof Error ? e.message : String(e));
      reply.end = { ok: false, name: err.name, message: err.message };
    }
  }
  return reply;
}

function failure(err: unknown): IdbError {
  if (err instanceof IdbError) return err;
  console.error(err);
  return new IdbError("UnknownError", err instanceof Error ? err.message : String(err));
}

function txFailed(m: TxMessage, err: unknown): TxReply {
  const x = failure(err);
  return { t: "tx", tx: m.tx, res: [], errs: [], end: { ok: false, name: x.name, message: x.message } };
}

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

/** Handles one message; returns a promise when it had to wait, and then messages queue behind it. */
function handle(m: { t: string } & Record<string, any>): Promise<void> | void {
  if (m.t === "tx") {
    if (!txIsAsync(m as TxMessage) && memory) {
      let reply: TxReply;
      try {
        reply = txSync(m as TxMessage);
      } catch (err) {
        reply = txFailed(m as TxMessage, err);
      }
      post(reply);
      return;
    }
    return txAsync(m as TxMessage).then(post, (err) => post(txFailed(m as TxMessage, err)));
  }
  return call(m as CallMessage).then(
    (value) => post({ t: "call", id: m.id, ok: true, value } satisfies CallReply),
    (err) => {
      const x = failure(err);
      post({ t: "call", id: m.id, ok: false, name: x.name, message: x.message } satisfies CallReply);
    },
  );
}

let busy = false;
const queue: ({ t: string } & Record<string, any>)[] = [];

function drain(): void {
  while (!busy && queue.length) {
    const r = handle(queue.shift()!);
    if (r) {
      busy = true;
      void r.finally(() => {
        busy = false;
        drain();
      });
    }
  }
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data as { t: string } & Record<string, any>;
  if (m.t === "init") {
    try {
      memory = initSync({ module: m.module }).memory;
    } catch (e) {
      // Say a browser without WebAssembly SIMD: the page falls back to its own IndexedDB.
      const message = `plateau: the engine does not start here: ${e instanceof Error ? e.message : String(e)}`;
      markFailed(new IdbError("NotSupportedError", message));
      post({ t: "init", error: message });
      return;
    }
    setMemoryBudget(defaultBudget());
    markReady();
    post({ t: "init" });
    return;
  }
  queue.push(m);
  drain();
};

