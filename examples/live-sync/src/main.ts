// The app: an orders list (the 50 most recently updated, and a count) kept live from
// `GET /live-updates`.
//
//   ?mode=plateau (default)  the UI reads only from plateau. One tab, the plateau leader, holds the
//                            stream and writes what it learns into plateau; every tab re-queries
//                            when plateau says a commit wrote `orders`.
//   ?mode=rest               the same UI reading straight from REST: each tab holds its own stream
//                            and re-fetches the list when anything changes.
//   ?db=<name>               the database name (the measurements use a fresh one per run).

import { plateau, runtime, type PlateauDatabase, type PlateauRequest, type PlateauTransaction } from "plateaudb";
import { readStream, type SseEvent } from "./sse";
import { TOP, type AppProbe, type Order, type View } from "./model";

const params = new URLSearchParams(location.search);
const mode: "plateau" | "rest" = params.get("mode") === "rest" ? "rest" : "plateau";
const DB = `live-sync-${params.get("db") ?? "demo"}`;
const STREAM = "/live-updates";
/** Rows per readwrite transaction in a bulk load. */
const BULK_CHUNK = 10_000;
/** Order fetches in flight at once while applying a batch of changes. */
const FETCHES = 16;

const rowsEl = document.getElementById("rows")!;
const countEl = document.getElementById("count")!;
const statusEl = document.getElementById("status")!;

const now = () => performance.timeOrigin + performance.now();

const probe: AppProbe = {
  mode,
  firstRender: null,
  caughtUp: null,
  seen: new Map(),
  stages: new Map(),
  role: () => (mode === "plateau" ? runtime().role : "rest"),
  streamState: () => streamState,
  stored: async () => (mode === "plateau" ? (await readView(await database())).count : (await fetchView()).count),
  rendered: (id, version, timeoutMs) =>
    new Promise((resolve) => {
      if ((lastView?.rows ?? []).some((r) => r.id === id && r.version >= version)) return resolve(true);
      const t = setTimeout(() => (waiting.delete(w), resolve(false)), timeoutMs);
      const w = { id, version, done: () => (clearTimeout(t), resolve(true)) };
      waiting.add(w);
    }),
  versionsOf: async (ids) => {
    const store = (await database()).transaction("orders", "readonly").objectStore("orders");
    const out: Record<number, number> = {};
    if (ids === null) {
      for (const o of await req<Order[]>(store.getAll())) out[o.id] = o.version;
    } else {
      const rows = await Promise.all(ids.map((id) => req<Order | undefined>(store.get(id))));
      ids.forEach((id, i) => {
        if (rows[i]) out[id] = rows[i]!.version;
      });
    }
    return out;
  },
  readies: [],
  reconnects: 0,
  opened: [],
  closed: [],
};
window.app = probe;

const waiting = new Set<{ id: number; version: number; done: () => void }>();
let streamState = "connecting";
let lastView: View | null = null;

// plateau

