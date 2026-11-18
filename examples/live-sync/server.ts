// A stand-in for an orders app's backend: orders over REST, and `GET /live-updates` as a
// server-sent event stream with a fixed wire contract (see README.md). Everything is in memory. It also
// serves the built client from `dist/` and a few admin endpoints the measurements use.
//
//   bun server.ts [--port 5190] [--orders 1000] [--poll-ms 1000]
//
// POLL_MS is the delay between a PATCH and the hub writing it to the open streams: 0 writes it at
// once, 1000 mimics a backend that polls its change table every second.

import { existsSync } from "node:fs";
import { join, normalize } from "node:path";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const PORT = Number(arg("port", process.env.PORT ?? "5190"));
const HEARTBEAT_MS = 20_000;
const CLOSE_AFTER_MS = 540_000;
const DIST = join(import.meta.dir, "dist");
const SITE = join(import.meta.dir, "..", "..", "site");

interface Order {
  id: number;
  version: number;
  updatedAt: number;
  editedAt: number;
  total: number;
  status: number;
  title: string;
  customer: string;
}

const orders = new Map<number, Order>();
/** The change log: entry `i` has seq `base + i`. A cursor is the next seq a client has not seen. */
let changes: number[] = [];
let base = 0;
/** Cursors below this are older than the retention horizon (`resync`). */
let horizon = 0;
let pollMs = Number(arg("poll-ms", process.env.POLL_MS ?? "1000"));
let refuseUntil = 0;
/** Names this server's history: a cursor from another run (the server restarted or was reseeded)
 * is older than anything it can replay, so it gets `resync`. */
let epoch = Date.now();
let bodyCache: { watermark: number; text: string } | null = null;

const watermark = () => base + changes.length;
const cursorOf = (n: number) => `${epoch.toString(36)}-${n.toString(36)}`;
/** The watermark in a cursor, -1 for a cursor of another run (replayable from nowhere), null if unparsable. */
function parseCursor(s: string): number | null {
  const m = /^([0-9a-z]{1,12})-([0-9a-z]{1,12})$/.exec(s);
  if (!m) return null;
  const n = parseInt(m[2], 36);
  if (!Number.isSafeInteger(n)) return null;
  return m[1] === epoch.toString(36) ? n : -1;
}

const STATUSES = 6;
function seed(n: number): void {
  orders.clear();
  epoch = Date.now();
  changes = [];
  base = 0;
  horizon = 0;
  bodyCache = null;
  const t0 = Date.now() - n * 1000;
  for (let id = 1; id <= n; id++) {
    orders.set(id, {
      id,
      version: 1,
      updatedAt: t0 + id * 1000,
      editedAt: 0,
      total: ((id * 7919) % 100000) / 100,
      status: id % STATUSES,
      title: `Order ${id}: ${["bracket", "housing", "gear", "clip", "mount", "valve"][id % 6]} x${(id % 40) + 1}`,
      customer: `Customer ${(id * 31) % 500}`,
    });
  }
}
seed(Number(arg("orders", process.env.ORDERS ?? "1000")));

interface Stream {
  id: number;
  write(chunk: string): boolean;
  end(): void;
  /** The next seq this stream has not been sent. */
  sent: number;
  ready: boolean;
}
const streams = new Set<Stream>();
let nextStream = 1;

const enc = new TextEncoder();
const sse = (event: string, data: string, id?: string) => `${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${data}\n\n`;

