// The page's plateau runtime. One tab of the origin, the leader, runs the dedicated worker that
// hosts the engine and holds the database files; every other tab forwards its calls and
// transactions to the leader. The main thread compiles the WASM (`compileStreaming` from a stable
// URL, which Chromium code-caches) and posts the Module to the worker.
//
// - Election, Web Locks: each tab holds `plateau/alive/<tab>` for its life and asks for
//   `plateau/leader`. The tab granted it leads until it closes; the next one queued for it takes
//   over. A tab learns that another closed when its shared request for that tab's alive lock is
//   granted.
// - Transport, BroadcastChannel: announcements on `plateau/hub`; a follower and the leader talk on
//   `plateau/tab/<follower>`, a channel only those two hold.
// - The leader's scheduler orders every tab's transactions (`RemoteTx`), its open queue every
//   tab's open and deleteDatabase, and it passes a version change on to every tab with a
//   connection to the database.
// - When the leader closes, the transactions it was running for other tabs abort with
//   UnknownError; what they committed is on disk. Each tab reopens its connections at the new
//   leader and sends again the calls it had waiting.
// Without Web Locks or BroadcastChannel the tab runs its own worker, as a single tab does.
// - A tab that does not run the engine (`stop`: the page falls back to the browser's IndexedDB)
//   still takes part in the election, for `whenLeader`, and fails the calls of tabs it leads, so
//   they fall back too.

import type { CallMessage, CallReply, CallRequest, TxMessage, TxReply } from "./protocol";
import { scheduler, type Schedulable } from "./scheduler";

const WASM_URL = new URL("../../../crates/engine/pkg/plateau_engine_bg.wasm", import.meta.url).href;

const LEADER = "plateau/leader";
const ALIVE = "plateau/alive/";
const HUB = "plateau/hub";
const TAB = "plateau/tab/";

export interface RuntimeOptions {
  /** A worker running plateau's worker script, already started (say by a head bootstrap). */
  worker?: Worker;
  /** Resolves when that worker has its WASM (it replied to `init`). */
  initialized?: Promise<unknown>;
  /** Which backend this page uses: `auto` (the default) picks OPFS where the engine runs there and
   * the browser's own IndexedDB elsewhere; `opfs` and `indexeddb` skip the check. */
  backend?: "auto" | "opfs" | "indexeddb";
}

/** Once versionchange has fired at a tab's connections: whether one is still open without a close
 * pending, and their version (0 when none is open). */
export interface VersionChangeAck {
  blocking: boolean;
  version: number;
}

/** A tab's answer to a version change, and when its connections have all closed. */
export interface VersionChangeWait {
  ack: VersionChangeAck | Promise<VersionChangeAck>;
  closed: Promise<void>;
}

/** Fires versionchange at this tab's open connections to `db`; null when it has none open.
 * `oldVersion` is null for a deleteDatabase, whose events carry the connections' version. */
export type VersionChangeHook = (db: string, oldVersion: number | null, newVersion: number | null) => VersionChangeWait | null;

let versionChangeHook: VersionChangeHook = () => null;

/** The facade's handler for version changes other tabs ask for. */
export function onVersionChange(hook: VersionChangeHook): void {
  versionChangeHook = hook;
}

let changeHook: (db: string, stores: string[]) => void = () => {};

/** The facade's handler for commits made in other tabs. */
export function onChange(hook: (db: string, stores: string[]) => void): void {
  changeHook = hook;
}

type Outgoing = CallMessage | TxMessage;

/** Coordination between a tab and the leader, besides calls and transactions. */
type Control =
  | { t: "slot"; id: number; db: string; held: boolean }
  | { t: "slotEnd"; id: number }
  | { t: "vc"; id: number; db: string; old: number | null; new: number | null }
  | ({ t: "vcAck"; id: string } & VersionChangeAck)
  | { t: "vcClosed"; id: string }
  | { t: "done"; tx: number };

/** From the leader to a tab. */
type Answer =
  | CallReply
  | TxReply
  | { t: "welcome"; leader: string }
  | { t: "slotGo"; id: number }
  | { t: "vc"; id: string; key: string; db: string; old: number | null; new: number | null }
  | ({ t: "vcAck"; id: number } & VersionChangeAck)
  | { t: "vcClosed"; id: number };

