// Which backend runs this page's databases, chosen once, at the first call that needs storage,
// and never switched: data written on one is not visible on the other.
//
// - `opfs`: plateau's engine in a worker, on OPFS sync access handles.
// - `indexeddb`: the browser's own `indexedDB`, where the engine cannot run: no OPFS, no module
//   workers, no WebAssembly (checked here), or a worker that cannot open a sync access handle or
//   start the engine (checked by a probe in the worker; a WebKit ephemeral session fails there).
//   `startRuntime({ backend })` skips the checks.

import { useNativeKeyRanges } from "./key";
import { currentRuntime, runtime } from "./runtime";

export type Backend = "opfs" | "indexeddb";

/** The browser's IndexedDB as it was when plateau loaded, before an app could replace it. */
export const nativeIndexedDB: IDBFactory | undefined = typeof indexedDB !== "undefined" ? indexedDB : undefined;

let chosen: Backend | undefined;
let choice: Promise<Backend> | null = null;

/** The backend, once chosen. */
export function chosenBackend(): Backend | undefined {
  return chosen;
}

/** What the main thread can tell at once: why the engine cannot run here, or null. */
function missing(): string | null {
  if (typeof Worker !== "function") return "no Worker";
  if (typeof WebAssembly !== "object" || typeof WebAssembly.compile !== "function") return "no WebAssembly";
  const storage = typeof navigator !== "undefined" ? (navigator.storage as StorageManager | undefined) : undefined;
  if (typeof storage?.getDirectory !== "function") return "no OPFS (navigator.storage.getDirectory)";
  return null;
}

function choose(b: Backend, why?: string): Backend {
  chosen = b;
  if (b === "indexeddb") {
    useNativeKeyRanges();
    runtime().stop(`plateau: this page uses the browser's IndexedDB${why ? ` (${why})` : ""}`);
  }
  return b;
}

/** Chooses the backend if no call has yet, and resolves with it. Synchronous when nothing needs a
 * probe (a requested backend, or something missing on the main thread). */
export function chooseBackend(): Promise<Backend> {
  if (choice) return choice;
  const requested = currentRuntime()?.requested ?? "auto";
  if (!nativeIndexedDB || requested === "opfs") choice = Promise.resolve(choose("opfs"));
  else if (requested === "indexeddb") choice = Promise.resolve(choose("indexeddb"));
  else {
    const why = missing();
    // The runtime still runs the tab election (`whenLeader`); without a worker when it cannot run.
    const rt = runtime(why ? { backend: "indexeddb" } : undefined);
    if (why) choice = Promise.resolve(choose("indexeddb", why));
    else
      choice = rt.call({ t: "probe" }).then(
        () => choose("opfs"),
        (e) => choose("indexeddb", (e as Error)?.message),
      );
  }
  return choice;
}