/** Writes the changes since `s.sent` to `s`: one `change` per distinct order, then `cursor`. */
function flush(s: Stream): void {
  const mark = watermark();
  if (!s.ready || s.sent >= mark) return;
  const ids = new Set<number>();
  for (let q = s.sent; q < mark; q++) ids.add(changes[q - base]);
  let out = "";
  for (const id of ids) out += sse("change", JSON.stringify({ kind: "order", id }));
  out += sse("cursor", "{}", cursorOf(mark));
  s.sent = mark;
  s.write(out);
}
const flushAll = () => {
  for (const s of streams) flushSafe(s);
};
function flushSafe(s: Stream): void {
  try {
    flush(s);
  } catch {
    streams.delete(s);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
function arm(): void {
  if (timer) clearInterval(timer);
  timer = pollMs > 0 ? setInterval(flushAll, pollMs) : null;
}
arm();

function record(o: Order): void {
  changes.push(o.id);
  bodyCache = null;
  if (pollMs === 0) flushAll();
}

function openStream(req: Request): Response {
  if (Date.now() < refuseUntil) return new Response("refusing connections", { status: 503 });
  const header = req.headers.get("last-event-id");
  let from: number | null = null;
  if (header !== null && header !== "") {
    from = parseCursor(header);
    if (from === null) return new Response("unparsable cursor", { status: 400 });
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const s: Stream = {
        id: nextStream++,
        sent: from ?? 0,
        ready: false,
        write(chunk) {
          if (closed) throw new Error("closed");
          controller.enqueue(enc.encode(chunk));
          return true;
        },
        end() {
          if (closed) return;
          closed = true;
          streams.delete(s);
          clearInterval(beat);
          clearTimeout(limit);
          try {
            controller.close();
          } catch {}
        },
      };
      const beat = setInterval(() => {
        try {
          s.write(": heartbeat\n\n");
        } catch {
          s.end();
        }
      }, HEARTBEAT_MS);
      const limit = setTimeout(() => s.end(), CLOSE_AFTER_MS);
      s.write("retry: 3000\n\n: live-updates\n\n");
      const mark = watermark();
      if (from === null) {
        s.sent = mark;
        s.write(sse("ready", '{"fresh":true}', cursorOf(mark)));
      } else if (from < 0 || from < horizon || from > mark) {
        s.write(sse("resync", "{}"));
        s.sent = mark;
        s.write(sse("cursor", "{}", cursorOf(mark)));
        s.write(sse("ready", '{"fresh":false}'));
      } else {
        // Catch-up: the changes since the cursor, then a cursor, then `ready`.
        let out = "";
        const ids = new Set<number>();
        for (let q = from; q < mark; q++) ids.add(changes[q - base]);
        for (const id of ids) out += sse("change", JSON.stringify({ kind: "order", id }));
        s.sent = mark;
        s.write(out + sse("cursor", "{}", cursorOf(mark)) + sse("ready", '{"fresh":false}'));
      }
      s.ready = true;
      streams.add(s);
      req.signal.addEventListener("abort", () => s.end());
    },
    cancel() {},
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
const json = (v: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(v), { ...init, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(init?.headers ?? {}) } });

function allOrders(): string {
  const mark = watermark();
  if (!bodyCache || bodyCache.watermark !== mark) bodyCache = { watermark: mark, text: JSON.stringify([...orders.values()]) };
  return bodyCache.text;
}

function top(n: number): Order[] {
  // A bounded selection of the n most recently updated: a scan, the way a REST backend with an
  // index on updated_at would serve it, without the index.
  const best: Order[] = [];
  for (const o of orders.values()) {
    if (best.length === n && o.updatedAt <= best[best.length - 1].updatedAt) continue;
    let i = best.length;
    while (i > 0 && best[i - 1].updatedAt < o.updatedAt) i--;
    best.splice(i, 0, o);
    if (best.length > n) best.pop();
  }
  return best;
}

async function patch(id: number, req: Request): Promise<Response> {
  const o = orders.get(id);
  if (!o) return json({ error: "not found" }, { status: 404 });
  const b = (await req.json().catch(() => ({}))) as Partial<Pick<Order, "title" | "status" | "total" | "editedAt">>;
  if (typeof b.title === "string") o.title = b.title;
  if (typeof b.status === "number") o.status = b.status;
  if (typeof b.total === "number") o.total = b.total;
  if (typeof b.editedAt === "number") o.editedAt = b.editedAt;
  o.version++;
  o.updatedAt = Math.max(Date.now(), o.updatedAt + 1);
  record(o);
  return json(o);
}

async function admin(url: URL, req: Request): Promise<Response> {
  const q = url.searchParams;
  switch (url.pathname) {
    case "/admin/state":
      return json({ orders: orders.size, watermark: watermark(), horizon, streams: streams.size, pollMs, refuseMs: Math.max(0, refuseUntil - Date.now()) });
    case "/admin/drop": {
      const refuse = Number(q.get("refuse") ?? 0);
      refuseUntil = refuse > 0 ? Date.now() + refuse : 0;
      const n = streams.size;
      for (const s of [...streams]) s.end();
      return json({ dropped: n });
    }
    case "/admin/reseed":
      seed(Number(q.get("n") ?? 1000));
      for (const s of [...streams]) s.end();
      return json({ orders: orders.size });
    case "/admin/purge":
      // Retention forgets the change log up to now: any cursor below the watermark resyncs.
      horizon = watermark();
      return json({ horizon });
    case "/admin/poll":
      pollMs = Number(q.get("ms") ?? 1000);
      arm();
      return json({ pollMs });
    case "/admin/version": {
      return json({ id: Number(q.get("id")), version: orders.get(Number(q.get("id")))?.version ?? null });
    }
    case "/admin/versions": {
      const out: Record<number, number> = {};
      for (const o of orders.values()) out[o.id] = o.version;
      return json(out);
    }
  }
  void req;
  return new Response("not found", { status: 404 });
}

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  wasm: "application/wasm",
  json: "application/json",
};

function staticFile(pathname: string): Response {
  // The project site is served at /site/ so its "Try it" section can embed the demo from this origin.
  const site = pathname.startsWith("/site/");
  let rel = normalize(decodeURIComponent(site ? pathname.slice("/site/".length) : pathname)).replace(/^([/\\])+/, "");
  if (rel === "." || rel === "") rel = "index.html";
  else if (rel.endsWith("/")) rel += "index.html";
  if (rel.startsWith("..")) return new Response("bad path", { status: 400 });
  const path = join(site ? SITE : DIST, rel);
  if (!existsSync(path)) return new Response("not found", { status: 404 });
  const ext = path.split(".").pop() ?? "";
  if (site) return new Response(Bun.file(path), { headers: { "Content-Type": MIME[ext] ?? "application/octet-stream", "Cache-Control": "no-cache" } });
  const headers: Record<string, string> = {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    // Cross-origin isolation, as the bench serves, for precise performance.now().
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  };
  return new Response(Bun.file(path), { headers });
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/live-updates") return req.method === "GET" ? openStream(req) : new Response("method not allowed", { status: 405 });
    if (p.startsWith("/admin/")) return admin(url, req);
    if (p === "/orders" && req.method === "GET") {
      const n = url.searchParams.get("top");
      if (n !== null) return json({ count: orders.size, rows: top(Number(n)) });
      return new Response(allOrders(), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    const m = /^\/orders\/(\d+)$/.exec(p);
    if (m) {
      const id = Number(m[1]);
      if (req.method === "GET") {
        const o = orders.get(id);
        return o ? json(o) : json({ error: "not found" }, { status: 404 });
      }
      if (req.method === "PATCH") return patch(id, req);
    }
    return staticFile(p);
  },
});

console.log(`live-sync server on http://localhost:${server.port} (${orders.size} orders, poll ${pollMs} ms); the project site is at /site/`);
