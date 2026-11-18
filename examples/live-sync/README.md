# live-sync

An orders app's list kept live from a server-sent event stream, with plateau as the local store.
It answers one question: can plateau carry real-time sync for an app whose backend tells the
browser which orders changed while the browser keeps a local copy?

`server.ts` is a stand-in for such a backend: it speaks a fixed wire contract (below) over
in-memory orders.

## Run it

```sh
bun install                      # at the repo root, once
cd examples/live-sync
bun run build                    # vite build of the client into dist/
bun server.ts --orders 1000 --poll-ms 1000
```

The project site is served at <http://localhost:5190/site/#try>: its "Try live sync" section shows two
tabs side by side with buttons to edit orders, cut the stream, close the leader tab and reset. Or open
<http://localhost:5190/> in two tabs (Chromium, WebKit or Firefox with OPFS and Web Locks).
`?mode=rest` is the same list reading straight from REST. `?db=<name>` picks the database.

Edit an order from a shell and watch both tabs:

```sh
curl -X PATCH localhost:5190/orders/7 -d '{"title":"edited"}'
```

Measure (starts its own server on port 5193, builds the client first):

```sh
bun measure.ts                                  # everything, both browsers, writes results/
bun measure.ts --browsers chromium --only latency --edits 100
```

`--only` takes `latency,catchup,cold,failover`. Results land in `results/live-sync-<browser>.json`.

## The wire contract

`GET /live-updates`, optional header `Last-Event-ID: <opaque cursor>`.

- First bytes: `retry: 3000` and a comment.
- Without a cursor: `event: ready`, data `{"fresh":true}`, `id` set to the current watermark.
- With a cursor: `change` events for what happened since, then `cursor` (its `id` is the new
  watermark), then `ready` with `{"fresh":false}`.
- A cursor older than the retention horizon, from the future, or from another run of the server (the cursor carries a run id): `resync`, then `cursor`, then `ready`.
- An unparsable cursor: 400.
- `change` data is `{"kind":"order","id":n}` and carries no `id`; a `cursor` follows every batch, so a
  stream cut in the middle of a batch resumes from the batch's start and repeats rather than skips.
- Heartbeat comment every 20 s; the server closes the stream at 540 s.
- `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`.

`POLL_MS` (`--poll-ms`, or `GET /admin/poll?ms=`) is the delay between a PATCH and the server writing
it to the open streams. 1000 mimics a backend that polls its change table every second; 0
writes at once. Within a poll the server sends one `change` per distinct order.

REST: `GET /orders` (all), `GET /orders?top=50` (`{count, rows}`), `GET /orders/:id`,
`PATCH /orders/:id` (`title`, `status`, `total`, `editedAt`; bumps `version` and `updatedAt`).
Admin, for the measurements: `/admin/state`, `/admin/drop?refuse=ms`, `/admin/reseed?n=`,
`/admin/purge`, `/admin/poll?ms=`, `/admin/versions`.

## How the client works

- Only the plateau leader tab holds the stream (`await plateau.whenLeader()`), so any number of tabs
  cost one connection. It reads with `fetch`, not `EventSource`, because the stored cursor has to go
  out as `Last-Event-ID` on the first connect.
- Events are applied in order. `change` ids collect; at `cursor` the app fetches those orders
  (16 at a time) and writes them and the cursor in one plateau transaction, so the saved cursor never
  runs ahead of what is applied. A crash or a closed leader repeats a batch; it never skips one.
- `ready` with `fresh` (no stored cursor) and `resync` load the whole list (`GET /orders`, newest
  first, 10,000 rows per transaction) and save the cursor with the last chunk.
- The UI reads only from plateau: the 50 most recently updated orders (`orderBy updatedAt desc`) and
  `count()`. `db.observe("orders", ...)` fires in every tab after any tab's commit; reads coalesce to
  one per animation frame.
- When the leader closes, the next tab takes the lock, `whenLeader()` resolves there, and it
  reconnects with the cursor plateau holds.

What the demo leaves out: deletes, auth, several operators, pagination beyond the first 50, and
anything a real backend does to bound its work (such as deduping per user and paging its
reads).

## Results

`results/` holds the JSON of the run quoted in the PR for this example. Numbers there are from one
Apple-silicon Mac, headless, with the server on the same machine, so network time is near zero; they
show what the browser side costs, not what a WAN adds.
