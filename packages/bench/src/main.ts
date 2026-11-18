import { IdbEngine } from "./engines/idb";
import { WorkerEngine } from "./engines/worker-engine";
import { runtime } from "./engines/runtime";
import { freshRun, runEngine, runUpdates, type FreshResult, type RunOptions } from "./harness";
import type { Engine, EngineName } from "./types";
import { budgetOf } from "./workload";

// A fresh-page run (`?fresh=<engine>&size=..&runs=..&k=..`) opens the database left by the main
// run and times its first Q1 from navigation start. A worker engine's runtime starts here, first
// thing, as an app would start it by importing the library.
const search = new URLSearchParams(location.search);
/** The engine spec, with a memory budget variant if any (`plateau@24mb`). */
const freshSpec = search.get("fresh");
const freshEngine = (freshSpec?.split("@")[0] ?? null) as EngineName | null;
if (freshEngine === "plateau" || freshEngine === "sqlite") runtime(freshEngine);
// plateau-idb's API is loaded only by pages that use it, so the other engines' bundle stays as it was.
const plateauIdb =
  freshEngine === "plateau-idb" || freshEngine === "plateau-idb-generic" ? import("./engines/plateau-idb").then((m) => (m.startPlateauIdb(freshEngine), m)) : null;

/** `spec` is an engine name, for a plateau engine optionally with a memory budget variant. */
async function makeEngine(spec: string): Promise<Engine> {
  const name = spec.split("@")[0] as EngineName;
  const budget = budgetOf(spec);
  if (budget !== undefined && !name.startsWith("plateau")) throw new Error(`${name} has no memory budget`);
  switch (name) {
    case "idb":
      return new IdbEngine();
    case "sqlite":
      return new WorkerEngine(name);
    case "plateau":
      return new WorkerEngine(name, budget);
    case "plateau-idb":
      return new (await (plateauIdb ?? import("./engines/plateau-idb"))).PlateauIdbEngine(budget);
    case "plateau-idb-generic":
      return new IdbEngine((await (plateauIdb ?? import("./engines/plateau-idb"))).genericSource(budget));
  }
  throw new Error(`unknown engine ${spec}`);
}

/** Smallest observable step of performance.now(), in ms. */
function timerResolution(): number {
  let best = Infinity;
  for (let i = 0; i < 50; i++) {
    const a = performance.now();
    let b = performance.now();
    while (b === a) b = performance.now();
    best = Math.min(best, b - a);
  }
  return Math.round(best * 1e6) / 1e6;
}

const bench = {
  env() {
    return {
      userAgent: navigator.userAgent,
      crossOriginIsolated: globalThis.crossOriginIsolated,
      hardwareConcurrency: navigator.hardwareConcurrency,
      timerResolutionMs: timerResolution(),
      opfs: typeof navigator.storage?.getDirectory === "function",
    };
  },
  async run(engine: string, o: RunOptions) {
    return { ...(await runEngine(await makeEngine(engine), o)), engine };
  },
  async updates(engine: string, o: RunOptions) {
    return { ...(await runUpdates(await makeEngine(engine), o)), engine };
  },
};

declare global {
  interface Window {
    bench: typeof bench;
    freshResult?: FreshResult;
  }
}

window.bench = bench;
const status = document.getElementById("status")!;
if (freshEngine) {
  const n = (k: string) => Number(search.get(k));
  makeEngine(freshSpec!).then((e) => freshRun(e, n("size"), n("runs"), n("k"))).then((r) => {
    window.freshResult = r;
    status.textContent = "fresh done";
    console.log("fresh done");
  });
} else {
  status.textContent = "ready";
}
