// A server-sent event reader over `fetch`. The browser's EventSource cannot send a stored cursor
// as `Last-Event-ID` on a first connect (and cannot send headers at all), so the app reads the
// stream itself: it opens `GET /live-updates` with the cursor it saved, parses events as they
// arrive, and reconnects after the server's `retry` delay.

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export interface SseOptions {
  url: string;
  /** The cursor to resume from, read each time a connection opens. */
  cursor: () => Promise<string | null> | string | null;
  /** Called for each event, in order; the next event waits until it returns. */
  onEvent: (e: SseEvent) => Promise<void> | void;
  /** The connection state changed. */
  onState?: (s: "connecting" | "open" | "closed", detail?: string) => void;
  signal: AbortSignal;
}

const DEFAULT_RETRY = 3000;

/** Runs until `signal` aborts: connect, read events, and on any end or error wait `retry` ms and
 * connect again with the cursor the app has by then. */
export async function readStream(o: SseOptions): Promise<void> {
  let retry = DEFAULT_RETRY;
  while (!o.signal.aborted) {
    o.onState?.("connecting");
    try {
      const last = await o.cursor();
      const res = await fetch(o.url, {
        headers: { Accept: "text/event-stream", ...(last ? { "Last-Event-ID": last } : {}) },
        cache: "no-store",
        signal: o.signal,
      });
      if (!res.ok || !res.body) throw new Error(`live-updates answered ${res.status}`);
      o.onState?.("open");
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let at: number;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const e = parseBlock(block);
          if (e.retry !== undefined) retry = e.retry;
          if (e.event) await o.onEvent(e.event);
        }
      }
      o.onState?.("closed", "the server ended the stream");
    } catch (err) {
      if (o.signal.aborted) return;
      o.onState?.("closed", (err as Error).message);
    }
    await new Promise<void>((r) => {
      const t = setTimeout(r, retry);
      o.signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
    });
  }
}

function parseBlock(block: string): { event?: SseEvent; retry?: number } {
  let event = "";
  let id: string | undefined;
  let retry: number | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + (line[colon + 1] === " " ? 2 : 1));
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
    else if (field === "retry" && /^\d+$/.test(value)) retry = Number(value);
  }
  return { event: event ? { event, data: data.join("\n"), id } : undefined, retry };
}
