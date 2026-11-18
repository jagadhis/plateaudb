// The IndexedDB fallback: where plateau's engine cannot run (see backend.ts), `plateau` hands every
// call to the browser's own `indexedDB`. The objects an app gets are the browser's own; plateau's
// additions are set as own properties on them, so the browser's prototypes stay untouched:
// - `db.observe(stores, callback)`: after a readwrite transaction that opened one of `stores`
//   commits, in this tab or another (BroadcastChannel);
// - `db.compact()`, and the factory's `setMemoryBudget` and `memoryStats`: do nothing;
// - `store.query(q)`: plateau's multi-key query, run over the store's records (a native index on
//   the field of an `eq` filter narrows the read), with plateau's result order: the `orderBy`
//   field, then the primary key; primary key order without `orderBy`;
// - `createObjectStore(name, { columns })`: the browser ignores `columns`, so fields are not
//   checked against their declared kinds.

import type { PlateauChange } from "./facade";
import { cmp } from "./key";

const CHANNEL = "plateau/fallback/changed";

const instrumented = new WeakSet<object>();
const closed = new WeakSet<IDBDatabase>();

interface Observer {
  stores: Set<string>;
  callback: (change: PlateauChange) => void;
}

/** Connections of this tab with observers, by database name. */
const observed = new Map<string, Map<IDBDatabase, Set<Observer>>>();

let channel: BroadcastChannel | null | undefined;

function hub(): BroadcastChannel | null {
  if (channel === undefined) {
    channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : null;
    if (channel) channel.onmessage = (e) => notify((e.data as { db: string }).db, (e.data as { stores: string[] }).stores);
  }
  return channel;
}

function notify(name: string, stores: string[]): void {
  for (const observers of observed.get(name)?.values() ?? []) {
    for (const o of observers) {
      const hit = stores.filter((s) => o.stores.has(s));
      if (!hit.length) continue;
      try {
        o.callback({ stores: hit });
      } catch (e) {
        reportError(e);
      }
    }
  }
}

function forget(db: IDBDatabase): void {
  closed.add(db);
  const m = observed.get(db.name);
  m?.delete(db);
  if (m && !m.size) observed.delete(db.name);
}

function own(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, { value, configurable: true, writable: true, enumerable: false });
}

// The browser's methods, taken when first needed: the module also loads where there is no
// IndexedDB (server rendering).
let protoCache: ReturnType<typeof protos> | null = null;
const protos = () => ({
  transaction: IDBDatabase.prototype.transaction,
  createObjectStore: IDBDatabase.prototype.createObjectStore,
  close: IDBDatabase.prototype.close,
  objectStore: IDBTransaction.prototype.objectStore,
  getAll: IDBObjectStore.prototype.getAll,
  getAllKeys: IDBObjectStore.prototype.getAllKeys,
  index: IDBObjectStore.prototype.index,
  result: Object.getOwnPropertyDescriptor(IDBRequest.prototype, "result")!.get!,
});
const proto = () => (protoCache ??= protos());

function instrumentDb(db: IDBDatabase): void {
  if (instrumented.has(db)) return;
  instrumented.add(db);
  own(db, "transaction", function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
    const tx = proto().transaction.apply(this, args);
    instrumentTx(tx);
    return tx;
  });
  own(db, "createObjectStore", function (this: IDBDatabase, ...args: Parameters<IDBDatabase["createObjectStore"]>) {
    const s = proto().createObjectStore.apply(this, args);
    instrumentStore(s);
    return s;
  });
  own(db, "close", function (this: IDBDatabase) {
    forget(this);
    proto().close.call(this);
  });
  own(db, "observe", function (this: IDBDatabase, stores: string | Iterable<string>, callback: (change: PlateauChange) => void) {
    if (closed.has(this)) throw new DOMException("The connection is closed.", "InvalidStateError");
    if (typeof callback !== "function") throw new TypeError("plateau: observe needs a callback.");
    hub();
    const o: Observer = { stores: new Set(typeof stores === "string" ? [stores] : [...stores].map(String)), callback };
    let m = observed.get(this.name);
    if (!m) observed.set(this.name, (m = new Map()));
    let set = m.get(this);
    if (!set) m.set(this, (set = new Set()));
    set.add(o);
    return () => {
      set.delete(o);
    };
  });
  own(db, "compact", async function (this: IDBDatabase) {
    if (closed.has(this)) throw new DOMException("The connection is closed.", "InvalidStateError");
  });
  // The browser closed the connection (say its storage was cleared).
  db.addEventListener("close", () => forget(db));
}

function instrumentTx(tx: IDBTransaction): void {
  if (instrumented.has(tx)) return;
  instrumented.add(tx);
  const opened = new Set<string>();
  own(tx, "objectStore", function (this: IDBTransaction, name: string) {
    const s = proto().objectStore.call(this, name);
    instrumentStore(s);
    opened.add(s.name);
    return s;
  });
  if (tx.mode !== "readwrite") return;
  tx.addEventListener("complete", () => {
    if (!opened.size) return;
    const stores = [...opened];
    const name = tx.db.name;
    notify(name, stores);
    hub()?.postMessage({ db: name, stores });
  });
}

