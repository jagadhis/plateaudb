// plateau's IndexedDB-compatible API on the main thread: factory, connections, transactions,
// object stores, indexes, cursors and requests, with IndexedDB's validation, events and
// transaction lifecycle. Values are cloned (encoded) and keys validated and encoded here, at the
// call; the work runs in the worker (`worker.ts`), one message per transaction per tick.
//
// Lifecycle as implemented:
// - A transaction is active from its creation until the end of the task that created it (and its
//   microtasks), and while its request results are delivered. Results arriving in one message are
//   delivered in one go, then the transaction stays active until the end of that task.
// - It starts (its requests go to the worker) once every earlier unfinished transaction of the same
//   database whose scope overlaps it is finished, unless both are readonly.
// - It commits when it is inactive and has no request pending. When every pending request has no
//   listener, the commit is sent with them, and the worker commits only if none of them failed.

import { chooseBackend, chosenBackend, nativeIndexedDB, type Backend } from "./backend";
import { dispatch, handlers, PlateauEvent, PlateauTarget, PlateauVersionChangeEvent } from "./events";
import { instrumentOpen } from "./fallback";
import {
  canInjectKey,
  cmp,
  dataError,
  decodeKey,
  encodeKey,
  extractKey,
  normalizeKeyPath,
  PlateauKeyRange,
  requireKey,
  spelledKey,
  toRange,
  validKeyPath,
  type Key,
  type KeyPath,
  type WireRange,
} from "./key";
import type { ColumnDecl, ColumnKind, CursorHit, Direction, IndexDef, MemoryStats, Op, PutRow, StoreDef, TxMessage, TxReply } from "./protocol";
import { onChange, onVersionChange, runtime, type VersionChangeAck, type VersionChangeWait } from "./runtime";
import { scheduler } from "./scheduler";
import { encodeValue } from "./value";

const err = (name: string, message: string) => new DOMException(message, name);

/** Runs `fn` in a new task, after the current task and all its microtasks: on a message channel,
 * and, in browsers that run a zero timeout set in the same task before a posted message (WebKit),
 * also on a zero timeout, whichever runs first. A timeout the page sets after this call then sees
 * `fn`'s effect, as it sees a transaction become inactive natively. The first call finds out which
 * the browser runs first. */
const afterTask = (() => {
  let queue: (() => void)[] = [];
  let ch: MessageChannel | null = null;
  let armed = false;
  let timerFirst: boolean | null = null;
  const run = (byTimer: boolean) => {
    if (!armed) return;
    timerFirst ??= byTimer;
    armed = false;
    const q = queue;
    queue = [];
    for (const f of q) f();
  };
  return (fn: () => void) => {
    if (!ch) {
      ch = new MessageChannel();
      ch.port1.onmessage = () => run(false);
    }
    queue.push(fn);
    if (!armed) {
      armed = true;
      ch.port2.postMessage(0);
      if (timerFirst !== false) setTimeout(() => run(true), 0);
    }
  };
})();

export type StringList = string[] & { contains(s: string): boolean; item(i: number): string | null };

function stringList(names: Iterable<string>): StringList {
  const a = [...names].sort() as StringList;
  a.contains = (s: string) => a.includes(String(s));
  a.item = (i: number) => a[i] ?? null;
  return a;
}

// Requests.

type ResultKind = "value" | "key" | "keys" | "values" | "count" | "none" | "cursor" | "query" | "records";

/** Entries a readonly cursor asks for beyond the one it steps to; later steps are answered from them. */
const PREFETCH = 32;

export class PlateauRequest extends PlateauTarget {
  /** @internal */ _result: unknown = undefined;
  /** @internal */ _error: DOMException | null = null;
  /** @internal */ _done = false;
  /** @internal */ kind: ResultKind;
  /** @internal */ cursor: PlateauCursor | null = null;
  source: unknown;
  transaction: PlateauTransaction | null;
  /** For `query`: the plan the engine chose. */
  plan: string | undefined;
  /** @internal A put's key when the caller gave it (the worker then answers nothing). */
  known: unknown = undefined;

  constructor(source: unknown, transaction: PlateauTransaction | null, kind: ResultKind) {
    super();
    this.source = source;
    this.transaction = transaction;
    this.kind = kind;
  }

  get readyState(): "pending" | "done" {
    return this._done ? "done" : "pending";
  }

  get result(): any {
    if (!this._done) throw err("InvalidStateError", "The request has not finished.");
    return this._result;
  }

  get error(): DOMException | null {
    if (!this._done) throw err("InvalidStateError", "The request has not finished.");
    return this._error;
  }

  /** @internal */
  parentTarget(): PlateauTarget | null {
    return this.transaction;
  }
}
handlers(PlateauRequest, ["success", "error"]);

export interface PlateauRequest {
  onsuccess: ((e: PlateauEvent) => unknown) | null;
  onerror: ((e: PlateauEvent) => unknown) | null;
}

export class PlateauOpenDBRequest extends PlateauRequest {
  constructor() {
    super(null, null, "value");
  }
}
handlers(PlateauOpenDBRequest, ["blocked", "upgradeneeded"]);

export interface PlateauOpenDBRequest {
  onblocked: ((e: PlateauVersionChangeEvent) => unknown) | null;
  onupgradeneeded: ((e: PlateauVersionChangeEvent) => unknown) | null;
}

/** A promise for a request's result. */
export function promise<T = any>(r: PlateauRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    r.addEventListener("success", () => resolve(r.result));
    r.addEventListener("error", () => reject(r.error));
  });
}

// Factory and connections.

const connections = new Map<string, Set<PlateauDatabase>>();

/** Runs `job` once every earlier open and deleteDatabase of `name`, in this tab or another, has
 * finished. */
function enqueue(name: string, job: () => Promise<void>): void {
  runtime().queue(name, job);
}

function toVersion(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > Number.MAX_SAFE_INTEGER) throw new TypeError("The version must be a positive integer.");
  return Math.floor(n);
}

/** Fires versionchange at this tab's open connections to `name` other than `self`. `oldVersion`
 * is null for a deleteDatabase: its events carry the connections' version. */
function versionChangeHere(name: string, self: PlateauDatabase | null, oldVersion: number | null, newVersion: number | null): VersionChangeWait | null {
  const others = [...(connections.get(name) ?? [])].filter((c) => c !== self && !c._closePending);
  for (const c of others) {
    if (c._closePending) continue;
    dispatch(c, new PlateauVersionChangeEvent("versionchange", { oldVersion: oldVersion ?? c._version, newVersion }));
  }
  const open = others.filter((c) => !c._closed);
  if (!open.length) return null;
  return {
    ack: { blocking: open.some((c) => !c._closePending), version: open[0]._version },
    closed: Promise.all(open.map((c) => c._closedPromise)).then(() => {}),
  };
}

onVersionChange((name, oldVersion, newVersion) => versionChangeHere(name, null, oldVersion, newVersion));

/** Waits for other connections to `name`, in this tab and others, to close, after telling them
 * about the version change. */
async function closeOthers(name: string, self: PlateauDatabase | null, oldVersion: number | null, newVersion: number | null, req: PlateauOpenDBRequest): Promise<void> {
  const here = versionChangeHere(name, self, oldVersion, newVersion);
  const elsewhere = runtime().versionChange(name, oldVersion, newVersion);
  let ack = here?.ack as VersionChangeAck | undefined;
  if (!ack?.blocking && elsewhere) {
    const remote = await elsewhere.ack;
    ack = { blocking: remote.blocking, version: Math.max(ack?.version ?? 0, remote.version) };
  }
  if (ack?.blocking) dispatch(req, new PlateauVersionChangeEvent("blocked", { oldVersion: oldVersion ?? ack.version, newVersion }));
  await Promise.all([here?.closed, elsewhere?.closed]);
}

/** What `PlateauDatabase.observe` calls back with: the observed stores the transaction wrote. */
export interface PlateauChange {
  stores: string[];
}

interface Observer {
  stores: Set<string>;
  callback: (change: PlateauChange) => void;
}

