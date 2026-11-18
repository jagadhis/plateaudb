# plateau

A Rust/WASM browser database on OPFS with an IndexedDB-compatible API and bitmap indexes so
multi-key query time stays near-flat as rows grow. Status: M4, multi-tab (one leader tab runs the
worker, the others forward to it) with a live-sync example (`examples/live-sync`), on top of M1f, a memory budget and file space reuse, and M2a,
the IndexedDB-compatible API with hybrid values.

## Layout

| Path | What |
|---|---|
| `crates/engine` | Rust crate `plateau-engine`. `Db` (`db.rs`): saved segments read lazily from a `Storage` (`storage.rs`) plus an in-memory delta (`table.rs`); queries run per part and merge, leaving out rows marked deleted (`dead.rs`: `put` of an existing key and `delete` mark the old row; `compact` rewrites live rows as one segment). File format v6 in `format.rs` (two header slots, segments listed by their extents, per-segment delete bitmaps, a small manifest; per-column and per-index directories, checksummed blocks and row records loaded on first touch). Saves and compactions stream live rows in primary key order a bounded run at a time (`merge.rs`) into the space the committed state leaves free, gaps first, then the end (`write.rs`). New segments are lean (each value stored once: no `str` column chunks, keys-indexed columns only in their prefix-coded keys index) and use logical offsets mapped through their extents, so after a commit that leaves the file over a tenth larger than what it uses, `Db::tidy` copies the bytes past the lowest workable cut into the free space before it, commits and cuts the file. Lazy segments in `segment.rs` count what they load against a per-thread memory budget and drop least recently used pieces between operations, never during one (`cache.rs`); the planner (`query.rs`) is generic over `Part` (`part.rs`). `wasm-bindgen` bindings in `src/wasm.rs` take the OPFS handle as a JS storage object. |
| `packages/plateau` | `plateaudb` on npm (MIT), the IndexedDB-compatible API. `bun run build` writes the published `dist/` (`build.ts`: wasm-pack, then `index.js`, a self-contained `host.worker.js`, the `.wasm` file and types, the worker and WASM named by `new URL("./…", import.meta.url)`); in-repo consumers (bench, live-sync) alias `plateaudb` to `src/`. Main thread (`src/facade.ts`): factory, connections, transactions (lifecycle, auto-commit; scheduling in `src/scheduler.ts`), stores, indexes, cursors, requests and events (`src/events.ts`); keys, key paths and ranges with a sortable string encoding of IndexedDB key order (`src/key.ts`); the value encoding, a tagged JSON form of the structured-clone types it stores (`src/value.ts`). Worker (`src/host.worker.ts`): one engine file per object store plus a catalog file per database, index key paths and a generic store's primary key in persisted keys indexes (sorted blocks with fences, read on first lookup), typed stores (declared `columns`) straight on the engine, `store.query` on the planner; plateau's own `db.compact()`, `plateau.setMemoryBudget()` (default 64 MiB, 24 MiB where `navigator.deviceMemory` is 4 or less) and `plateau.memoryStats()`; a group commit keeps each file's previous state until the catalog drops its intent. Tabs (`src/runtime.ts`): the tab holding the Web Lock `plateau/leader` runs the worker; the others forward calls and transactions over BroadcastChannel (`plateau/tab/<tab>`, one channel per follower); the leader's scheduler orders every tab's transactions (`RemoteTx`), its open queue every tab's open and deleteDatabase, and it passes versionchange on to every tab with a connection; each tab holds `plateau/alive/<tab>`, so a shared request on it tells when the tab closed. When the leader closes, the next tab queued for the lock starts a worker, the others reopen their connections there, and transactions the old leader was running for them abort with UnknownError. plateau's own `db.observe(stores, callback)` calls back in every tab after a readwrite transaction that wrote those stores commits. `conformance/`: WPT-style tests run against native IndexedDB and plateau; `conformance/multitab.ts` runs several pages of one origin against both. `plateau.whenLeader()` resolves when this tab is the leader. Backend (`src/backend.ts`): chosen once per page at the first call that needs storage, `opfs` or `indexeddb` (`plateau.backend`); the browser's IndexedDB where the main thread lacks OPFS, Worker or WebAssembly, or the worker's `probe` (WASM start, a sync access handle on `plateau/probe`) fails; `startRuntime({ backend })` skips the check. A tab that does not run the engine (`Runtime.stop`) still joins the election and fails the calls of tabs it leads, so they fall back too. On `indexeddb` (`src/fallback.ts`) every call goes to the browser's objects, with plateau's calls (`observe`, `compact`, `store.query` by scan) set as own properties; an open made before the choice is bridged onto the native request. `bun run conformance` also runs the suite on the fallback (forced, and with APIs removed by init scripts, and in a WebKit ephemeral context); `bun run multitab` on all three. |
| `examples/live-sync` | An orders app's list kept live from a server-sent event stream, plateau as the local store. `server.ts` (Bun) stands in for a backend that polls its change table every second, with a fixed wire contract (`GET /live-updates`, `Last-Event-ID`, `change`/`cursor`/`ready`/`resync`); the client (`src/`, Vite) lets only the leader tab hold the stream (`plateau.whenLeader()`), writes changes and the cursor in one transaction, and reads the list only from plateau; `?mode=rest` reads REST for comparison. `measure.ts` measures latency, catch-up, cold load and leader failover in Chromium and WebKit. See its README. |
| `packages/bench` | Vite page plus Playwright runner (bun). Workload generator, baseline engines (IndexedDB, SQLite-WASM on OPFS), the plateau worker, the page-lifetime worker runtime (`src/engines/runtime.ts`), the harness (warm, reopen and fresh-page scenarios) and the chart writer. |
| `results/` | Benchmark output: `<YYYY-MM-DD>-<browser>.json` and `index.html`. Written only by the runner. |