function instrumentStore(s: IDBObjectStore): void {
  if (instrumented.has(s)) return;
  instrumented.add(s);
  own(s, "query", function (this: IDBObjectStore, q: Query) {
    return query(this, q);
  });
}

/** Adds plateau's calls to the connection and the upgrade transaction an open request delivers,
 * before the app's listeners see them. */
export function instrumentOpen(r: IDBOpenDBRequest): void {
  r.addEventListener("upgradeneeded", () => {
    instrumentDb(r.result);
    if (r.transaction) instrumentTx(r.transaction);
  });
  r.addEventListener("success", () => {
    const db = proto().result.call(r);
    if (db instanceof IDBDatabase) instrumentDb(db);
  });
}

// store.query

type Cond = { op: "eq"; value: number } | { op: "in"; values: number[] } | { op: "range"; gt?: number; gte?: number; lt?: number; lte?: number };
type Filter = { field: string } & Cond;

interface Query {
  where?: Filter[];
  orderBy?: { field: string; desc?: boolean };
  limit?: number;
  count?: boolean;
}

/** A test of one stored value; an array (a `u32_multi` column) matches when an element does. */
function test(f: Filter): (x: unknown) => boolean {
  let one: (x: number) => boolean;
  switch (f.op) {
    case "eq": {
      const v = Number(f.value);
      one = (x) => x === v;
      break;
    }
    case "in": {
      const set = new Set((f.values ?? []).map(Number));
      one = (x) => set.has(x);
      break;
    }
    case "range": {
      const { gt, gte, lt, lte } = f;
      if ([gt, gte, lt, lte].some((b) => b !== undefined && b !== null && Number.isNaN(Number(b)))) return () => false;
      const has = (b: number | undefined): b is number => b !== undefined && b !== null;
      one = (x) => (!has(gt) || x > gt) && (!has(gte) || x >= gte) && (!has(lt) || x < lt) && (!has(lte) || x <= lte);
      break;
    }
    default:
      throw new TypeError(`plateau: unknown query op ${String((f as { op?: unknown }).op)}.`);
  }
  return (x) => {
    if (typeof x === "number") return !Number.isNaN(x) && one(x);
    if (Array.isArray(x)) return x.some((y) => typeof y === "number" && one(y));
    return false;
  };
}

function field(v: unknown, name: string): unknown {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>)[name] : undefined;
}

/** plateau's query over `values` (in primary key order, keys in `keys`). */
function run(q: Query, keys: IDBValidKey[], values: unknown[], tests: [string, (x: unknown) => boolean][]): unknown[] | number {
  let rows: number[] = [];
  for (let i = 0; i < values.length; i++) if (tests.every(([f, t]) => t(field(values[i], f)))) rows.push(i);
  if (q.count) return rows.length;
  const o = q.orderBy;
  if (o) {
    const dir = o.desc ? -1 : 1;
    const at = (i: number) => {
      const x = field(values[i], o.field);
      return typeof x === "number" && !Number.isNaN(x) ? x : null;
    };
    rows = rows.sort((a, b) => {
      const x = at(a);
      const y = at(b);
      if (x === null || y === null) return x === y ? cmp(keys[a], keys[b]) : x === null ? 1 : -1;
      return dir * (x - y || cmp(keys[a], keys[b]));
    });
  }
  if (q.limit !== undefined && q.limit !== null) rows = rows.slice(0, Math.max(0, Math.floor(Number(q.limit))));
  return rows.map((i) => values[i]);
}

/** Returns the browser's request for the values it reads, its `result` replaced by the query's and
 * a `plan`: `scan`, or `index:<name>` when a native index on an `eq` filter's field narrowed it. */
function query(s: IDBObjectStore, q: Query): IDBRequest {
  if (q === null || typeof q !== "object") throw new TypeError("plateau: query takes an object.");
  const where = q.where ?? [];
  if (!Array.isArray(where)) throw new TypeError("plateau: query's where must be an array.");
  const tests = where.map((f) => [String(f.field), test(f)] as [string, (x: unknown) => boolean]);
  let source: IDBObjectStore | IDBIndex = s;
  let range: number | undefined;
  let plan = "scan";
  for (const f of where) {
    if (f.op !== "eq" || typeof f.value !== "number" || Number.isNaN(f.value)) continue;
    const idx = [...s.indexNames].map((n) => proto().index.call(s, n)).find((i) => i.keyPath === f.field && i.multiEntry);
    if (!idx) continue;
    source = idx;
    range = f.value;
    plan = `index:${idx.name}`;
    break;
  }
  const keysReq = source instanceof IDBIndex ? source.getAllKeys(range) : proto().getAllKeys.call(s);
  const valuesReq = source instanceof IDBIndex ? source.getAll(range) : proto().getAll.call(s);
  let keys: IDBValidKey[] = [];
  let out: unknown;
  keysReq.addEventListener("success", () => (keys = keysReq.result));
  valuesReq.addEventListener("success", () => {
    out = run(q, keys, proto().result.call(valuesReq) as unknown[], tests);
  });
  Object.defineProperty(valuesReq, "result", {
    configurable: true,
    get() {
      proto().result.call(valuesReq);
      return out;
    },
  });
  own(valuesReq, "plan", plan);
  return valuesReq;
}
