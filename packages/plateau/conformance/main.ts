// The conformance page: `?impl=native` runs the tests against the browser's IndexedDB,
// `?impl=plateau` against plateau's API, `?impl=fallback` against plateau's API forced onto the
// browser's IndexedDB, and `?impl=auto` against plateau's API on whichever backend it chooses
// (the runner removes APIs to make it fall back). The runner reads `window.results` and
// `window.backend`.

import { plateau, PlateauKeyRange, startRuntime } from "../src/index";
import { run, type Env, type Result } from "./harness";
import "./tests";

declare global {
  interface Window {
    results?: Result[];
    backend?: string;
    firstOpen?: string;
  }
}

const search = new URLSearchParams(location.search);
const asked = search.get("impl") ?? "native";
const status = document.getElementById("status")!;

/** The page's first call, made before the backend is chosen (on `auto`): an open whose upgrade
 * creates a store with an index and writes, then reads through the connection it delivers. */
async function firstOpen(): Promise<string> {
  const name = `conf-first-${Date.now().toString(36)}`;
  const r = plateau.open(name, 2);
  const seen: string[] = [];
  r.onupgradeneeded = (e) => {
    seen.push(`upgradeneeded ${e.oldVersion}->${e.newVersion}`);
    const s = r.result.createObjectStore("s", { keyPath: "id" });
    s.createIndex("by_n", "n");
    s.put({ id: 1, n: 7 });
    s.put({ id: 2, n: 7 });
  };
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result as unknown as IDBDatabase);
    r.onerror = () => reject(r.error);
  });
  seen.push(`success v${db.version}`);
  const s = db.transaction("s").objectStore("s");
  const keys = await new Promise((resolve) => (s.index("by_n").getAllKeys(7).onsuccess = (e) => resolve((e.target as IDBRequest).result)));
  seen.push(`index ${JSON.stringify(keys)}`);
  db.close();
  await new Promise((resolve) => (plateau.deleteDatabase(name).onsuccess = resolve));
  return seen.join("; ");
}

async function env(): Promise<Env> {
  if (asked === "native") return { impl: "native", factory: indexedDB, KeyRange: IDBKeyRange };
  if (asked === "fallback") startRuntime({ backend: "indexeddb" });
  if (asked === "auto") window.firstOpen = await firstOpen().catch((e) => `failed: ${(e as Error)?.name}: ${(e as Error)?.message}`);
  const backend = await plateau.chooseBackend();
  return { impl: backend === "opfs" ? "plateau" : "fallback", factory: plateau as unknown as IDBFactory, KeyRange: PlateauKeyRange as unknown as typeof IDBKeyRange };
}

void env().then(async (e) => {
  status.textContent = `running ${e.impl}`;
  const results = await run(e, search.get("filter") ?? undefined);
  window.backend = e.impl === "native" ? "native" : plateau.backend;
  window.results = results;
  status.textContent = "done";
});