## Commands

Run from the repo root unless noted. Use the rustup toolchain: on this Mac Homebrew's `cargo`
comes first on `PATH` and has no `wasm32-unknown-unknown` target. `wasm-pack` and
`wasm-bindgen` live in `~/.cargo/bin`.

```sh
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$HOME/.cargo/bin:$PATH"
cargo fmt --all
cargo clippy --all-targets -- -D warnings
cargo clippy --target wasm32-unknown-unknown -- -D warnings
cargo test
cargo run --release --example queries -- 1000000   # native engine-only timings: delta, cold open, segment

cd packages/plateau
bun run test         # key encoding order and value round-trips (bun test)
bun run typecheck
bun run conformance  # Chromium and WebKit, native IndexedDB and plateau; needs crates/engine/pkg (bun run wasm in packages/bench)
bun run conformance -- --browsers chromium --filter cursor   # a subset
bun run multitab     # several pages of one origin, Chromium and WebKit, native IndexedDB and plateau; leader failover
bun run build        # the npm package in dist/ (runs wasm-pack; --skip-wasm via `bun build.ts --skip-wasm`)
PLATEAU_DIST=1 bun run conformance   # the same suites against dist/, what npm consumers get (also multitab)
npm pack --dry-run   # the files the package would publish (prepack builds first)

cd examples/live-sync
bun run typecheck
bun measure.ts       # builds the client, starts its own server, writes results/live-sync-<browser>.json

cd packages/bench
bun install
bun run wasm        # wasm-pack build of crates/engine into crates/engine/pkg (SIMD on, see .cargo/config.toml)
bun run build       # vite build (needs crates/engine/pkg)
bun run typecheck
bun run bench       # Chromium, WebKit, Firefox; 10k, 100k, 1M rows; idb, sqlite, plateau, plateau-idb; writes results/<date>-<browser>.json
bun run bench -- --browsers chromium-idb-sqlite --engines idb   # IndexedDB on Chromium's SQLite backend
bun run bench -- --browsers chromium --sizes 10000 --runs 5 --cold-runs 2 --out /tmp/x   # a quick pass
bun run bench -- --engines plateau,plateau-idb --budgets default,24mb,unbounded   # memory budget variants (plateau@24mb, ...)
bun run chart       # rewrite results/index.html from the newest results/*.json per browser
```

Benchmark facts worth knowing before changing the harness:

- Each engine and size runs in a fresh persistent Playwright profile on disk. Default (incognito)
  contexts keep storage in memory.
- WebKit under Playwright on macOS keeps OPFS in `~/Library/WebKit/org.webkit.Playwright`,
  outside the profile, so engines clear their OPFS files on `create`.
- Playwright's Chromium stores IndexedDB in LevelDB; Chrome 156+ moves new origins to SQLite by a
  field-trial rollout that test builds do not get. `chromium-idb-sqlite` forces it on.
- Timing runs on the main thread around each call. The untimed warm-up (100 calls per query
  shape) gets each engine's code past the browser's baseline compilers.
- plateau and plateau-idb load by committing every 50,000 rows and then compacting (unsaved rows
  stay bounded, the measured runs start from one segment); plateau-idb-generic keeps the
  IndexedDB code's commit per 10,000-row chunk. `details*` in a result record the worker's WASM
  memory (its peak so far: WASM memory never shrinks) and file size after the load, the updates
  and compaction.
- Two cold scenarios per engine: reopen (close, open, first Q1 in the same page; a worker engine
  keeps its worker) and fresh page (a new page load in the same context, from navigation start to
  the first Q1 result). The runner does not touch a fresh page until it logs `fresh done`:
  Playwright's polling would run on the page's main thread while it is timed.

## Rules

- Before every commit: `cargo fmt --all`, `cargo clippy --all-targets -- -D warnings`,
  `cargo clippy --target wasm32-unknown-unknown -- -D warnings` and `cargo test` pass. A change to
  `packages/bench` also builds (`bun run build`) and typechecks (`bun run typecheck`). A change to
  `packages/plateau` also passes `bun run test`, `bun run typecheck`, `bun run conformance` (it
  exits non-zero on a plateau failure or a difference from native IndexedDB not in its listed
  known differences) and `bun run multitab` (non-zero on a plateau failure or a shared test whose
  outcome differs from native IndexedDB).
- Benchmarks are deterministic: every workload and query parameter comes from a fixed seed. Change
  a seed only on purpose, and say so in the commit.
- Every engine must return the same row ids for every query at a given seed. The harness asserts
  this; a mismatch is a bug to fix before any numbers are reported.
- Never hand-edit anything in `results/`. Rerun the runner instead. Time-outs and failures are
  results: record them, do not drop them.
- Report the browser version and the IndexedDB backend with every result (Chrome 156+ stores
  new-origin IndexedDB data in SQLite, not LevelDB).
- No `npm publish`, no `cargo publish`, and no change to the GitHub repo's visibility, unless Jags says so.
- No AI attribution anywhere: no co-author trailers, no "generated with" lines, in commits, PRs
  or comments.
- Commit messages: `feat: <sentence>` or `chore: <sentence>` (also `fix:`, `docs:`, `test:`).