type Announcement =
  | { t: "who" }
  | { t: "leader"; tab: string }
  | { t: "hello"; tab: string; leader: string }
  /** A readwrite transaction that wrote `stores` committed in the sending tab. */
  | { t: "changed"; db: string; stores: string[] };

interface Call {
  m: CallRequest;
  resolve: (v: any) => void;
  reject: (e: unknown) => void;
  /** Sent to the current leader, and not answered. */
  sent: boolean;
}

/** A tab the leader serves. */
interface Follower {
  tab: string;
  port: BroadcastChannel;
  /** Its open connections per database. */
  conns: Map<string, number>;
  /** Its transactions by its own ids. */
  txs: Map<number, RemoteTx>;
  gone: boolean;
}

const forever = () => new Promise<never>(() => {});

function count(m: Map<string, number>, key: string, by: number): void {
  const n = (m.get(key) ?? 0) + by;
  if (n > 0) m.set(key, n);
  else m.delete(key);
}

/** The open and deleteDatabase requests of every tab for one database, one at a time. A request
 * held when the previous leader closed goes first. */
class OpenQueue {
  private busy = false;
  private waiting: (() => Promise<void>)[] = [];

  add(job: () => Promise<void>, first: boolean): void {
    if (first) this.waiting.unshift(job);
    else this.waiting.push(job);
    this.pump();
  }

  private pump(): void {
    if (this.busy) return;
    const job = this.waiting.shift();
    if (!job) return;
    this.busy = true;
    void job()
      .catch((e) => console.error(e))
      .finally(() => {
        this.busy = false;
        this.pump();
      });
  }
}

/** Another tab's transaction, as the leader schedules and runs it. Its messages wait here until
 * the scheduler starts it. */
class RemoteTx implements Schedulable {
  readonly mode: IDBTransactionMode;
  _scope: string[];
  _started = false;
  _state: "running" | "finished" = "running";
  private waiting: TxMessage[] = [];

  constructor(
    private rt: Runtime,
    private f: Follower,
    private remote: number,
    readonly id: number,
    private db: string,
    begin: NonNullable<TxMessage["begin"]>,
  ) {
    this.mode = begin.mode;
    this._scope = [...begin.stores];
  }

  receive(m: TxMessage): void {
    const local = { ...m, tx: this.id };
    if (this._started) this.rt.worker!.postMessage(local);
    else this.waiting.push(local);
  }

  _start(): void {
    this._started = true;
    for (const m of this.waiting) this.rt.worker!.postMessage(m);
    this.waiting = [];
  }

  _onReply(r: TxReply): void {
    if (!this.f.gone) this.f.port.postMessage({ ...r, tx: this.remote });
    if (r.end && (r.end.ok || r.end.name !== "Deferred")) this.finish();
  }

  /** The tab finished it (a readonly transaction, or one it aborted). */
  finish(): void {
    if (this._state === "finished") return;
    this._state = "finished";
    this.rt.txs.delete(this.id);
    this.f.txs.delete(this.remote);
    scheduler(this.db).done(this);
  }

  /** Its tab closed: what it wrote is rolled back. */
  kill(): void {
    if (this._started && this.mode !== "readonly" && this._state !== "finished") {
      this.rt.worker!.postMessage({ t: "tx", tx: this.id, db: this.db, ops: [], end: "abort" } satisfies TxMessage);
    }
    this.finish();
  }
}

export class Runtime {
  /** The worker, in the leader tab (and in a tab that has not yet found a live leader). */
  worker: Worker | null = null;
  /** `pending` while the tab knows no live leader: what it sends waits. */
  role: "pending" | "leader" | "follower" = "pending";
  /** Transactions waiting for replies, by id. */
  readonly txs = new Map<number, { _onReply(r: TxReply): void }>();
  nextTx = 1;
  readonly tab: string;
  /** Resolves when this tab becomes the leader (at once for a single tab); never rejects. */
  readonly leading: Promise<void>;
  /** The backend the page asked for (`startRuntime({ backend })`). */
  readonly requested: "auto" | "opfs" | "indexeddb";
  /** Set when this tab cannot run the engine (its worker failed to start, or the page uses the
   * browser's IndexedDB): calls fail with it, here and from the tabs this one leads. */
  dead: DOMException | null = null;
  private becameLeader!: () => void;
  /** Whether the worker answered `init` (or was handed over started). */
  private started = false;

