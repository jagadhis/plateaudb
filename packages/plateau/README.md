# plateaudb

A browser database with an IndexedDB-compatible API, stored in the Origin Private File System
(OPFS). The engine is written in Rust and compiled to WebAssembly, and runs in a dedicated worker.
It keeps a compressed bitmap of row ids for each value of a field you declare, so a query that
filters on several fields (`team = 7 AND state IN (1, 2) ORDER BY updatedAt DESC LIMIT 50`) costs
roughly the size of its result, not the size of the table.

Status: 0.3.0, pre-1.0. Read [Known limits](#known-limits) before you put data in it that you
cannot rebuild.

## Install

```sh
npm install plateaudb
```

The package ships an ES module, its worker as a separate file, and the `.wasm` engine. The code
names the worker and the WASM with `new URL("./…", import.meta.url)`, which bundlers follow and
copy into your build. Tested with no bundler config: Vite 8 (dev server and `vite build`) and
Next.js 16 (`next build` with Turbopack, and with `--webpack`). It needs no COOP/COEP headers: it
does not use `SharedArrayBuffer`.

esbuild on its own does not copy files named by `new URL(…)`: copy `host.worker.js` and
`plateau_engine_bg.wasm` from `node_modules/plateaudb/dist/` next to your bundle (not tested).

Use it from browser code only. In Next.js, import it in a client component (`"use client"`) and
open databases in an effect, not during server rendering.

## Use it

`plateau` is an `IDBFactory`. Code written for `indexedDB` takes it unchanged:

```js
import { plateau, PlateauKeyRange, promise } from "plateaudb";

const indexedDB = plateau;          // where your code used window.indexedDB
const IDBKeyRange = PlateauKeyRange; // and window.IDBKeyRange

const open = indexedDB.open("shop", 1);
open.onupgradeneeded = () => {
  const store = open.result.createObjectStore("orders", { keyPath: "id" });
  store.createIndex("byStatus", "status");
};
const db = await promise(open); // or open.onsuccess = ...

const tx = db.transaction("orders", "readwrite");
const orders = tx.objectStore("orders");
orders.put({ id: 1, status: "open", total: 40 });
orders.put({ id: 2, status: "shipped", total: 15 });
orders.put({ id: 3, status: "open", total: 22 });

const one = await promise(orders.get(1));
const openOrders = await promise(orders.index("byStatus").getAll("open"));
const cursor = orders.openCursor(IDBKeyRange.lowerBound(2));
cursor.onsuccess = () => {
  const c = cursor.result;
  if (c) { console.log(c.key, c.value); c.continue(); }
};
```

Databases, object stores, indexes (unique and multiEntry), key ranges, cursors, transactions with
auto-commit, and the `upgradeneeded`, `versionchange`, `blocked`, `complete`, `abort`, `success` and
`error` events behave as IndexedDB's do. `promise(request)` is a small helper that resolves with
`request.result` or rejects with `request.error`.

## Multi-key queries: `store.query`

Declare the fields you filter or sort on as typed columns when you create the store, and query
them with `store.query`. Fields you do not declare are stored with the row. A store without
`columns` is a generic store and takes any value IndexedDB stores (see the limits below).

```js
open.onupgradeneeded = () => {
  open.result.createObjectStore("issues", {
    keyPath: "id",
    columns: {
      id:         "f64",                                    // the primary key column must be f64
      teamId:     { kind: "u32", index: "bitmap" },
      stateId:    { kind: "u32", index: "bitmap" },
      labelIds:   { kind: "u32_multi", index: "bitmap" },  // matches if any element matches
      updatedAt:  { kind: "f64", index: "ordered", group: "teamId" },
      title:      "str",
    },
  });
};

const store = db.transaction("issues").objectStore("issues");

// the 50 most recently updated open issues of team 7
const latest = await promise(store.query({
  where: [
    { field: "teamId",  op: "eq", value: 7 },
    { field: "stateId", op: "in", values: [1, 2] },
  ],
  orderBy: { field: "updatedAt", desc: true },
  limit: 50,
}));

// how many changed in team 7 since weekAgo
const n = await promise(store.query({
  where: [
    { field: "teamId",    op: "eq", value: 7 },
    { field: "updatedAt", op: "range", gt: weekAgo },
  ],
  count: true,
}));
```

Filters are ANDed: `eq`, `in`, and `range` with `gt`, `gte`, `lt`, `lte`. Column kinds: `u32`
(ids, enums), `u32_multi` (a list of u32, such as labels), `f64` (numbers, timestamps) and `str`
(stored, not indexed). `bitmap` indexes go on `u32` and `u32_multi`; `ordered` goes on `f64`,
optionally grouped by a bitmap column so an ordered walk inside one group stays short.

## Several tabs

One tab of the origin, the leader, runs the worker and holds the files; the other tabs forward
their calls and transactions to it over `BroadcastChannel`, and Web Locks pick the leader. Your
code does not change: every tab uses the same API. `versionchange` and `blocked` reach every tab
with a connection, as they do natively.

When the leader tab closes, the next tab takes over and reconnects the others. Transactions the
old leader was running for other tabs abort with `UnknownError`; whatever they committed is on
disk. In the bundled live-sync example the new leader was streaming again 10-16 ms after the old
one closed (Chromium and WebKit; 13-18 ms in Firefox's multi-tab tests).

plateau adds two calls for multi-tab apps:

```js
await plateau.whenLeader();   // resolves when this tab is the leader, e.g. to hold one server stream
const stop = db.observe("orders", ({ stores }) => render()); // after a commit in any tab
```

## Where plateau cannot run: the IndexedDB fallback

Where the engine cannot run, `plateau` hands every call to the browser's own `indexedDB`, so code
written against it keeps working. It falls back when the browser has no OPFS
(`navigator.storage.getDirectory`), no `Worker` or no WebAssembly, or when the worker cannot start
the engine or open an OPFS sync access handle: a WebKit ephemeral session (Playwright's default
context) fails there with `UnknownError`, as do browsers without module workers,
`FileSystemSyncAccessHandle` or WebAssembly SIMD.

The backend is chosen once per page, at the first call that needs storage (`open`,
`deleteDatabase`, `databases`, `setMemoryBudget`, `memoryStats`), and never changes after that.
`open` still returns its request at once; the request fires its events when the choice is made.

```js
plateau.backend;                         // "opfs" or "indexeddb"; undefined before the choice
const backend = await plateau.chooseBackend(); // chooses now if no call has yet
```

To skip the check, start the runtime before the first call with the backend you want:
`startRuntime({ backend: "indexeddb" })` (always the browser's IndexedDB) or
`startRuntime({ backend: "opfs" })` (never fall back; opening fails where OPFS does). Every tab of
the origin should ask for the same one.

On the fallback:

- **Data is separate.** What one backend wrote is not visible on the other. A browser that gains
  OPFS support later starts on an empty plateau database; the old data stays in its IndexedDB.
- The objects are the browser's own (`IDBDatabase`, `IDBObjectStore`, ...), with plateau's calls
  added to them. `PlateauKeyRange` returns the browser's `IDBKeyRange`; create key ranges after the
  first `open`, since a range made before the backend is chosen is plateau's own and the browser
  does not take it.
- `createObjectStore(name, { columns })` works; the browser ignores `columns`, so a field of the
  wrong kind is stored instead of throwing `DataError`.
- `store.query` returns what plateau's engine returns for the same records, read from the store
  (an `eq` filter on a field with a `multiEntry` index reads only that index's records), so it
  costs the size of the store, not of the result. It also runs on stores without `columns`;
  `request.plan` is `scan` or `index:<name>`.
- `db.observe` calls back in every tab after a readwrite transaction that opened one of the
  observed stores commits, whether or not it wrote to it.
- `db.compact()` and `plateau.setMemoryBudget()` do nothing; `plateau.memoryStats()` reports zeros
  and the budget last set. `plateau.whenLeader()` works as on OPFS.
- `plateau.databases()` returns the browser's list.

## Memory budget

The worker keeps the parts of each file it has read in memory up to a budget, and drops the least
recently used ones between operations. The default is 64 MiB, or 24 MiB where
`navigator.deviceMemory` is 4 or less.

```js
await plateau.setMemoryBudget(32 * 1024 * 1024); // or null for no limit
const stats = await plateau.memoryStats("shop");  // WASM memory (its peak), budget, cached and file bytes
await db.compact();                               // merge segments and reclaim deleted rows
```

Measured at 1M rows: peak WASM memory 58.9 MiB with the default budget and 29.3 MiB with a 24 MiB
budget on a store with declared columns; 97.1 MiB and 45.4 MiB on a generic store. Random gets
are about 1.6x slower once the working set is larger than the budget. WASM memory never shrinks,
so `memoryStats` reports the peak.

## Browser support

Measured with Playwright on macOS 27.2: Chromium 158, WebKit 27.2 and Firefox 159. In all three
the engine runs on OPFS and passes 87 of 87 conformance tests and the multi-tab tests; the packed
package works in a fresh Vite app in a persistent profile and in a Playwright ephemeral context.

plateau's engine needs OPFS with `FileSystemSyncAccessHandle` in a dedicated worker, module
workers, and WebAssembly SIMD (Chrome 91+, Safari 16.4+, Firefox 89+ ship SIMD). Elsewhere it runs
on the browser's IndexedDB (see [the fallback](#where-plateau-cannot-run-the-indexeddb-fallback)).

In a WebKit ephemeral session (Playwright's default, non-persistent context) OPFS is not available,
so plateau runs on the fallback; with a persistent profile it runs on OPFS. Firefox's ephemeral
context runs on OPFS. Measured with Playwright: on the fallback, conformance matches the browser's
own IndexedDB (87 of 87 in Chromium and WebKit, 84 of 87 in Firefox) with OPFS, `Worker` or
WebAssembly removed, the WASM failing to compile, the worker failing to load, and in a WebKit
ephemeral context. Private browsing modes are not measured.

Firefox's own IndexedDB differs in two places that the fallback, being Firefox's IndexedDB, keeps:

- a key stored as `-0` comes back as `0` (the three `-0` conformance tests);
- an open or `deleteDatabase` that another tab's connection holds up sometimes gets no `blocked`
  event, though it still waits and goes on once that tab closes (natively in 2 of 12 runs of one
  multi-tab test).

On OPFS, plateau keeps `-0` and fires `blocked` in Firefox too.

## Known limits

- **Conformance:** 87 of 87 WPT-style IndexedDB tests pass on OPFS in Chromium, WebKit and
  Firefox, as they do on native IndexedDB in Chromium and WebKit (Firefox's own passes 84, see
  [Browser support](#browser-support)). Since 0.3.0 a key stored as `-0` comes back as `-0`; keys
  written by 0.2.0 or earlier stored `-0` as `0` and still read as `0`.
- **No downgrade:** once 0.3.0 stores a `-0` key in a store, 0.2.0 fails to read that store
  (`UnknownError`).
- **The fallback's data is separate** from OPFS data, and its `store.query` scans the store (see
  [the fallback](#where-plateau-cannot-run-the-indexeddb-fallback)).
- **First open:** the page's first call waits for the worker to check that it can open an OPFS
  file before the database opens: about 1 ms more to the first open on a fresh page (medians of
  10 page loads: Chromium 10.2 ms against 9.6 ms without the check, WebKit 15.0 ms against 14.0 ms).
- **Values:** `Blob`, `File`, `ImageData` and `Error` values throw `DataCloneError`.
- `plateau.databases()` returns an empty list on OPFS.
- **Start-up:** the first query on a fresh page load costs more than native IndexedDB, because the
  worker starts and the WASM compiles (measured through the API at 1M rows in Chromium: 8-13 ms
  against native 4-5 ms). Reopening and warm queries are faster than native.
- **No RxDB adapter yet.**
- **Pre-1.0:** the API, the `columns` declaration and plateau's own calls may change between
  minor versions. The file format may change too; plan to be able to rebuild local data from
  your server.

## Licence

MIT. Source: https://github.com/jagadhis/plateaudb
