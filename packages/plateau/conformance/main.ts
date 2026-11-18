// The conformance page: `?impl=native` runs the tests against the browser's IndexedDB,
// `?impl=plateau` against plateau's API. The runner reads `window.results`.

import { plateau, PlateauKeyRange } from "../src/index";
import { run, type Env, type Result } from "./harness";
import "./tests";

declare global {
  interface Window {
    results?: Result[];
  }
}

const search = new URLSearchParams(location.search);
const impl = search.get("impl") === "plateau" ? "plateau" : "native";
const env: Env =
  impl === "native"
    ? { impl, factory: indexedDB, KeyRange: IDBKeyRange }
    : { impl, factory: plateau as unknown as IDBFactory, KeyRange: PlateauKeyRange as unknown as typeof IDBKeyRange };

const status = document.getElementById("status")!;
status.textContent = `running ${impl}`;
run(env, search.get("filter") ?? undefined).then((results) => {
  window.results = results;
  status.textContent = "done";
});