  private calls = new Map<number, Call>();
  private nextCall = 1;
  /** Messages sent while no leader is known, in order. */
  private held: [Outgoing, Transferable[]][] = [];
  /** Transactions with messages at the current leader (follower only). */
  private begun = new Set<number>();
  /** Transactions aborted because the leader closed; their later messages are dropped. */
  private lost = new Set<number>();
  /** This tab's open connections per database. */
  private opened = new Map<string, number>();
  private leaderTab: string | null = null;
  private hub: BroadcastChannel | null = null;
  private port: BroadcastChannel | null = null;
  /** This tab's open-queue requests. */
  private slots = new Map<number, { db: string; held: boolean; go: () => void }>();
  private nextSlot = 1;
  /** This tab's version changes waiting on other tabs. */
  private vcs = new Map<number, { db: string; old: number | null; new: number | null; ack: (a: VersionChangeAck) => void; closed: () => void }>();
  private nextVc = 1;
  /** Version changes this tab answered, by asking tab and id: a repeat sent to a new leader does
   * not fire versionchange again. */
  private seen = new Map<string, VersionChangeWait>();

  // The leader's state.
  private followers = new Map<string, Follower>();
  private relayed = new Map<number, (r: CallReply) => void>();
  private queues = new Map<string, OpenQueue>();
  private slotHolds = new Map<string, () => void>();
  private fanouts = new Map<string, { tab: string; ack: (a: VersionChangeAck) => void; closed: () => void }>();

