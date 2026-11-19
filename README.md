# plateau

A browser database whose query time plateaus as data grows.

plateau is a database engine written in Rust, compiled to WebAssembly, that stores its data in the
Origin Private File System (OPFS) and exposes an IndexedDB-compatible API. It indexes every
queryable field with compressed bitmaps over internal row ids, so a multi-key query
(`team = X AND state IN (a, b) ORDER BY updatedAt DESC LIMIT 50`) costs roughly the size of its
result rather than the size of the table.

## Package

The library is on npm as [`plateaudb`](packages/plateau) (`npm install plateaudb`); its README
covers usage, browser support and known limits. Where OPFS, module workers or WebAssembly are
missing (or in a WebKit ephemeral session), it runs on the browser's own IndexedDB instead, and
`plateau.backend` says which one runs. The source is `packages/plateau`, built with
`bun run build` there.

## Website

`site/index.html` is the project's page: current status, how to use the API, how it compares with
other browser databases, and every benchmark number with charts. Open it straight from disk, no
server needed. After a new benchmark run, `bun site/extract.ts` rewrites `site/data.js` from the
newest `results/*.json`.

The status below is M0's, kept for the record; the site and `AGENTS.md` carry the current one.

## Status: M0 (spike and benchmark)

M0 answers one question before the engine gets serious: is the bet worth building?

The spike engine keeps rows in memory with a primary B-tree, per-field roaring bitmaps and an
ordered index, runs in a dedicated Web Worker, and persists a snapshot file to OPFS through
`FileSystemSyncAccessHandle`. A benchmark harness runs a Linear-like issue workload at 10k, 100k
and 1M rows in Chromium, WebKit and Firefox against two baselines:

- native IndexedDB with the best indexes a careful developer would declare;
- SQLite-WASM (`@sqlite.org/sqlite-wasm`) on OPFS with the `opfs-sahpool` VFS and matching indexes.

Results land in [`results/`](results/) as one JSON file per browser per day, plus a chart at
`results/index.html`.

**M0 verdict (2026-11-17): kill, by the rule as written.** At 100k rows plateau is 4.6x to 58x faster
than IndexedDB on multi-key queries except one (WebKit Q3, 2.5x), short of the 10x bar in both
Chromium and WebKit. SQLite-WASM with matching indexes lands within 2x of plateau on the ordered
and count queries (Q1, Q3) in both browsers. plateau's clear wins are 1,000 point gets (4-5x over
SQLite), the multi-filter query (2-4x over SQLite) and bulk load. Firefox did not start under
Playwright on macOS 27.2 and is not measured (from plateaudb 0.3.0 it starts and is tested, see
`packages/plateau/README.md`). Numbers and caveats: `results/index.html`.

Not yet at M0: durability (M1), the IndexedDB facade (M2), the planner with statistics (M3),
multi-tab (M4).

## Layout and commands

See [`AGENTS.md`](AGENTS.md).

## License

MIT. See [`LICENSE`](LICENSE).