/** Calls the observers of `stores` on this tab's open connections to `name`. */
function changed(name: string, stores: string[]): void {
  for (const c of connections.get(name) ?? []) {
    if (c._closePending) continue;
    for (const o of c._observers) {
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

onChange(changed);

function finishRequest(req: PlateauRequest, result: unknown, error: DOMException | null): void {
  req._done = true;
  req._result = result;
  req._error = error;
}

/** An open or deleteDatabase made before the backend was chosen, that ran on the browser's
 * IndexedDB: it passes on the browser's request's events and state. */
class BridgedRequest extends PlateauOpenDBRequest {
  /** @internal */
  parentTarget(): PlateauTarget | null {
    return null;
  }
}

function bridge(req: PlateauOpenDBRequest, nat: IDBOpenDBRequest): void {
  const b = req as BridgedRequest;
  Object.setPrototypeOf(b, BridgedRequest.prototype);
  const settle = () => {
    b._done = true;
    b._result = nat.result;
    b._error = nat.error;
  };
  nat.addEventListener("upgradeneeded", (e) => {
    settle();
    b.transaction = nat.transaction as unknown as PlateauTransaction;
    const out = dispatch(b, new PlateauVersionChangeEvent("upgradeneeded", { oldVersion: e.oldVersion, newVersion: e.newVersion }));
    // As natively: an exception in upgradeneeded aborts the upgrade.
    if (out.threw) nat.transaction?.abort();
  });
  nat.addEventListener("blocked", (e) => {
    dispatch(b, new PlateauVersionChangeEvent("blocked", { oldVersion: e.oldVersion, newVersion: e.newVersion }));
  });
  nat.addEventListener("success", (e) => {
    settle();
    b.transaction = null;
    const v = e as IDBVersionChangeEvent;
    dispatch(b, v.oldVersion === undefined ? new PlateauEvent("success") : new PlateauVersionChangeEvent("success", { oldVersion: v.oldVersion, newVersion: v.newVersion }));
  });
  nat.addEventListener("error", () => {
    settle();
    b.transaction = null;
    dispatch(b, new PlateauEvent("error", { bubbles: true, cancelable: true }));
  });
}

function nativeOpen(name: string, version: number | undefined): IDBOpenDBRequest {
  const r = version === undefined ? nativeIndexedDB!.open(name) : nativeIndexedDB!.open(name, version);
  instrumentOpen(r);
  return r;
}

let fallbackBudget: number | null = null;

export class PlateauFactory {
  /** Which backend runs this page's databases: `"opfs"` (plateau's engine) or `"indexeddb"` (the
   * browser's own, where the engine cannot run); undefined until the first call that needs storage
   * chooses it. It never changes after that. */
  get backend(): Backend | undefined {
    return chosenBackend();
  }

  /** Chooses the backend now if no call has yet, and resolves with it. */
  chooseBackend(): Promise<Backend> {
    return chooseBackend();
  }

  open(name: string, version?: number): PlateauOpenDBRequest {
    const n = String(name);
    const v = toVersion(version);
    const b = chosenBackend() ?? (void chooseBackend(), chosenBackend());
    if (b === "indexeddb") return nativeOpen(n, v) as unknown as PlateauOpenDBRequest;
    const req = new PlateauOpenDBRequest();
    if (b === "opfs") enqueue(n, () => openDatabase(req, n, v));
    else void chooseBackend().then((b) => (b === "opfs" ? enqueue(n, () => openDatabase(req, n, v)) : bridge(req, nativeOpen(n, v))));
    return req;
  }

  deleteDatabase(name: string): PlateauOpenDBRequest {
    const n = String(name);
    const b = chosenBackend() ?? (void chooseBackend(), chosenBackend());
    if (b === "indexeddb") return nativeIndexedDB!.deleteDatabase(n) as unknown as PlateauOpenDBRequest;
    const req = new PlateauOpenDBRequest();
    if (b === "opfs") this.deleteHere(req, n);
    else void chooseBackend().then((b) => (b === "opfs" ? this.deleteHere(req, n) : bridge(req, nativeIndexedDB!.deleteDatabase(n))));
    return req;
  }

  /** @internal */
  private deleteHere(req: PlateauOpenDBRequest, n: string): void {
    enqueue(n, async () => {
      await new Promise<void>((r) => afterTask(r));
      await closeOthers(n, null, null, null, req);
      let old = 0;
      try {
        old = await runtime().call<number>({ t: "delete", db: n });
      } catch (e) {
        finishRequest(req, undefined, e as DOMException);
        dispatch(req, new PlateauEvent("error", { bubbles: true, cancelable: true }));
        return;
      }
      finishRequest(req, undefined, null);
      dispatch(req, new PlateauVersionChangeEvent("success", { oldVersion: old, newVersion: null }));
    });
  }

  cmp(a: unknown, b: unknown): number {
    return cmp(a, b);
  }

  /** On the IndexedDB fallback, the browser's list; plateau's engine does not list its databases yet
   * and resolves with an empty list. */
  async databases(): Promise<{ name: string; version: number }[]> {
    if ((await chooseBackend()) === "indexeddb" && typeof nativeIndexedDB!.databases === "function") {
      return (await nativeIndexedDB!.databases()) as { name: string; version: number }[];
    }
    return [];
  }

  /** plateau's own: resolves when this tab is the leader, the one tab of the origin that runs the
   * worker (at once in a single tab, or when the leader closes and this tab takes over). Work that
   * must run in one tab at a time, such as holding a server stream, waits on it. */
  whenLeader(): Promise<void> {
    return runtime().leading;
  }

  /** plateau's own: sets the memory budget for the sections the runtime keeps loaded, in bytes
   * (null for no limit). Past it, the least recently used are dropped between operations and read
   * again when touched. The default is 64 MiB, or 24 MiB where `navigator.deviceMemory` is 4 or
   * less. */
  async setMemoryBudget(bytes: number | null): Promise<void> {
    if (bytes !== null && !(bytes > 0)) throw new TypeError("plateau: the memory budget must be a positive number of bytes, or null.");
    if ((await chooseBackend()) === "indexeddb") {
      fallbackBudget = bytes;
      return;
    }
    await runtime().call({ t: "budget", bytes });
  }

  /** plateau's own: the runtime's WASM memory (its peak: WASM memory never shrinks), the budget,
   * the bytes loaded sections hold, and the file sizes of database `name` if it is open. On the
   * IndexedDB fallback there is no engine: zeros, and the budget last set. */
  async memoryStats(name?: string): Promise<MemoryStats> {
    if ((await chooseBackend()) === "indexeddb") return { wasmMemoryBytes: 0, budgetBytes: fallbackBudget ?? Infinity, cachedBytes: 0 };
    return runtime().call<MemoryStats>(name === undefined ? { t: "stats" } : { t: "stats", db: String(name) });
  }
}

async function openDatabase(req: PlateauOpenDBRequest, name: string, version: number | undefined): Promise<void> {
  await new Promise<void>((r) => afterTask(r));
  const rt = runtime();
  let info: { version: number; nextId: number; stores: StoreDef[] };
  try {
    info = await rt.call({ t: "open", db: name });
  } catch (e) {
    finishRequest(req, undefined, e as DOMException);
    dispatch(req, new PlateauEvent("error", { bubbles: true, cancelable: true }));
    return;
  }
  const cur = info.version;
  const want = version ?? Math.max(cur, 1);
  if (want < cur) {
    await rt.call({ t: "close", db: name });
    finishRequest(req, undefined, err("VersionError", `The requested version (${want}) is less than the existing version (${cur}).`));
    dispatch(req, new PlateauEvent("error", { bubbles: true, cancelable: true }));
    return;
  }
  const db = new PlateauDatabase(name, cur, info.nextId, info.stores);
  let set = connections.get(name);
  if (!set) connections.set(name, (set = new Set()));
  if (want > cur) {
    await closeOthers(name, db, cur, want, req);
    set.add(db);
    db._version = want;
    const tx = new PlateauTransaction(db, [...db._stores.keys()], "versionchange", want);
    db._upgrade = tx;
    req.transaction = tx;
    finishRequest(req, db, null);
    tx._state = "active";
    tx._settleSoon();
    const out = dispatch(req, new PlateauVersionChangeEvent("upgradeneeded", { oldVersion: cur, newVersion: want }));
    if (out.threw) tx._abort(err("AbortError", "An exception was thrown in the upgradeneeded handler."));
    await tx._finishedPromise();
    db._upgrade = null;
    req.transaction = null;
    if (tx._aborted || db._closePending) {
      db._version = cur;
      if (!db._closePending) db._closeNow();
      finishRequest(req, undefined, err("AbortError", "The upgrade transaction was aborted."));
      dispatch(req, new PlateauEvent("error", { bubbles: true, cancelable: true }));
      return;
    }
  } else set.add(db);
  finishRequest(req, db, null);
  dispatch(req, new PlateauEvent("success"));
}

export class PlateauDatabase extends PlateauTarget {
  readonly name: string;
  /** @internal */ _version: number;
  /** @internal */ _stores = new Map<string, StoreDef>();
  /** @internal */ _nextId: number;
  /** @internal */ _upgrade: PlateauTransaction | null = null;
  /** @internal */ _txs = new Set<PlateauTransaction>();
  /** @internal */ _closePending = false;
  /** @internal */ _observers = new Set<Observer>();
  /** @internal */ _closed = false;
  /** @internal */ _closedPromise: Promise<void>;
  /** @internal */ private markClosed = () => {};

  constructor(name: string, version: number, nextId: number, stores: StoreDef[]) {
    super();
    this.name = name;
    this._version = version;
    this._nextId = nextId;
    for (const s of stores) this._stores.set(s.name, s);
    this._closedPromise = new Promise((r) => (this.markClosed = r));
  }

  get version(): number {
    return this._version;
  }

  get objectStoreNames(): StringList {
    return stringList(this._stores.keys());
  }

  /** @internal */
  upgradeTx(): PlateauTransaction {
    const tx = this._upgrade;
    if (!tx || tx._state === "finished") throw err("InvalidStateError", "Not in a version change transaction.");
    if (tx._state !== "active") throw err("TransactionInactiveError", "The version change transaction is not active.");
    return tx;
  }

  createObjectStore(name: string, options: { keyPath?: KeyPath | null; autoIncrement?: boolean; columns?: unknown } = {}): PlateauObjectStore {
    const tx = this.upgradeTx();
    const n = String(name);
    const keyPath = normalizeKeyPath(options?.keyPath ?? null) as KeyPath | null;
    if (keyPath !== null && !validKeyPath(keyPath)) throw err("SyntaxError", "The keyPath is not a valid key path.");
    if (this._stores.has(n)) throw err("ConstraintError", `An object store named ${n} already exists.`);
    const autoIncrement = !!options?.autoIncrement;
    if (autoIncrement && (keyPath === "" || Array.isArray(keyPath))) throw err("InvalidAccessError", "autoIncrement needs a non-empty, non-array key path.");
    const id = this._nextId++;
    const def: StoreDef = { id, file: `s${id}`, name: n, keyPath, autoIncrement, indexes: [] };
    if (options?.columns !== undefined) def.columns = columnDecls(options.columns, keyPath);
    this._stores.set(n, def);
    tx._scope.push(n);
    tx._internal({ o: "mkStore", def: structuredClone(def) });
    return tx.objectStore(n);
  }

  deleteObjectStore(name: string): void {
    const tx = this.upgradeTx();
    const n = String(name);
    const def = this._stores.get(n);
    if (!def) throw err("NotFoundError", `No object store named ${n}.`);
    this._stores.delete(n);
    tx._scope = tx._scope.filter((s) => s !== n);
    tx._handles.delete(n);
    tx._internal({ o: "rmStore", s: n });
  }

  transaction(names: string | Iterable<string>, mode: IDBTransactionMode = "readonly", options?: { durability?: string }): PlateauTransaction {
    if (this._closePending) throw err("InvalidStateError", "The connection is closed.");
    if (this._upgrade && this._upgrade._state !== "finished") throw err("InvalidStateError", "A version change transaction is running.");
    const list = typeof names === "string" ? [names] : [...names].map(String);
    const scope = [...new Set(list)];
    for (const s of scope) if (!this._stores.has(s)) throw err("NotFoundError", `No object store named ${s}.`);
    if (mode !== "readonly" && mode !== "readwrite") throw new TypeError(`The mode ${String(mode)} is not valid.`);
    if (!scope.length) throw err("InvalidAccessError", "The scope is empty.");
    const tx = new PlateauTransaction(this, scope, mode);
    tx.durability = options?.durability ?? "default";
    tx._settleSoon();
    return tx;
  }

  close(): void {
    if (this._closePending) return;
    this._closePending = true;
    this._maybeClosed();
  }

  /** plateau's own: calls `callback` after each readwrite transaction that wrote one of `stores`
   * commits, in this tab or any other tab of the origin, with the observed stores it wrote. Reads
   * started in the callback see that commit. Returns a function that stops the calls; closing the
   * connection stops them too. */
  observe(stores: string | Iterable<string>, callback: (change: PlateauChange) => void): () => void {
    if (this._closePending) throw err("InvalidStateError", "The connection is closed.");
    if (typeof callback !== "function") throw new TypeError("plateau: observe needs a callback.");
    const o: Observer = { stores: new Set(typeof stores === "string" ? [stores] : [...stores].map(String)), callback };
    this._observers.add(o);
    return () => {
      this._observers.delete(o);
    };
  }

  /** plateau's own: rewrites every object store's file without its deleted and replaced rows,
   * into free space where it fits, and cuts the file's free tail. Waits for this connection's
   * running transactions to finish first; rejects with InvalidStateError if the connection is
   * closing or another connection's readwrite transaction is running. */
  async compact(): Promise<void> {
    if (this._closePending) throw err("InvalidStateError", "The connection is closed.");
    while (this._txs.size) await Promise.all([...this._txs].map((tx) => tx._finishedPromise().catch(() => {})));
    if (this._closePending) throw err("InvalidStateError", "The connection is closed.");
    await runtime().call({ t: "compact", db: this.name });
  }

  /** @internal */
  _closeNow(): void {
    this._closePending = true;
    this._maybeClosed();
  }

  /** @internal */
  _maybeClosed(): void {
    if (!this._closePending || this._closed || this._txs.size) return;
    this._closed = true;
    connections.get(this.name)?.delete(this);
    void runtime()
      .call({ t: "close", db: this.name })
      .finally(() => this.markClosed());
  }
}
handlers(PlateauDatabase, ["abort", "close", "error", "versionchange"]);

export interface PlateauDatabase {
  onabort: ((e: PlateauEvent) => unknown) | null;
  onclose: ((e: PlateauEvent) => unknown) | null;
  onerror: ((e: PlateauEvent) => unknown) | null;
  onversionchange: ((e: PlateauVersionChangeEvent) => unknown) | null;
}

const KINDS: ColumnKind[] = ["u32", "u32_multi", "f64", "str"];

function columnDecls(spec: unknown, keyPath: KeyPath | null): ColumnDecl[] {
  const entries: [string, unknown][] = Array.isArray(spec) ? spec.map((c) => [String((c as ColumnDecl).name), c]) : Object.entries(spec as object);
  const out: ColumnDecl[] = entries.map(([name, c]) => {
    const d: Partial<ColumnDecl> = typeof c === "string" ? { kind: c as ColumnKind } : (c as Partial<ColumnDecl>);
    if (!KINDS.includes(d.kind as ColumnKind)) throw new TypeError(`plateau: column ${name} has an unknown kind ${String(d.kind)}.`);
    if (name.startsWith("_") || name.includes(".")) throw new TypeError(`plateau: column ${name} must be a plain field name not starting with _.`);
    const decl: ColumnDecl = { name, kind: d.kind as ColumnKind };
    if (d.index) decl.index = d.index;
    if (d.group) decl.group = d.group;
    return decl;
  });
  const pk = out.find((c) => c.name === keyPath);
  if (typeof keyPath !== "string" || !pk || pk.kind !== "f64") throw new TypeError("plateau: a store with columns needs a key path naming one of them, of kind f64.");
  return out;
}

// Transactions.

type Pending = PlateauRequest | null;

export class PlateauTransaction extends PlateauTarget {
  readonly db: PlateauDatabase;
  readonly mode: IDBTransactionMode;
  durability = "default";
  /** @internal */ _scope: string[];
  /** @internal */ _state: "active" | "inactive" | "committing" | "finished" = "active";
  /** @internal */ _started = false;
  /** @internal */ _aborted = false;
  /** @internal */ _error: DOMException | null = null;
  /** @internal */ _handles = new Map<string, PlateauObjectStore>();
  /** @internal Made on first ask: most transactions are never awaited this way. */ private finished: Promise<void> | null = null;
  /** @internal */ private markFinished: (() => void) | null = null;
  /** @internal */ private isFinished = false;
  /** @internal */ private id: number;
  /** @internal */ private version: number | undefined;
  /** @internal */ private began = false;
  /** @internal */ private unsent: Op[] = [];
  /** @internal */ private unsentReqs: Pending[] = [];
  /** @internal Requests sent and not answered, from `head` on. */ private inflight: Pending[] = [];
  /** @internal */ private head = 0;
  /** @internal */ private flushQueued = false;
  /** @internal */ private settleQueued = false;
  /** @internal */ private commitSent = false;
  /** @internal */ private beforeUpgrade: Map<string, StoreDef> | null = null;
  /** @internal */ private nextIdBefore = 0;
  /** @internal Stores a readwrite transaction wrote, for observers. */ private written: Set<string> | null = null;

  constructor(db: PlateauDatabase, scope: string[], mode: IDBTransactionMode, version?: number) {
    super();
    this.db = db;
    this.mode = mode;
    this._scope = [...scope].sort();
    this.version = version;
    const rt = runtime();
    this.id = rt.nextTx++;
    rt.txs.set(this.id, this);
    db._txs.add(this);
    if (mode === "versionchange") {
      this.beforeUpgrade = new Map([...db._stores].map(([k, v]) => [k, structuredClone(v)]));
      this.nextIdBefore = db._nextId;
    }
    scheduler(db.name).add(this);
  }

  get objectStoreNames(): StringList {
    return stringList(this._scope);
  }

  get error(): DOMException | null {
    return this._error;
  }

  /** Resolves on complete, rejects on abort. */
  get done(): Promise<void> {
    return this._finishedPromise().then(() => {
      if (this._aborted) throw this._error ?? err("AbortError", "The transaction was aborted.");
    });
  }

  /** @internal */
  parentTarget(): PlateauTarget | null {
    return this.db;
  }

  /** @internal Resolves once the transaction has finished (complete or abort). */
  _finishedPromise(): Promise<void> {
    if (this.isFinished) return Promise.resolve();
    this.finished ??= new Promise((r) => (this.markFinished = r));
    return this.finished;
  }

  objectStore(name: string): PlateauObjectStore {
    if (this._state === "finished") throw err("InvalidStateError", "The transaction has finished.");
    const n = String(name);
    if (!this._scope.includes(n) || !this.db._stores.has(n)) throw err("NotFoundError", `No object store named ${n} in this transaction.`);
    let h = this._handles.get(n);
    if (!h || h._def !== this.db._stores.get(n)) {
      h = new PlateauObjectStore(this, this.db._stores.get(n)!);
      this._handles.set(n, h);
    }
    return h;
  }

  abort(): void {
    if (this._state === "finished" || this._state === "committing") throw err("InvalidStateError", "The transaction has finished or is committing.");
    this._abort(null);
  }

  commit(): void {
    if (this._state !== "active") throw err("InvalidStateError", "The transaction is not active.");
    this._state = "inactive";
    this.settle(true);
  }

  /** @internal Checks a request can be made now. */
  _check(write: boolean): void {
    if (this._state !== "active") throw err("TransactionInactiveError", "The transaction is not active.");
    if (write && this.mode === "readonly") throw err("ReadOnlyError", "The transaction is read-only.");
  }

  /** @internal Queues an operation and the requests its results go to. */
  _issue(op: Op, req: Pending): void {
    this.unsent.push(op);
    this.queued(req);
  }

  /** @internal Queues a point get, joining the previous point gets of the same store. */
  _issueGet(s: string, key: string, req: PlateauRequest): void {
    const last = this.unsent[this.unsent.length - 1];
    if (last !== undefined && last.o === "get" && last.s === s) last.ks.push(key);
    else this.unsent.push({ o: "get", s, ks: [key] });
    this.queued(req);
  }

  /** @internal Queues a put, joining the previous puts of the same store. */
  _issuePut(s: string, row: PutRow, req: PlateauRequest): void {
    const last = this.unsent[this.unsent.length - 1];
    if (last !== undefined && last.o === "put" && last.s === s) last.rows.push(row);
    else this.unsent.push({ o: "put", s, rows: [row] });
    this.queued(req);
  }

  /** @internal Queues a put into a typed store, joining the previous ones of the same store as
   * columns. */
  _issueTyped(def: StoreDef, t: unknown[], rest: string, add: boolean, gen: boolean, req: PlateauRequest): void {
    let last = this.unsent[this.unsent.length - 1] as TypedPuts | undefined;
    if (last === undefined || last.o !== "tput" || last.s !== def.name) {
      last = { o: "tput", s: def.name, n: 0, cols: def.columns!.map((c) => (c.kind === "u32_multi" ? [[0], []] : [])), v: null, add: [], gen: [] };
      this.unsent.push(last as unknown as Op);
    }
    const cols = def.columns!;
    for (let i = 0; i < cols.length; i++) {
      const b = last.cols[i];
      if (cols[i].kind === "u32_multi") {
        const [offsets, values] = b as [number[], number[]];
        for (const x of t[i] as number[]) values.push(x);
        offsets.push(values.length);
      } else (b as unknown[]).push(t[i]);
    }
    if (rest !== "" && last.v === null) last.v = new Array(last.n).fill("");
    if (last.v !== null) last.v.push(rest);
    if (add) last.add.push(last.n);
    if (gen) last.gen.push(last.n);
    last.n++;
    this.queued(req);
  }

  /** @internal Queues a delete of one number key of a typed store, joining the previous ones. */
  _issueDeleteNumber(s: string, key: number, req: PlateauRequest): void {
    const last = this.unsent[this.unsent.length - 1];
    if (last !== undefined && last.o === "delk" && last.s === s && last.nums !== undefined) last.nums.push(key);
    else this.unsent.push({ o: "delk", s, ks: [], nums: [key] });
    this.queued(req);
  }

  /** @internal Queues a delete of one key, joining the previous ones of the same store. */
  _issueDelete(s: string, key: string, req: PlateauRequest): void {
    const last = this.unsent[this.unsent.length - 1];
    if (last !== undefined && last.o === "delk" && last.s === s && last.nums === undefined) last.ks.push(key);
    else this.unsent.push({ o: "delk", s, ks: [key] });
    this.queued(req);
  }

  private queued(req: Pending): void {
    this.unsentReqs.push(req);
    if (!this.flushQueued) {
      this.flushQueued = true;
      queueMicrotask(() => this.flush());
    }
  }

  /** @internal Cursor steps answered from prefetched entries, waiting for their microtask. */
  private local = new Set<PlateauRequest>();

  /** @internal Answers a cursor step from what the cursor prefetched, as a worker reply would. */
  _local(req: PlateauRequest, hit: CursorHit | null): void {
    this.local.add(req);
    queueMicrotask(() => {
      this.local.delete(req);
      if (this._state === "finished") return;
      this._state = "active";
      this._settleSoon();
      this.deliver(req, hit, false);
    });
  }

  /** @internal A schema operation of an upgrade: no request, but its failure aborts. */
  _internal(op: Op): void {
    this._issue(op, null);
  }

  /** @internal Called by the scheduler. */
  _start(): void {
    this._started = true;
    this.flush();
    this.settle(false);
  }

  /** @internal Ends the active period at the end of the current task. */
  _settleSoon(): void {
    if (this.settleQueued) return;
    this.settleQueued = true;
    afterTask(() => {
      this.settleQueued = false;
      if (this._state === "active") this._state = "inactive";
      this.settle(false);
    });
  }

  private message(ops: Op[], end?: TxMessage["end"]): TxMessage {
    const m: TxMessage = { t: "tx", tx: this.id, db: this.db.name, ops };
    if (!this.began) {
      this.began = true;
      m.begin = { mode: this.mode as "readonly", stores: this._scope, version: this.version };
    }
    if (end) m.end = end;
    return m;
  }

  private flush(): void {
    this.flushQueued = false;
    if (!this._started || this._state === "finished" || !this.unsent.length) return;
    const ops = this.unsent;
    this.unsent = [];
    const transfer: Transferable[] = [];
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i].o;
      if (o === "put" || o === "tput" || o === "del" || o === "delk" || o === "clear") (this.written ??= new Set()).add((ops[i] as { s: string }).s);
      if (o === "tput") ops[i] = wireTyped(ops[i] as unknown as TypedPuts, this.db._stores.get((ops[i] as { s: string }).s)!, transfer);
    }
    if (this.head === this.inflight.length) {
      this.inflight = this.unsentReqs;
      this.head = 0;
    } else for (const r of this.unsentReqs) this.inflight.push(r);
    this.unsentReqs = [];
    runtime().post(this.message(ops), transfer);
  }

  /** Commits when nothing more can be asked. */
  private settle(explicit: boolean): void {
    if (this._state !== "inactive" || !this._started || this.commitSent) return;
    if (this.unsent.length) this.flush();
    if (this.local.size) return;
    if (this.head === this.inflight.length) {
      this.commitSent = true;
      this._state = "committing";
      // A readonly transaction leaves nothing in the worker to commit.
      if (this.mode === "readonly") {
        if (explicit) afterTask(() => this.complete());
        else this.complete();
      }
      else runtime().post(this.message([], "commit"));
      return;
    }
    if (this.mode === "readonly") return;
    // Nothing listens for the pending results' success: no code can run before the commit, so it
    // goes now; the worker commits only if every request succeeded.
    if (explicit || this.quiet()) {
      this.commitSent = true;
      this._state = "committing";
      runtime().post(this.message([], explicit ? "commit" : "commitIfClean"));
    }
  }

  /** Whether no pending request has a listener. */
  private quiet(): boolean {
    for (let i = this.head; i < this.inflight.length; i++) {
      const r = this.inflight[i];
      if (r !== null && r.hasListeners()) return false;
    }
    return true;
  }

  /** @internal */
  _onReply(r: TxReply): void {
    if (this._state === "finished") return;
    const errs = new Map<number, [string, string]>();
    for (const [i, name, message] of r.errs) errs.set(i, [name, message]);
    if (r.res.length) {
      const prev = this._state;
      this._state = "active";
      this._settleSoon();
      const quietPath = !this.listensOnPath("success", false) && !this.db.listensOnPath("success", false);
      for (let i = 0; i < r.res.length; i++) {
        const req = this.inflight[this.head++];
        if ((this._state as string) === "finished") break;
        const e = errs.get(i);
        if (req === null || req === undefined) {
          if (e) this._abort(err(e[0], e[1]));
          continue;
        }
        if (e) this.deliverError(req, err(e[0], e[1]));
        else this.deliver(req, r.res[i], quietPath);
      }
      if (this._state === "active" && prev === "committing") this._state = "committing";
    }
    if (r.end) {
      if ((this._state as string) === "finished") return;
      if (r.end.ok) this.complete();
      else if (r.end.name === "Deferred") {
        this.commitSent = false;
        if (this._state === "committing") this._state = "inactive";
        this._settleSoon();
      } else this._abort(err(r.end.name, r.end.message));
    }
  }

  private deliver(req: PlateauRequest, v: unknown, quietPath: boolean): void {
    let result: unknown;
    switch (req.kind) {
      case "key":
        result = v === undefined ? req.known : decodeKey(v as string);
        break;
      case "keys":
        result = (v as string[]).map(decodeKey);
        break;
      case "cursor":
        result = req.cursor!._land(v as CursorHit | null);
        break;
      case "records":
        result = (v as CursorHit[]).map((x) => ({ key: decodeKey(x.sk ?? x.k), primaryKey: decodeKey(x.sp ?? x.p), value: x.v }));
        break;
      case "query":
        req.plan = (v as { plan: string }).plan;
        result = (v as { value: unknown }).value;
        break;
      default:
        result = v;
    }
    finishRequest(req, result, null);
    if (quietPath && !req.hasListeners()) return;
    const out = dispatch(req, new PlateauEvent("success"));
    if (out.threw) this._abort(err("AbortError", "An exception was thrown in a success handler."));
  }

  private deliverError(req: PlateauRequest, e: DOMException): void {
    if (req.cursor) req.cursor._land(null);
    finishRequest(req, undefined, e);
    const ev = new PlateauEvent("error", { bubbles: true, cancelable: true });
    const out = dispatch(req, ev);
    if ((this._state as string) === "finished") return;
    if (out.threw) this._abort(err("AbortError", "An exception was thrown in an error handler."));
    else if (!ev.defaultPrevented) this._abort(e);
  }

  private complete(): void {
    if (this._state === "finished") return;
    this._state = "finished";
    runtime().finished(this.id);
    dispatch(this, new PlateauEvent("complete"));
    this.finish();
    if (this.written && this.mode === "readwrite") {
      const stores = [...this.written];
      runtime().changed(this.db.name, stores);
      changed(this.db.name, stores);
    }
  }

  private finish(): void {
    this.db._txs.delete(this);
    scheduler(this.db.name).done(this);
    this.isFinished = true;
    this.markFinished?.();
    this.db._maybeClosed();
  }

  /** @internal */
  _abort(error: DOMException | null): void {
    if (this._state === "finished") return;
    this._state = "finished";
    this._aborted = true;
    this._error = error;
    if (this.beforeUpgrade) {
      this.db._stores = this.beforeUpgrade;
      this.db._nextId = this.nextIdBefore;
    }
    if (this.began && this.mode !== "readonly") runtime().post(this.message([], "abort"));
    runtime().finished(this.id);
    const reqs = [...this.inflight.slice(this.head), ...this.unsentReqs, ...this.local].filter((r): r is PlateauRequest => r !== null);
    this.local.clear();
    this.inflight = [];
    this.head = 0;
    this.unsent = [];
    this.unsentReqs = [];
    afterTask(() => {
      for (const req of reqs) {
        if (req.cursor) req.cursor._land(null);
        finishRequest(req, undefined, err("AbortError", "The transaction was aborted."));
        dispatch(req, new PlateauEvent("error", { bubbles: true, cancelable: true }));
      }
      dispatch(this, new PlateauEvent("abort", { bubbles: true }));
      this.finish();
    });
  }
}
handlers(PlateauTransaction, ["abort", "complete", "error"]);

export interface PlateauTransaction {
  onabort: ((e: PlateauEvent) => unknown) | null;
  oncomplete: ((e: PlateauEvent) => unknown) | null;
  onerror: ((e: PlateauEvent) => unknown) | null;
}

// Object stores and indexes.

function direction(d: unknown): Direction {
  const s = d === undefined ? "next" : String(d);
  if (s !== "next" && s !== "nextunique" && s !== "prev" && s !== "prevunique") throw new TypeError(`The direction ${s} is not valid.`);
  return s;
}

function count(n: unknown): number {
  if (n === undefined) return 0;
  const x = Number(n);
  if (!Number.isFinite(x) || x < 0 || x > 0xffffffff) throw new TypeError("The count is not valid.");
  return Math.floor(x);
}

/** A point query (a key, not a range): its encoded key. */
function pointKey(q: unknown): string | undefined {
  if (q instanceof PlateauKeyRange || (typeof IDBKeyRange !== "undefined" && q instanceof IDBKeyRange)) return undefined;
  return requireKey(q);
}

export class PlateauObjectStore {
  /** @internal */ readonly _tx: PlateauTransaction;
  /** @internal */ readonly _def: StoreDef;
  /** @internal */ private indexHandles = new Map<string, PlateauIndex>();
  /** @internal */ private keyPathValue: KeyPath | null;

  constructor(tx: PlateauTransaction, def: StoreDef) {
    this._tx = tx;
    this._def = def;
    this.keyPathValue = Array.isArray(def.keyPath) ? [...def.keyPath] : def.keyPath;
  }

  get name(): string {
    return this._def.name;
  }

  get keyPath(): KeyPath | null {
    return this.keyPathValue;
  }

  get autoIncrement(): boolean {
    return this._def.autoIncrement;
  }

  get indexNames(): StringList {
    return stringList(this._def.indexes.map((i) => i.name));
  }

  get transaction(): PlateauTransaction {
    return this._tx;
  }

  /** @internal */
  _live(): void {
    if (this._tx.db._stores.get(this._def.name) !== this._def) throw err("InvalidStateError", "The object store has been deleted.");
  }

  /** @internal Checks for a request: store alive, transaction active, writable if asked. */
  _ready(write: boolean): void {
    this._live();
    this._tx._check(write);
  }

  put(value: unknown, key?: unknown): PlateauRequest {
    return this.store(value, key, false, arguments.length > 1);
  }

  add(value: unknown, key?: unknown): PlateauRequest {
    return this.store(value, key, true, arguments.length > 1);
  }

  /** @internal */
  store(value: unknown, key: unknown, add: boolean, keyGiven: boolean, source?: unknown): PlateauRequest {
    this._ready(true);
    const def = this._def;
    const inline = def.keyPath !== null;
    keyGiven = keyGiven && key !== undefined;
    if (inline && keyGiven) throw dataError("The object store uses in-line keys and the key parameter was provided.");
    if (!inline && !def.autoIncrement && !keyGiven) throw dataError("The object store uses out-of-line keys and has no key generator and the key parameter was not provided.");
    let k: string | undefined;
    let sk: string | undefined;
    if (keyGiven) {
      k = requireKey(key);
      sk = spelledKey(key);
    }
    if (def.columns) {
      const [t, rest, pk] = splitTyped(def, value);
      if (pk === undefined && !def.autoIncrement) throw dataError("The record has no number at the key path.");
      const req = new PlateauRequest(source ?? this, this._tx, "key");
      if (pk !== undefined) req.known = pk;
      this._tx._issueTyped(def, t, rest, add, pk === undefined, req);
      return req;
    }
    const row: PutRow = { v: "", add };
    {
      row.v = encodeValue(value);
      if (inline) {
        const r = extractKey(value, def.keyPath!);
        if (r === "invalid") throw dataError("Evaluating the object store's key path yielded a value that is not a valid key.");
        if (r === "missing") {
          if (!def.autoIncrement) throw dataError("Evaluating the object store's key path did not yield a value.");
          if (!canInjectKey(value, def.keyPath as string)) throw dataError("A generated key could not be inserted into the value.");
        } else {
          k = r.key;
          sk = r.sk;
        }
      }
    }
    if (k !== undefined) row.k = k;
    if (sk !== undefined) row.sk = sk;
    const req = new PlateauRequest(source ?? this, this._tx, "key");
    this._tx._issuePut(def.name, row, req);
    return req;
  }

  delete(query: unknown): PlateauRequest {
    this._ready(true);
    if (this._def.columns && typeof query === "number" && !Number.isNaN(query)) {
      // A typed store's keys are numbers: they go as numbers, not encoded.
      const req = new PlateauRequest(this, this._tx, "none");
      this._tx._issueDeleteNumber(this._def.name, query, req);
      return req;
    }
    const k = query === undefined || query === null ? undefined : pointKey(query);
    if (k !== undefined) {
      const req = new PlateauRequest(this, this._tx, "none");
      this._tx._issueDelete(this._def.name, k, req);
      return req;
    }
    const r = toRange(query, false)!;
    return this.request({ o: "del", s: this._def.name, r }, "none");
  }

  clear(): PlateauRequest {
    this._ready(true);
    return this.request({ o: "clear", s: this._def.name }, "none");
  }

  get(query: unknown): PlateauRequest {
    this._ready(false);
    const k = pointKey(query === undefined || query === null ? requireRange(query) : query);
    if (k !== undefined) {
      const req = new PlateauRequest(this, this._tx, "value");
      this._tx._issueGet(this._def.name, k, req);
      return req;
    }
    return this.request({ o: "first", s: this._def.name, r: toRange(query, false)!, key: false }, "value");
  }

  getKey(query: unknown): PlateauRequest {
    this._ready(false);
    return this.request({ o: "first", s: this._def.name, r: toRange(query, false)!, key: true }, "key");
  }

  getAll(query?: unknown, n?: unknown): PlateauRequest {
    this._ready(false);
    return this.request({ o: "all", s: this._def.name, r: toRange(query, true), n: count(n), key: false }, "values");
  }

  getAllKeys(query?: unknown, n?: unknown): PlateauRequest {
    this._ready(false);
    return this.request({ o: "all", s: this._def.name, r: toRange(query, true), n: count(n), key: true }, "keys");
  }

  count(query?: unknown): PlateauRequest {
    this._ready(false);
    return this.request({ o: "count", s: this._def.name, r: toRange(query, true) }, "count");
  }

  /** IndexedDB's getAllRecords: up to `count` records ({key, primaryKey, value}) in `direction`. */
  getAllRecords(o: { query?: unknown; count?: number; direction?: IDBCursorDirection } = {}): PlateauRequest {
    this._ready(false);
    return this.request({ o: "recs", s: this._def.name, r: toRange(o?.query, true), n: count(o?.count), d: direction(o?.direction) }, "records");
  }

  openCursor(query?: unknown, dir?: IDBCursorDirection): PlateauRequest {
    return this.cursor(query, dir, true);
  }

  openKeyCursor(query?: unknown, dir?: IDBCursorDirection): PlateauRequest {
    return this.cursor(query, dir, false);
  }

  /** plateau's multi-key query on declared columns: `{where, orderBy, limit, count}`. The result is
   * the matching values, or a number with `count: true`; `request.plan` names the plan. */
  query(q: { where?: unknown[]; orderBy?: { field: string; desc?: boolean }; limit?: number; count?: boolean }): PlateauRequest {
    this._ready(false);
    return this.request({ o: "query", s: this._def.name, q: JSON.stringify(q) }, "query");
  }

  /** @internal */
  private cursor(query: unknown, dir: unknown, values: boolean): PlateauRequest {
    this._ready(false);
    const d = direction(dir);
    const r = toRange(query, true);
    const req = new PlateauRequest(this, this._tx, "cursor");
    req.cursor = values ? new PlateauCursorWithValue(req, this, this, undefined, r, d, true) : new PlateauCursor(req, this, this, undefined, r, d, false);
    req.cursor._step(undefined, 1);
    return req;
  }

  /** @internal */
  request(op: Op, kind: ResultKind): PlateauRequest {
    const req = new PlateauRequest(this, this._tx, kind);
    this._tx._issue(op, req);
    return req;
  }

  index(name: string): PlateauIndex {
    if (this._tx._state === "finished") throw err("InvalidStateError", "The transaction has finished.");
    this._live();
    const n = String(name);
    const def = this._def.indexes.find((i) => i.name === n);
    if (!def) throw err("NotFoundError", `No index named ${n}.`);
    let h = this.indexHandles.get(n);
    if (!h || h._def !== def) {
      h = new PlateauIndex(this, def);
      this.indexHandles.set(n, h);
    }
    return h;
  }

  createIndex(name: string, keyPath: KeyPath, options: { unique?: boolean; multiEntry?: boolean } = {}): PlateauIndex {
    const tx = this._tx;
    if (tx.mode !== "versionchange") throw err("InvalidStateError", "Not in a version change transaction.");
    this._live();
    if (tx._state !== "active") throw err("TransactionInactiveError", "The version change transaction is not active.");
    const n = String(name);
    if (this._def.indexes.some((i) => i.name === n)) throw err("ConstraintError", `An index named ${n} already exists.`);
    const kp = normalizeKeyPath(keyPath) as KeyPath;
    if (!validKeyPath(kp)) throw err("SyntaxError", "The keyPath is not a valid key path.");
    const multiEntry = !!options?.multiEntry;
    if (multiEntry && Array.isArray(kp)) throw err("InvalidAccessError", "A multiEntry index cannot have an array key path.");
    const def: IndexDef = { id: tx.db._nextId++, name: n, keyPath: kp, unique: !!options?.unique, multiEntry };
    this._def.indexes.push(def);
    tx._internal({ o: "mkIndex", s: this._def.name, def: structuredClone(def) });
    return this.index(n);
  }

  deleteIndex(name: string): void {
    const tx = this._tx;
    if (tx.mode !== "versionchange") throw err("InvalidStateError", "Not in a version change transaction.");
    this._live();
    if (tx._state !== "active") throw err("TransactionInactiveError", "The version change transaction is not active.");
    const n = String(name);
    const i = this._def.indexes.findIndex((x) => x.name === n);
    if (i < 0) throw err("NotFoundError", `No index named ${n}.`);
    this._def.indexes.splice(i, 1);
    tx._internal({ o: "rmIndex", s: this._def.name, i: n });
  }
}

function requireRange(q: unknown): never {
  void q;
  throw dataError("No key or key range specified.");
}

/** A typed store's record: its declared fields in column order, the stored rest, its key. */
interface TypedLayout {
  names: string[];
  kinds: ColumnKind[];
  pkAt: number;
  declared: Set<string>;
}

const layouts = new WeakMap<StoreDef, TypedLayout>();

function layoutOf(def: StoreDef): TypedLayout {
  let l = layouts.get(def);
  if (!l) {
    const cols = def.columns!;
    l = { names: cols.map((c) => c.name), kinds: cols.map((c) => c.kind), pkAt: cols.findIndex((c) => c.name === def.keyPath), declared: new Set(cols.map((c) => c.name)) };
    layouts.set(def, l);
  }
  return l;
}

/** A typed store's record: its declared fields in column order, the stored rest of the value ("" if
 * none), and its key (undefined when the store is to generate it). Throws DataError when a
 * declared field is missing or of another type. */
function splitTyped(def: StoreDef, value: unknown): [unknown[], string, number | undefined] {
  const proto = value !== null && typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (proto !== Object.prototype && proto !== null) throw dataError("plateau: a store with columns takes plain objects.");
  const v = value as Record<string, unknown>;
  const { names, kinds, pkAt, declared } = layoutOf(def);
  const n = names.length;
  const t = new Array(n);
  let pk: number | undefined;
  for (let i = 0; i < n; i++) {
    const x = v[names[i]];
    if (i === pkAt && x === undefined && def.autoIncrement && !Object.prototype.hasOwnProperty.call(v, names[i])) {
      t[i] = 0;
      continue;
    }
    if (!fits(kinds[i], x) || !Object.prototype.hasOwnProperty.call(v, names[i])) {
      throw dataError(`plateau: field ${names[i]} must hold a ${kinds[i]} value (declared column).`);
    }
    t[i] = kinds[i] === "u32_multi" ? (x as number[]).slice() : x;
    if (i === pkAt) pk = x as number;
  }
  const keys = Object.keys(v);
  let rest = "";
  if (keys.length !== n) {
    const r: Record<string, unknown> = {};
    for (const k of keys) if (!declared.has(k)) r[k] = v[k];
    rest = encodeValue(r);
  }
  return [t, rest, pk];
}

/** Typed puts as the API gathers them: plain arrays per column. */
interface TypedPuts {
  o: "tput";
  s: string;
  n: number;
  cols: unknown[];
  v: string[] | null;
  add: number[];
  gen: number[];
}

/** The wire form: typed arrays, whose buffers are transferred. */
function wireTyped(p: TypedPuts, def: StoreDef, transfer: Transferable[]): Op {
  const cols = def.columns!.map((c, i) => {
    const b = p.cols[i];
    switch (c.kind) {
      case "f64": {
        const a = Float64Array.from(b as number[]);
        transfer.push(a.buffer);
        return a;
      }
      case "u32": {
        const a = Uint32Array.from(b as number[]);
        transfer.push(a.buffer);
        return a;
      }
      case "u32_multi": {
        const [o, v] = b as [number[], number[]];
        const pair = [Uint32Array.from(o), Uint32Array.from(v)];
        transfer.push(pair[0].buffer, pair[1].buffer);
        return pair;
      }
      default:
        return b;
    }
  });
  return { o: "tput", s: p.s, n: p.n, cols, v: p.v, add: p.add, gen: p.gen };
}

function fits(kind: ColumnKind, x: unknown): boolean {
  switch (kind) {
    case "f64":
      return typeof x === "number" && !Number.isNaN(x);
    case "u32":
      return typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 0xffffffff;
    case "str":
      return typeof x === "string";
    case "u32_multi": {
      if (!Array.isArray(x)) return false;
      for (let i = 0; i < x.length; i++) {
        const y = x[i];
        if (typeof y !== "number" || !Number.isInteger(y) || y < 0 || y > 0xffffffff) return false;
      }
      return true;
    }
  }
}

export class PlateauIndex {
  readonly objectStore: PlateauObjectStore;
  /** @internal */ readonly _def: IndexDef;
  /** @internal */ private keyPathValue: KeyPath;

  constructor(store: PlateauObjectStore, def: IndexDef) {
    this.objectStore = store;
    this._def = def;
    this.keyPathValue = Array.isArray(def.keyPath) ? [...def.keyPath] : def.keyPath;
  }

  get name(): string {
    return this._def.name;
  }

  get keyPath(): KeyPath {
    return this.keyPathValue;
  }

  get unique(): boolean {
    return this._def.unique;
  }

  get multiEntry(): boolean {
    return this._def.multiEntry;
  }

  /** @internal */
  _live(): void {
    this.objectStore._live();
    if (!this.objectStore._def.indexes.includes(this._def)) throw err("InvalidStateError", "The index has been deleted.");
  }

  /** @internal */
  _ready(): void {
    this._live();
    this.objectStore._tx._check(false);
  }

  private request(op: Op, kind: ResultKind): PlateauRequest {
    const req = new PlateauRequest(this, this.objectStore._tx, kind);
    this.objectStore._tx._issue(op, req);
    return req;
  }

  private get s(): string {
    return this.objectStore._def.name;
  }

  get(query: unknown): PlateauRequest {
    this._ready();
    return this.request({ o: "first", s: this.s, i: this._def.name, r: toRange(query, false)!, key: false }, "value");
  }

  getKey(query: unknown): PlateauRequest {
    this._ready();
    return this.request({ o: "first", s: this.s, i: this._def.name, r: toRange(query, false)!, key: true }, "key");
  }

  getAll(query?: unknown, n?: unknown): PlateauRequest {
    this._ready();
    return this.request({ o: "all", s: this.s, i: this._def.name, r: toRange(query, true), n: count(n), key: false }, "values");
  }

  getAllKeys(query?: unknown, n?: unknown): PlateauRequest {
    this._ready();
    return this.request({ o: "all", s: this.s, i: this._def.name, r: toRange(query, true), n: count(n), key: true }, "keys");
  }

  count(query?: unknown): PlateauRequest {
    this._ready();
    return this.request({ o: "count", s: this.s, i: this._def.name, r: toRange(query, true) }, "count");
  }

  /** IndexedDB's getAllRecords: up to `count` records ({key, primaryKey, value}) in `direction`. */
  getAllRecords(o: { query?: unknown; count?: number; direction?: IDBCursorDirection } = {}): PlateauRequest {
    this._ready();
    return this.request({ o: "recs", s: this.s, i: this._def.name, r: toRange(o?.query, true), n: count(o?.count), d: direction(o?.direction) }, "records");
  }

  openCursor(query?: unknown, dir?: IDBCursorDirection): PlateauRequest {
    return this.cursor(query, dir, true);
  }

  openKeyCursor(query?: unknown, dir?: IDBCursorDirection): PlateauRequest {
    return this.cursor(query, dir, false);
  }

  private cursor(query: unknown, dir: unknown, values: boolean): PlateauRequest {
    this._ready();
    const d = direction(dir);
    const r = toRange(query, true);
    const req = new PlateauRequest(this, this.objectStore._tx, "cursor");
    req.cursor = values ? new PlateauCursorWithValue(req, this, this.objectStore, this._def.name, r, d, true) : new PlateauCursor(req, this, this.objectStore, this._def.name, r, d, false);
    req.cursor._step(undefined, 1);
    return req;
  }
}

// Cursors.

export class PlateauCursor {
  readonly request: PlateauRequest;
  readonly source: PlateauObjectStore | PlateauIndex;
  readonly direction: Direction;
  /** @internal */ private store: PlateauObjectStore;
  /** @internal */ private index: string | undefined;
  /** @internal */ private range: WireRange | null;
  /** @internal */ private withValues: boolean;
  /** @internal */ private at: [string, string] | undefined;
  /** @internal */ private gotValue = false;
  /** @internal */ private keyValue: Key | undefined;
  /** @internal */ private pkValue: Key | undefined;
  /** @internal */ _value: unknown;
  /** @internal Prefetched next steps, and whether the range ends after them. */ private ahead: CursorHit[] = [];
  /** @internal */ private aheadEnd = false;

  constructor(req: PlateauRequest, source: PlateauObjectStore | PlateauIndex, store: PlateauObjectStore, index: string | undefined, range: WireRange | null, dir: Direction, values: boolean) {
    this.request = req;
    this.source = source;
    this.store = store;
    this.index = index;
    this.range = range;
    this.direction = dir;
    this.withValues = values;
  }

  get key(): Key | undefined {
    return this.keyValue;
  }

  get primaryKey(): Key | undefined {
    return this.pkValue;
  }

  /** @internal Requests the next step. */
  _step(to: [string, string?] | undefined, n: number): void {
    const tx = this.store._tx;
    const ahead = tx.mode === "readonly" && to === undefined && n === 1 && (this.direction === "next" || this.direction === "prev");
    if (ahead && (this.ahead.length || this.aheadEnd)) {
      this.request._done = false;
      tx._local(this.request, this.ahead.shift() ?? null);
      return;
    }
    this.ahead = [];
    this.aheadEnd = false;
    const op: Op = { o: "cur", s: this.store._def.name, r: this.range, d: this.direction, n, v: this.withValues };
    if (tx.mode === "readonly" && (this.direction === "next" || this.direction === "prev")) op.pre = PREFETCH;
    if (this.index !== undefined) op.i = this.index;
    if (this.at) op.at = this.at;
    if (to) op.to = to;
    this.request._done = false;
    this.store._tx._issue(op, this.request);
  }

  /** @internal A step's answer arrived; the request's result. */
  _land(hit: CursorHit | null): PlateauCursor | null {
    if (hit?.more !== undefined) {
      this.ahead = hit.more;
      this.aheadEnd = this.ahead.length < PREFETCH;
      delete hit.more;
    }
    if (!hit) {
      this.ahead = [];
      this.aheadEnd = false;
      this.at = undefined;
      this.keyValue = this.pkValue = this._value = undefined;
      return null;
    }
    this.at = [hit.k, hit.p];
    this.keyValue = decodeKey(hit.sk ?? hit.k);
    this.pkValue = hit.k === hit.p && hit.sk === hit.sp ? this.keyValue : decodeKey(hit.sp ?? hit.p);
    this._value = hit.v;
    this.gotValue = true;
    return this;
  }

  /** @internal */
  private ready(): void {
    this.store._tx._check(false);
    if (this.source instanceof PlateauIndex) this.source._live();
    else this.store._live();
    if (!this.gotValue) throw err("InvalidStateError", "The cursor is being iterated or has iterated past its end.");
  }

  advance(count: number): void {
    const n = Number(count);
    if (!Number.isFinite(n) || n < 1 || n > 0xffffffff) throw new TypeError("The count must be a positive integer.");
    this.ready();
    this.gotValue = false;
    this._step(undefined, Math.floor(n));
  }

  continue(key?: unknown): void {
    this.ready();
    let to: [string] | undefined;
    if (key !== undefined) {
      const k = requireKey(key);
      const cur = this.at![0];
      const forward = this.direction === "next" || this.direction === "nextunique";
      if (forward ? k <= cur : k >= cur) throw dataError("The key is not past the cursor's position in its direction.");
      to = [k];
    }
    this.gotValue = false;
    this._step(to, 1);
  }

  continuePrimaryKey(key: unknown, primaryKey: unknown): void {
    this.store._tx._check(false);
    if (this.source instanceof PlateauIndex) this.source._live();
    else this.store._live();
    if (!(this.source instanceof PlateauIndex)) throw err("InvalidAccessError", "continuePrimaryKey needs an index cursor.");
    if (this.direction !== "next" && this.direction !== "prev") throw err("InvalidAccessError", "continuePrimaryKey needs a next or prev cursor.");
    if (!this.gotValue) throw err("InvalidStateError", "The cursor is being iterated or has iterated past its end.");
    const k = requireKey(key);
    const p = requireKey(primaryKey);
    const [ck, cp] = this.at!;
    const forward = this.direction === "next";
    const c = k < ck ? -1 : k > ck ? 1 : 0;
    if (forward ? c < 0 || (c === 0 && p <= cp) : c > 0 || (c === 0 && p >= cp)) throw dataError("The key is not past the cursor's position in its direction.");
    this.gotValue = false;
    this._step([k, p], 1);
  }

  update(value: unknown): PlateauRequest {
    const tx = this.store._tx;
    tx._check(false);
    if (this.source instanceof PlateauIndex) this.source._live();
    else this.store._live();
    if (tx.mode === "readonly") throw err("ReadOnlyError", "The transaction is read-only.");
    if (!this.gotValue) throw err("InvalidStateError", "The cursor is being iterated or has iterated past its end.");
    if (!this.withValues) throw err("InvalidStateError", "A key cursor has no value.");
    const def = this.store._def;
    if (def.keyPath !== null) {
      encodeValue(value);
      const r = def.columns ? { key: encodeKey((value as Record<string, unknown>)?.[def.keyPath as string]) } : extractKey(value, def.keyPath);
      if (typeof r !== "object" || r.key !== this.at![1]) throw dataError("The value's key does not match the cursor's primary key.");
      return this.store.store(value, undefined, false, false, this);
    }
    return this.store.store(value, this.pkValue, false, true, this);
  }

  delete(): PlateauRequest {
    const tx = this.store._tx;
    tx._check(false);
    if (this.source instanceof PlateauIndex) this.source._live();
    else this.store._live();
    if (tx.mode === "readonly") throw err("ReadOnlyError", "The transaction is read-only.");
    if (!this.gotValue) throw err("InvalidStateError", "The cursor is being iterated or has iterated past its end.");
    if (!this.withValues) throw err("InvalidStateError", "A key cursor cannot delete.");
    const p = this.at![1];
    const req = new PlateauRequest(this, tx, "none");
    tx._issueDelete(this.store._def.name, p, req);
    return req;
  }
}

export class PlateauCursorWithValue extends PlateauCursor {}

Object.defineProperty(PlateauCursorWithValue.prototype, "value", {
  get(this: PlateauCursor) {
    return this._value;
  },
  enumerable: true,
  configurable: true,
});

export const plateau = new PlateauFactory();
export { PlateauKeyRange };
