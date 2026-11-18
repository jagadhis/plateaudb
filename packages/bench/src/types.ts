import type { Issue, Q1, Q2, Q3, Q4 } from "./workload";

export type EngineName = "idb" | "sqlite" | "plateau" | "plateau-idb" | "plateau-idb-generic";

/** Milliseconds per step; the total excludes data generation. */
export interface Timed {
  totalMs: number;
  parts: Record<string, number>;
}

export interface Engine {
  readonly name: EngineName;
  readonly where: "main thread" | "dedicated worker";
  /** Creates an empty database in this origin's storage. */
  create(): Promise<Timed>;
  /** Generates rows [0, size) in chunks (untimed) and inserts them (timed). */
  load(seed: number, size: number, chunk: number): Promise<Timed>;
  getMany(ids: number[]): Promise<(Issue | null)[]>;
  q1(p: Q1): Promise<Issue[]>;
  q2(p: Q2): Promise<Issue[]>;
  q3(p: Q3): Promise<number>;
  q4(p: Q4): Promise<Issue[]>;
  /** Generates update batch `batch` of `updateBatches(seed, size)` in the engine's thread
   * (untimed) and keeps it for `applyUpdate`. */
  prepareUpdate(seed: number, size: number, batch: number): Promise<void>;
  /** Applies the prepared batch the engine's native way (replace the rows, delete the ids) and
   * commits it durably. */
  applyUpdate(): Promise<Timed>;
  /** Rewrites the database without deleted and replaced rows, where the engine has such a step. */
  compact?(): Promise<Timed>;
  /** Closes the database (and its worker, if any). */
  close(): Promise<void>;
  /** Opens the persisted database from scratch (a new worker for worker engines). */
  open(): Promise<Timed>;
  /** The access path of the last query, where the engine reports one. */
  lastPlan?: string;
  /** Time the last call spent inside the worker (engine work, no hop), for worker engines. */
  lastWorkerMs?: number;
  /** Facts gathered after the load (sizes, query plans; plateau engines: `wasmMemoryBytes`,
   * `fileBytes`, `cachedBytes`, `budgetBytes`). */
  details?(): Promise<Record<string, unknown>>;
  /** Engine facts for the result file (versions, settings, workarounds). */
  info(): Record<string, unknown>;
}

export type Request = { id: number; op: string; args: unknown[] };
export type Response = { id: number; ok: true; value: unknown; plan?: string; workerMs: number; sentAt: number } | { id: number; ok: false; error: string };
