import type { Request, Response } from "../types";

/** Main-thread side: one pending promise per request id. */
export class WorkerClient {
  private next = 1;
  private pending = new Map<number, { resolve: (r: Response) => void }>();
  lastPlan: string | undefined;
  lastWorkerMs: number | undefined;
  /** How long the last response waited between the worker posting it and this thread running it. */
  lastDeliveryMs: number | undefined;

  constructor(readonly worker: Worker) {
    worker.onmessage = (e: MessageEvent<Response>) => {
      const p = this.pending.get(e.data.id);
      this.pending.delete(e.data.id);
      p?.resolve(e.data);
    };
    worker.onerror = (e) => {
      const err = { ok: false as const, error: `worker error: ${e.message}` };
      for (const [id, p] of this.pending) p.resolve({ id, ...err });
      this.pending.clear();
    };
  }

  async call<T>(op: string, ...args: unknown[]): Promise<T> {
    const id = this.next++;
    const res = await new Promise<Response>((resolve) => {
      this.pending.set(id, { resolve });
      this.worker.postMessage({ id, op, args } satisfies Request);
    });
    if (!res.ok) throw new Error(res.error);
    this.lastPlan = res.plan;
    this.lastWorkerMs = res.workerMs;
    this.lastDeliveryMs = performance.timeOrigin + performance.now() - res.sentAt;
    return res.value as T;
  }

  terminate(): void {
    this.worker.terminate();
  }
}

/** Worker side: dispatches requests to handlers. A handler may return `{ value, plan }` via `withPlan`. */
export function serve(handlers: Record<string, (...args: any[]) => unknown>): void {
  self.onmessage = async (e: MessageEvent<Request>) => {
    const { id, op, args } = e.data;
    try {
      const h = handlers[op];
      if (!h) throw new Error(`unknown op ${op}`);
      const t = performance.now();
      const out = await h(...args);
      const workerMs = performance.now() - t;
      const sentAt = performance.timeOrigin + performance.now();
      if (out instanceof WithPlan) {
        (self as unknown as Worker).postMessage({ id, ok: true, value: out.value, plan: out.plan, workerMs, sentAt } satisfies Response);
      } else {
        (self as unknown as Worker).postMessage({ id, ok: true, value: out, workerMs, sentAt } satisfies Response);
      }
    } catch (err) {
      const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      (self as unknown as Worker).postMessage({ id, ok: false, error } satisfies Response);
    }
  };
}

export class WithPlan {
  constructor(
    readonly value: unknown,
    readonly plan: string,
  ) {}
}
