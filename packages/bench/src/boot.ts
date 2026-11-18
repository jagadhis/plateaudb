// What the head bootstrap in index.html started for this page, if anything. Each piece is taken
// once: the first open of the engine attaches to it, later opens start their own.

import type { Response } from "./types";

export interface Boot {
  engine: string | null;
  /** performance.now() when the bootstrap ran. */
  startedAt: number;
  /** plateau and SQLite: the engine's worker. */
  worker?: Worker;
  /** plateau: the worker's reply to `init` (request id 0) with the Module the bootstrap compiled. */
  init?: Promise<Response>;
  /** plateau: performance.now() when the bootstrap's compile finished. */
  compiledAt?: number;
  /** IndexedDB: the open request issued at navigation. */
  idb?: IDBOpenDBRequest;
}

declare global {
  interface Window {
    __boot?: Boot;
  }
}

/** Takes `key` from the bootstrap if it started `engine`, so it is used once. */
export function take<K extends "worker" | "idb">(engine: string, key: K): { boot: Boot; value: NonNullable<Boot[K]> } | undefined {
  const boot = globalThis.window?.__boot;
  const value = boot?.engine === engine ? boot[key] : undefined;
  if (!boot || !value) return undefined;
  delete boot[key];
  return { boot, value: value as NonNullable<Boot[K]> };
}