  constructor(o: RuntimeOptions = {}) {
    this.leading = new Promise<void>((resolve) => (this.becameLeader = resolve));
    this.tab = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.requested = o.backend ?? "auto";
    // The worker starts at once, as if this tab will lead: a single tab, the common case, then
    // waits for nothing. A follower stops it once a leader answers.
    if (this.requested === "indexeddb") this.stop("plateau: this page uses the browser's IndexedDB");
    else this.startWorker(o);
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks || typeof BroadcastChannel === "undefined") {
      this.lead();
      return;
    }
    // Channels open once the lock answers, off the page's start-up path.
    void locks.request(ALIVE + this.tab, () => {
      this.hub = new BroadcastChannel(HUB);
      this.hub.onmessage = (e) => this.onHub(e.data as Announcement);
      void locks.request(LEADER, { ifAvailable: true }, (lock) => {
        if (lock) {
          this.lead();
          return forever();
        }
        this.hub!.postMessage({ t: "who" } satisfies Announcement);
        void locks.request(LEADER, () => {
          this.lead();
          return forever();
        });
        return undefined;
      });
      return forever();
    });
  }

  /** This tab does not run the engine: stops its worker; calls fail from now on, and a tab this one
   * leads gets the same failure, so it picks the same backend. */
  stop(message: string): void {
    if (this.dead) return;
    this.dead = new DOMException(message, "NotSupportedError");
    this.worker?.terminate();
    this.worker = null;
    if (this.role !== "leader") return;
    for (const [id, c] of this.calls) {
      this.calls.delete(id);
      c.reject(this.dead);
    }
    for (const [id, reply] of this.relayed) {
      this.relayed.delete(id);
      reply({ t: "call", id, ok: false, name: this.dead.name, message: this.dead.message });
    }
  }

  call<T>(m: CallRequest): Promise<T> {
    const id = this.nextCall++;
    return new Promise<T>((resolve, reject) => {
      this.calls.set(id, { m, resolve, reject, sent: false });
      if (m.t === "close") count(this.opened, m.db, -1);
      this.send({ ...m, id } as CallMessage);
    });
  }

  post(m: TxMessage, transfer: Transferable[] = []): void {
    if (this.lost.size && this.lost.has(m.tx)) return;
    this.send(m, transfer);
  }

  /** A transaction of this tab finished. */
  finished(tx: number): void {
    this.txs.delete(tx);
    this.lost.delete(tx);
    if (this.begun.delete(tx) && this.role === "follower") this.port!.postMessage({ t: "done", tx } satisfies Control);
  }

  /** Runs `job` when every earlier open or deleteDatabase of `db`, in any tab, has finished. */
  queue(db: string, job: () => Promise<void>): void {
    const run = (done: () => void) =>
      queueMicrotask(() =>
        void job()
          .catch((e) => console.error(e))
          .finally(done),
      );
    if (this.role === "leader") {
      this.openQueue(db).add(() => new Promise<void>(run), false);
      return;
    }
    const id = this.nextSlot++;
    const s = {
      db,
      held: false,
      go: () => {
        if (s.held) return;
        s.held = true;
        run(() => {
          this.slots.delete(id);
          this.toLeader({ t: "slotEnd", id });
        });
      },
    };
    this.slots.set(id, s);
    this.toLeader({ t: "slot", id, db, held: false });
  }

  /** Tells the other tabs that a transaction of this tab that wrote `stores` committed. */
  changed(db: string, stores: string[]): void {
    this.hub?.postMessage({ t: "changed", db, stores } satisfies Announcement);
  }

  /** Fires versionchange at other tabs' connections to `db`; null when no other tab has one. */
  versionChange(db: string, oldVersion: number | null, newVersion: number | null): { ack: Promise<VersionChangeAck>; closed: Promise<void> } | null {
    if (this.role === "leader" && ![...this.followers.values()].some((f) => f.conns.has(db))) return null;
    const id = this.nextVc++;
    let ack!: (a: VersionChangeAck) => void;
    let closed!: () => void;
    const out = { ack: new Promise<VersionChangeAck>((r) => (ack = r)), closed: new Promise<void>((r) => (closed = r)) };
    this.vcs.set(id, { db, old: oldVersion, new: newVersion, ack, closed });
    this.toLeader({ t: "vc", id, db, old: oldVersion, new: newVersion });
    return out;
  }

  private startWorker(o: RuntimeOptions): void {
    let worker: Worker;
    try {
      worker = o.worker ?? new Worker(new URL("./host.worker.ts", import.meta.url), { type: "module" });
      if (!o.worker) {
        const compiled = WebAssembly.compileStreaming(fetch(WASM_URL)).catch(async () => WebAssembly.compile(await (await fetch(WASM_URL)).arrayBuffer()));
        compiled.then(
          (module) => worker.postMessage({ t: "init", module }),
          (e) => this.stop(`plateau: the engine's WebAssembly does not compile here: ${(e as Error)?.message ?? String(e)}`),
        );
      }
    } catch (e) {
      // No Worker, no module workers or no WebAssembly.
      this.stop(`plateau: the engine's worker does not start here: ${(e as Error)?.message ?? String(e)}`);
      return;
    }
    this.started = !!o.worker;
    // Before `init` an error event means the worker's script did not load (say a browser without
    // module workers); after it, errors are the worker's own and it keeps running.
    worker.addEventListener("error", (e) => {
      if (!this.started && this.worker === worker) this.stop(`plateau: the engine's worker failed to load: ${e.message ?? ""}`.trim());
    });
    worker.addEventListener("message", (e: MessageEvent) => {
      const m = e.data as CallReply | TxReply | { t: "init"; error?: string };
      if (m.t === "init") {
        if (m.error) this.stop(m.error);
        else this.started = true;
      } else if (m.t === "call") {
        const r = this.relayed.get(m.id);
        if (r) {
          this.relayed.delete(m.id);
          r(m);
        } else this.settle(m);
      } else if (m.t === "tx") this.txs.get(m.tx)?._onReply(m);
    });
    this.worker = worker;
  }

  private send(m: Outgoing, transfer: Transferable[] = []): void {
    if (this.role === "leader" && this.dead) {
      const dead = this.dead;
      if (m.t !== "tx") queueMicrotask(() => this.settle({ t: "call", id: m.id, ok: false, name: dead.name, message: dead.message }));
      else if (m.begin) queueMicrotask(() => this.txs.get(m.tx)?._onReply({ t: "tx", tx: m.tx, res: [], errs: [], end: { ok: false, name: "UnknownError", message: dead.message } }));
    } else if (this.role === "leader") {
      this.worker!.postMessage(m, transfer);
    } else if (this.role === "follower") {
      if (m.t === "tx") {
        if (m.begin) this.begun.add(m.tx);
      } else {
        const c = this.calls.get(m.id);
        if (c) c.sent = true;
      }
      this.port!.postMessage(m);
    } else this.held.push([m, transfer]);
  }

  /** Sends a control message to the leader. While there is none it is dropped: `flush` sends
   * again whatever is still wanted once one answers. */
  private toLeader(m: Control): void {
    if (this.role === "leader") this.onLeader(this.tab, m);
    else if (this.role === "follower") this.port!.postMessage(m);
  }

  private settle(r: CallReply): void {
    const c = this.calls.get(r.id);
    if (!c) return;
    this.calls.delete(r.id);
    if (r.ok) {
      if (c.m.t === "open") count(this.opened, c.m.db, 1);
      c.resolve(r.value);
    } else c.reject(new DOMException(r.message, r.name));
  }

  private watch(tab: string, gone: () => void): void {
    void navigator.locks.request(ALIVE + tab, { mode: "shared" }, () => gone());
  }

  private onHub(m: Announcement): void {
    if (m.t === "changed") changeHook(m.db, m.stores);
    else if (m.t === "who") {
      if (this.role === "leader") this.hub!.postMessage({ t: "leader", tab: this.tab } satisfies Announcement);
    } else if (m.t === "leader") {
      if (m.tab !== this.tab && this.role !== "leader" && m.tab !== this.leaderTab) this.join(m.tab);
    } else if (m.leader === this.tab && this.role === "leader" && !this.followers.has(m.tab)) {
      this.serve(m.tab);
    }
  }

  /** A follower of `leader`: stops its own worker and asks the leader to serve it. */
  private join(leader: string): void {
    if (this.leaderTab !== null) this.leaderLost();
    this.leaderTab = leader;
    this.worker?.terminate();
    this.worker = null;
    this.port = new BroadcastChannel(TAB + this.tab);
    this.port.onmessage = (e) => this.receive(e.data as Answer);
    this.watch(leader, () => {
      if (this.leaderTab === leader) this.leaderLost();
    });
    this.hub!.postMessage({ t: "hello", tab: this.tab, leader } satisfies Announcement);
  }

  private lead(): void {
    if (this.leaderTab !== null) this.leaderLost();
    this.leaderTab = this.tab;
    this.role = "leader";
    this.becameLeader();
    if (!this.worker && !this.dead) this.startWorker({});
    this.hub?.postMessage({ t: "leader", tab: this.tab } satisfies Announcement);
    this.flush();
  }

  /** The leader closed: abort what it was running for this tab, and hold what follows. */
  private leaderLost(): void {
    this.leaderTab = null;
    this.role = "pending";
    // Replies the closed leader posted and this tab has not read yet are dropped with the channel.
    this.port?.close();
    this.port = null;
    const begun = [...this.begun];
    this.begun.clear();
    for (const tx of begun) {
      const t = this.txs.get(tx);
      if (!t) continue;
      this.lost.add(tx);
      t._onReply({ t: "tx", tx, res: [], errs: [], end: { ok: false, name: "UnknownError", message: "plateau: the tab that ran the database closed during the transaction" } });
    }
    const resend: [Outgoing, Transferable[]][] = [];
    for (const [id, c] of this.calls) {
      if (!c.sent) continue;
      c.sent = false;
      // The new leader's worker has none of this tab's connections; a close has nothing to undo.
      if (c.m.t === "close") {
        this.calls.delete(id);
        c.resolve(null);
      } else resend.push([{ ...c.m, id } as CallMessage, []]);
    }
    this.held = [...resend, ...this.held];
  }

  /** A leader serves this tab now: reopen its connections there, then send what waited. */
  private flush(): void {
    for (const [db, n] of this.opened) for (let i = 0; i < n; i++) this.send({ t: "open", db, id: this.nextCall++ });
    for (const [id, s] of this.slots) this.toLeader({ t: "slot", id, db: s.db, held: s.held });
    for (const [id, v] of this.vcs) this.toLeader({ t: "vc", id, db: v.db, old: v.old, new: v.new });
    const held = this.held;
    this.held = [];
    for (const [m, transfer] of held) this.send(m, transfer);
  }

  private receive(m: Answer): void {
    switch (m.t) {
      case "call":
        this.settle(m);
        return;
      case "tx":
        if (m.end && (m.end.ok || m.end.name !== "Deferred")) this.begun.delete(m.tx);
        this.txs.get(m.tx)?._onReply(m);
        return;
      case "welcome":
        if (m.leader === this.leaderTab && this.role === "pending") {
          this.role = "follower";
          this.flush();
        }
        return;
      case "slotGo":
        this.slots.get(m.id)?.go();
        return;
      case "vc": {
        const w = this.answer(m.key, m.db, m.old, m.new);
        const id = m.id;
        void Promise.resolve(w?.ack ?? { blocking: false, version: 0 }).then((a) => this.toLeader({ t: "vcAck", id, ...a }));
        void (w?.closed ?? Promise.resolve()).then(() => this.toLeader({ t: "vcClosed", id }));
        return;
      }
      case "vcAck":
        this.vcs.get(m.id)?.ack({ blocking: m.blocking, version: m.version });
        return;
      case "vcClosed": {
        const v = this.vcs.get(m.id);
        this.vcs.delete(m.id);
        v?.closed();
        return;
      }
    }
  }

  /** This tab's connections answer the version change `key` (asking tab and its id). */
  private answer(key: string, db: string, oldVersion: number | null, newVersion: number | null): VersionChangeWait | null {
    let w = this.seen.get(key) ?? null;
    if (!w) {
      w = versionChangeHook(db, oldVersion, newVersion);
      if (w) {
        this.seen.set(key, w);
        void w.closed.then(() => this.seen.delete(key));
      }
    }
    return w;
  }

  // The leader's side.

  private reply(tab: string, m: Answer): void {
    if (tab === this.tab) this.receive(m);
    else {
      const f = this.followers.get(tab);
      if (f && !f.gone) f.port.postMessage(m);
    }
  }

  private serve(tab: string): void {
    const f: Follower = { tab, port: new BroadcastChannel(TAB + tab), conns: new Map(), txs: new Map(), gone: false };
    f.port.onmessage = (e) => this.onLeader(tab, e.data as Outgoing | Control);
    this.followers.set(tab, f);
    this.watch(tab, () => this.followerGone(tab));
    f.port.postMessage({ t: "welcome", leader: this.tab } satisfies Answer);
  }

  private onLeader(from: string, m: Outgoing | Control): void {
    switch (m.t) {
      case "tx":
        return this.relayTx(from, m);
      case "done":
        this.followers.get(from)?.txs.get(m.tx)?.finish();
        return;
      case "slot":
        return this.grantSlot(from, m.id, m.db, m.held);
      case "slotEnd": {
        const key = `${from}:${m.id}`;
        const release = this.slotHolds.get(key);
        this.slotHolds.delete(key);
        release?.();
        return;
      }
      case "vc":
        return this.fanOut(from, m.id, m.db, m.old, m.new);
      case "vcAck":
        this.fanouts.get(m.id)?.ack({ blocking: m.blocking, version: m.version });
        return;
      case "vcClosed": {
        const w = this.fanouts.get(m.id);
        this.fanouts.delete(m.id);
        w?.closed();
        return;
      }
      default:
        return this.relayCall(from, m);
    }
  }

  private relayCall(from: string, m: CallMessage): void {
    const f = this.followers.get(from);
    if (!f) return;
    if (this.dead) {
      f.port.postMessage({ t: "call", id: m.id, ok: false, name: this.dead.name, message: this.dead.message } satisfies CallReply);
      return;
    }
    const id = this.nextCall++;
    if (m.t === "close") count(f.conns, m.db, -1);
    this.relayed.set(id, (r) => {
      if (r.ok && m.t === "open") {
        if (f.gone) this.worker!.postMessage({ t: "close", db: m.db, id: this.nextCall++ } satisfies CallMessage);
        else count(f.conns, m.db, 1);
      }
      if (!f.gone) f.port.postMessage({ ...r, id: m.id });
    });
    this.worker!.postMessage({ ...m, id });
  }

  private relayTx(from: string, m: TxMessage): void {
    const f = this.followers.get(from);
    if (!f) return;
    if (this.dead) {
      if (m.begin) f.port.postMessage({ t: "tx", tx: m.tx, res: [], errs: [], end: { ok: false, name: "UnknownError", message: this.dead.message } } satisfies TxReply);
      return;
    }
    let p = f.txs.get(m.tx);
    if (!p) {
      if (!m.begin) return;
      p = new RemoteTx(this, f, m.tx, this.nextTx++, m.db, m.begin);
      f.txs.set(m.tx, p);
      this.txs.set(p.id, p);
      scheduler(m.db).add(p);
    }
    p.receive(m);
  }

  private openQueue(db: string): OpenQueue {
    let q = this.queues.get(db);
    if (!q) this.queues.set(db, (q = new OpenQueue()));
    return q;
  }

  private grantSlot(from: string, id: number, db: string, held: boolean): void {
    this.openQueue(db).add(
      () =>
        new Promise<void>((release) => {
          if (from !== this.tab && !this.followers.has(from)) return release();
          this.slotHolds.set(`${from}:${id}`, release);
          if (!held) this.reply(from, { t: "slotGo", id });
        }),
      held,
    );
  }

  private fanOut(from: string, id: number, db: string, oldVersion: number | null, newVersion: number | null): void {
    const key = `${from}:${id}`;
    const waits: VersionChangeWait[] = [];
    if (from !== this.tab) {
      const own = this.answer(key, db, oldVersion, newVersion);
      if (own) waits.push(own);
    }
    for (const [tab, f] of this.followers) {
      if (tab === from || !f.conns.has(db)) continue;
      const fid = `${this.tab}:${this.nextVc++}`;
      let ack!: (a: VersionChangeAck) => void;
      let closed!: () => void;
      waits.push({ ack: new Promise<VersionChangeAck>((r) => (ack = r)), closed: new Promise<void>((r) => (closed = r)) });
      this.fanouts.set(fid, { tab, ack, closed });
      f.port.postMessage({ t: "vc", id: fid, key, db, old: oldVersion, new: newVersion } satisfies Answer);
    }
    void Promise.all(waits.map((w) => w.ack)).then((acks) =>
      this.reply(from, { t: "vcAck", id, blocking: acks.some((a) => a.blocking), version: Math.max(0, ...acks.map((a) => a.version)) }),
    );
    void Promise.all(waits.map((w) => w.closed)).then(() => this.reply(from, { t: "vcClosed", id }));
  }

  /** A follower closed: roll back its transactions, close its connections, free what it held. */
  private followerGone(tab: string): void {
    const f = this.followers.get(tab);
    if (!f) return;
    f.gone = true;
    this.followers.delete(tab);
    f.port.close();
    for (const p of [...f.txs.values()]) p.kill();
    for (const [db, n] of f.conns) for (let i = 0; i < n; i++) this.worker?.postMessage({ t: "close", db, id: this.nextCall++ } satisfies CallMessage);
    for (const [key, release] of this.slotHolds) {
      if (!key.startsWith(`${tab}:`)) continue;
      this.slotHolds.delete(key);
      release();
    }
    for (const [id, w] of this.fanouts) {
      if (w.tab !== tab) continue;
      this.fanouts.delete(id);
      w.ack({ blocking: false, version: 0 });
      w.closed();
    }
  }
}

let current: Runtime | null = null;

/** The page's runtime if it has started. */
export function currentRuntime(): Runtime | null {
  return current;
}

/** The page's runtime, started on first call. */
export function runtime(o?: RuntimeOptions): Runtime {
  current ??= new Runtime(o);
  return current;
}

/** Starts the runtime now, as an app does by importing the library at start-up; `o` attaches it
 * to a worker a bootstrap started. */
export function startRuntime(o?: RuntimeOptions): Runtime {
  return runtime(o);
}