const COLUMNS = {
  id: { kind: "f64" },
  version: { kind: "u32" },
  updatedAt: { kind: "f64", index: "ordered" },
  editedAt: { kind: "f64" },
  total: { kind: "f64" },
  status: { kind: "u32", index: "bitmap" },
  title: { kind: "str" },
  customer: { kind: "str" },
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

let opening: Promise<PlateauDatabase> | null = null;
function database(): Promise<PlateauDatabase> {
  opening ??= (async () => {
    const open = plateau.open(DB, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore("orders", { keyPath: "id", columns: COLUMNS } as never);
      open.result.createObjectStore("meta");
    };
    const db = await req<PlateauDatabase>(open);
    db.observe("orders", scheduleRefresh);
    return db;
  })();
  return opening;
}

async function readView(db: PlateauDatabase): Promise<View> {
  const tx = db.transaction("orders", "readonly");
  const store = tx.objectStore("orders");
  const [rows, count] = await Promise.all([req<Order[]>(store.query({ orderBy: { field: "updatedAt", desc: true }, limit: TOP })), req<number>(store.count())]);
  return { rows, count };
}

async function fetchView(): Promise<View> {
  const res = await fetch(`/orders?top=${TOP}`, { cache: "no-store" });
  return (await res.json()) as View;
}

// Rendering: one read per frame at most.

let scheduled = false;
let reading = false;
let again = false;
function scheduleRefresh(): void {
  if (scheduled) return;
  scheduled = true;
  const run = () => {
    scheduled = false;
    void refresh();
  };
  // A hidden page gets no animation frames.
  if (document.hidden) setTimeout(run, 0);
  else requestAnimationFrame(run);
}

async function refresh(): Promise<void> {
  if (reading) {
    again = true;
    return;
  }
  reading = true;
  try {
    const view = mode === "plateau" ? await readView(await database()) : await fetchView();
    render(view);
  } catch {
    // The leader tab closed under this read, or the network dropped: read again once the next
    // leader serves this tab.
    again = true;
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    reading = false;
    if (again) {
      again = false;
      scheduleRefresh();
    }
  }
}

const fmtTime = (t: number) => new Date(t).toISOString().slice(11, 23);

function render(view: View): void {
  lastView = view;
  countEl.textContent = `(${view.count.toLocaleString()})`;
  rowsEl.innerHTML = view.rows
    .map((o) => `<tr><td>${o.id}</td><td>${esc(o.title)}</td><td>${esc(o.customer)}</td><td>${o.status}</td><td>${o.total.toFixed(2)}</td><td>${o.version}</td><td>${fmtTime(o.updatedAt)}</td></tr>`)
    .join("");
  const t = now();
  for (const o of view.rows) {
    if (o.editedAt > 0) {
      const key = `${o.id}:${o.version}`;
      if (!probe.seen.has(key)) probe.seen.set(key, t);
    }
  }
  if (probe.firstRender === null && view.count > 0) probe.firstRender = performance.now();
  for (const w of [...waiting]) {
    if (view.rows.some((r) => r.id === w.id && r.version >= w.version)) {
      waiting.delete(w);
      w.done();
    }
  }
  paintStatus();
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
function paintStatus(): void {
  const role = probe.role();
  // Only the leader holds a stream in plateau mode; the other tabs read what it writes.
  const stream = mode === "plateau" && role !== "leader" ? "held by the leader" : `stream ${streamState}`;
  statusEl.textContent = `${mode} · ${role} · ${stream} · ${lastView?.count ?? 0} orders`;
}

// Sync: the stream and the writes it causes.

async function getOrder(id: number): Promise<Order | null> {
  const res = await fetch(`/orders/${id}`, { cache: "no-store" });
  return res.ok ? ((await res.json()) as Order) : null;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** Fetches every order and puts it into plateau, 10,000 rows per transaction; `cursor` is saved in
 * the last one, so a bulk load interrupted half way is repeated from the cursor the app had. */
async function bulkLoad(db: PlateauDatabase, cursor: string | null): Promise<void> {
  const res = await fetch("/orders", { cache: "no-store" });
  const all = (await res.json()) as Order[];
  // Newest first, so the first commit already holds the rows the list shows.
  all.sort((a, b) => b.updatedAt - a.updatedAt);
  for (let at = 0; at < all.length; at += BULK_CHUNK) {
    const tx = db.transaction(cursor !== null && at + BULK_CHUNK >= all.length ? ["orders", "meta"] : "orders", "readwrite");
    const orders = tx.objectStore("orders");
    const end = Math.min(at + BULK_CHUNK, all.length);
    for (let i = at; i < end; i++) orders.put(all[i]);
    if (cursor !== null && end === all.length) tx.objectStore("meta").put(cursor, "cursor");
    await done(tx);
  }
}

async function syncLeader(): Promise<void> {
  await plateau.whenLeader();
  const db = await database();
  paintStatus();
  /** The changed order ids of the batch being read, in arrival order. */
  let pending: { id: number; at: number }[] = [];
  let resync = false;
  let freshId: string | null = null;

  const onEvent = async (e: SseEvent): Promise<void> => {
    switch (e.event) {
      case "change": {
        const { id } = JSON.parse(e.data) as { id: number };
        pending.push({ id, at: now() });
        break;
      }
      case "cursor": {
        // Everything before the cursor is applied, then the cursor is saved, in one transaction.
        const batch = pending;
        pending = [];
        if (resync) {
          resync = false;
          await bulkLoad(db, e.id ?? null);
          break;
        }
        const ids = [...new Set(batch.map((p) => p.id))];
        const fetchedAt = new Map<number, number>();
        const orders = await mapLimit(ids, FETCHES, async (id) => {
          const o = await getOrder(id);
          fetchedAt.set(id, now());
          return o;
        });
        const tx = db.transaction(["orders", "meta"], "readwrite");
        const store = tx.objectStore("orders");
        for (const o of orders) if (o) store.put(o);
        if (e.id) tx.objectStore("meta").put(e.id, "cursor");
        await done(tx);
        const committed = now();
        for (const o of orders) {
          if (!o || o.editedAt <= 0) continue;
          const first = batch.find((p) => p.id === o.id)!;
          probe.stages.set(`${o.id}:${o.version}`, { event: first.at, fetched: fetchedAt.get(o.id)!, committed });
        }
        break;
      }
      case "ready": {
        const { fresh } = JSON.parse(e.data) as { fresh: boolean };
        if (fresh) {
          // No cursor: the whole list is the first state; the cursor in `ready` is where the
          // stream goes on from.
          freshId = e.id ?? null;
          await bulkLoad(db, freshId);
        }
        probe.readies.push(now());
        if (probe.caughtUp === null) probe.caughtUp = performance.now();
        break;
      }
      case "resync":
        // The saved cursor is older than the server's history: reload everything, and save the
        // cursor that follows.
        resync = true;
        pending = [];
        break;
    }
  };

  await readStream({
    url: STREAM,
    cursor: async () => {
      const tx = db.transaction("meta", "readonly");
      return (await req<string | undefined>(tx.objectStore("meta").get("cursor"))) ?? null;
    },
    onEvent,
    onState: onState,
    signal: new AbortController().signal,
  });
}

function onState(s: "connecting" | "open" | "closed", detail?: string): void {
  streamState = detail ? `${s} (${detail})` : s;
  if (s === "open") probe.opened.push(now());
  if (s === "closed") probe.closed.push(now());
  if (s === "connecting") probe.reconnects++;
  paintStatus();
}

/** REST mode: this tab's own stream; any change means the list may be out of date. */
async function syncRest(): Promise<void> {
  let cursor: string | null = null;
  await readStream({
    url: STREAM,
    cursor: () => cursor,
    onEvent: (e) => {
      if (e.event === "cursor" || (e.event === "ready" && JSON.parse(e.data).fresh)) cursor = e.id ?? cursor;
      if (e.event === "ready") probe.readies.push(now());
      if (e.event === "ready" && probe.caughtUp === null) probe.caughtUp = performance.now();
      if (e.event === "change" || e.event === "resync" || e.event === "ready") scheduleRefresh();
    },
    onState,
    signal: new AbortController().signal,
  });
}

// Start.

if (mode === "plateau") {
  // First render: what plateau holds already (a return visit shows it before the network answers).
  void database().then(refresh);
  void syncLeader();
} else {
  void refresh();
  void syncRest();
}
