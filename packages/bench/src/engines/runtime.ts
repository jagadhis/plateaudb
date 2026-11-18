// A worker engine's runtime: one dedicated worker per page, started once and kept for the life of
// the page. Closing a database releases its file handle, not the runtime, as IndexedDB's backend
// outlives a connection. Every engine that runs in a worker (SQLite, plateau) gets this model.

import { take } from "../boot";
import { WorkerClient } from "./rpc";

export interface Runtime {
  readonly client: WorkerClient;
  /** Resolves when the worker has started; carries the start-up steps in ms. Requests need not
   * wait for it: the worker orders them behind its own start-up. */
  readonly ready: Promise<Record<string, number>>;
}

const PLATEAU_WASM = new URL("../../../../crates/engine/pkg/plateau_engine_bg.wasm", import.meta.url).href;

/** Starts plateau's runtime: a worker that instantiates the WASM Module this thread compiles
 * (`compileStreaming` from a stable URL, which lets Chromium cache the compiled code). On a page
 * whose head bootstrap already started both, attaches to them instead. */
function plateauRuntime(): Runtime {
  const taken = take("plateau", "worker");
  const boot = taken?.boot;
  if (taken && boot?.init) {
    const client = new WorkerClient(taken.value);
    const t0 = boot.startedAt;
    const ready = boot.init.then((res) => {
      if (!res.ok) throw new Error(res.error);
      return { bootstrap: 1, wasmCompile: (boot.compiledAt ?? NaN) - t0, ...steps(res.value as Record<string, number>, t0), runtimeReady: performance.now() - t0, runtimeStartedAt: t0 };
    });
    return { client, ready };
  }
  const t0 = performance.now();
  const worker = new Worker(new URL("./plateau.worker.ts", import.meta.url), { type: "module" });
  const client = new WorkerClient(worker);
  const compiled = WebAssembly.compileStreaming(fetch(PLATEAU_WASM)).catch(async () =>
    WebAssembly.compile(await (await fetch(PLATEAU_WASM)).arrayBuffer()),
  );
  const ready = compiled.then(async (module) => {
    const compileMs = performance.now() - t0;
    const reply = await client.call<Record<string, number>>("init", module);
    return { wasmCompile: compileMs, ...steps(reply, t0), runtimeReady: performance.now() - t0, runtimeStartedAt: t0 };
  });
  return { client, ready };
}

/** The worker's start-up steps on the page's clock, in ms from `t0`. */
function steps(reply: Record<string, number>, t0: number): Record<string, number> {
  const { workerCreatedAt, workerEvaluatedAt, initReceivedAt, ...inner } = reply;
  const rel = (abs: number) => abs - performance.timeOrigin - t0;
  return { workerCreated: rel(workerCreatedAt), workerEvaluated: rel(workerEvaluatedAt), initReceived: rel(initReceivedAt), ...inner };
}

function sqliteRuntime(): Runtime {
  const boot = take("sqlite", "worker");
  const t0 = boot?.boot.startedAt ?? performance.now();
  const worker = boot?.value ?? new Worker(new URL("./sqlite.worker.ts", import.meta.url), { type: "module" });
  const client = new WorkerClient(worker);
  // SQLite's worker starts loading its WASM when it starts; the worker itself is the runtime.
  const ready = Promise.resolve({ ...(boot ? { bootstrap: 1 } : {}), runtimeReady: performance.now() - t0, runtimeStartedAt: t0 });
  return { client, ready };
}

const runtimes = new Map<string, Runtime>();

/** The page's runtime for `engine`, started on first use. A page that knows it will use an engine
 * calls this as early as it can, the way an app would import the library at start-up. */
export function runtime(engine: "plateau" | "sqlite"): Runtime {
  let rt = runtimes.get(engine);
  if (!rt) {
    rt = engine === "plateau" ? plateauRuntime() : sqliteRuntime();
    runtimes.set(engine, rt);
  }
  return rt;
}
