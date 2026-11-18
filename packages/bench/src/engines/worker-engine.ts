// A worker-hosted engine seen from the main thread. Every call is timed by the harness on the
// main thread, so the postMessage round trip and the structured clone of results are included.

import type { Engine, EngineName, Timed } from "../types";
import type { Issue, Q1, Q2, Q3, Q4 } from "../workload";
import type { WorkerClient } from "./rpc";
import { runtime, type Runtime } from "./runtime";

export class WorkerEngine implements Engine {
  readonly where = "dedicated worker" as const;
  private open_ = false;
  private facts: Record<string, unknown> = {};

  /** Only plateau has a compaction step. */
  readonly compact?: () => Promise<Timed>;

  /** `budget`: plateau's memory budget for this variant (`undefined` the default, `null` none). */
  constructor(
    readonly name: EngineName & ("plateau" | "sqlite"),
    private readonly budget?: number | null,
  ) {
    if (name === "plateau") this.compact = () => this.c.call<Timed>("compact");
  }

  private get rt(): Runtime {
    return runtime(this.name);
  }

  get lastPlan(): string | undefined {
    return this.rt.client.lastPlan;
  }

  get lastWorkerMs(): number | undefined {
    return this.rt.client.lastWorkerMs;
  }

  private get c(): WorkerClient {
    if (!this.open_) throw new Error(`${this.name}: not open`);
    return this.rt.client;
  }

  /** Waiting for the runtime is part of opening: the first open in a page pays worker start-up
   * (and plateau's compile), later opens find it running. The request is posted at once; the
   * worker runs it once it is up. */
  private async start(op: "create" | "open"): Promise<Timed> {
    const t = performance.now();
    const rt = this.rt;
    const inner = await rt.client.call<Timed & { info?: Record<string, unknown> }>(op, ...(this.budget === undefined ? [] : [this.budget]));
    const totalMs = performance.now() - t;
    const startup = await rt.ready;
    if (inner.info) this.facts = inner.info;
    this.open_ = true;
    const workerMs = rt.client.lastWorkerMs ?? inner.totalMs;
    const parts: Record<string, number> = {
      ...inner.parts,
      hopAndStartup: totalMs - workerMs,
      replyDelivery: rt.client.lastDeliveryMs ?? NaN,
    };
    // Start-up steps belong to this open only if it was posted before the worker was ready.
    if (startup.runtimeStartedAt + startup.runtimeReady > t) for (const [k, v] of Object.entries(startup)) parts[`runtime.${k}`] = v;
    return { totalMs, parts };
  }

  create(): Promise<Timed> {
    return this.start("create");
  }

  open(): Promise<Timed> {
    return this.start("open");
  }

  async close(): Promise<void> {
    if (!this.open_) return;
    this.open_ = false;
    await this.rt.client.call("close");
  }

  load(seed: number, size: number, chunk: number): Promise<Timed> {
    return this.c.call<Timed>("load", seed, size, chunk);
  }

  prepareUpdate(seed: number, size: number, batch: number): Promise<void> {
    return this.c.call("prepareUpdate", seed, size, batch);
  }

  applyUpdate(): Promise<Timed> {
    return this.c.call<Timed>("applyUpdate");
  }

  getMany(ids: number[]): Promise<(Issue | null)[]> {
    return this.c.call("getMany", ids);
  }

  q1(p: Q1): Promise<Issue[]> {
    return this.c.call("q1", p);
  }

  q2(p: Q2): Promise<Issue[]> {
    return this.c.call("q2", p);
  }

  q3(p: Q3): Promise<number> {
    return this.c.call("q3", p);
  }

  q4(p: Q4): Promise<Issue[]> {
    return this.c.call("q4", p);
  }

  details(): Promise<Record<string, unknown>> {
    return this.c.call("details");
  }

  info(): Record<string, unknown> {
    return this.facts;
  }
}
