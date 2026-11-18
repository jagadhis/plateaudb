// Deterministic Linear-like workload. Every row and every query parameter is a pure function of
// (seed, index), so each engine can generate the same data in its own thread, in any chunking.

export interface Issue {
  id: number;
  teamId: number;
  stateId: number;
  assigneeId: number;
  labelIds: number[];
  priority: number;
  createdAt: number;
  updatedAt: number;
  title: string;
}

export const SEED = 20261117;
export const TEAMS = 20;
export const STATES_PER_TEAM = 6;
export const ASSIGNEES = 200;
export const LABELS = 50;
export const PRIORITIES = 5;
/** Fixed "now", so timestamps do not depend on when the benchmark runs. */
export const T0 = Date.UTC(2026, 0, 1);
const DAY = 86_400_000;
const SPAN = 730 * DAY;

const WORDS = [
  "sync", "crash", "login", "export", "billing", "search", "editor", "upload", "invite", "theme",
  "cursor", "filter", "webhook", "cache", "label", "cycle", "roadmap", "inbox", "draft", "triage",
  "mobile", "desktop", "api", "import", "slack", "github", "sso", "audit", "latency", "offline",
];

function mix32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

/** mulberry32 seeded from (seed, stream, index). Returns floats in [0, 1). */
export function rng(seed: number, stream: number, index: number): () => number {
  let a = mix32(seed ^ mix32(stream * 0x9e3779b9 + mix32(index)));
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (r: () => number, n: number) => Math.floor(r() * n);

/** The issue at 0-based position `i`; its id is `i + 1`. */
export function issueAt(seed: number, i: number): Issue {
  const r = rng(seed, 1, i);
  const teamId = int(r, TEAMS);
  const stateId = teamId * STATES_PER_TEAM + int(r, STATES_PER_TEAM);
  const assigneeId = int(r, ASSIGNEES);
  const nLabels = int(r, 4);
  const labelIds: number[] = [];
  while (labelIds.length < nLabels) {
    const l = int(r, LABELS);
    if (!labelIds.includes(l)) labelIds.push(l);
  }
  labelIds.sort((a, b) => a - b);
  const priority = int(r, PRIORITIES);
  const createdAt = T0 - int(r, SPAN);
  const updatedAt = createdAt + int(r, T0 - createdAt);
  const id = i + 1;
  const title = `Issue ${id}: ${WORDS[int(r, WORDS.length)]} ${WORDS[int(r, WORDS.length)]} ${WORDS[int(r, WORDS.length)]}`;
  return { id, teamId, stateId, assigneeId, labelIds, priority, createdAt, updatedAt, title };
}

export function issues(seed: number, start: number, count: number): Issue[] {
  const out = new Array<Issue>(count);
  for (let k = 0; k < count; k++) out[k] = issueAt(seed, start + k);
  return out;
}

export interface Q1 { teamId: number; stateIds: [number, number]; limit: number }
export interface Q2 { assigneeId: number; labelId: number; maxPriority: number }
export interface Q3 { teamId: number; updatedAfter: number }
/** Q1's shape plus a priority bound; about 60% of rows pass it, so the 50 rows wanted are found
 * at every table size and the result size stays fixed. */
export interface Q4 { teamId: number; stateIds: [number, number]; maxPriority: number; limit: number }

/** The query object both query engines take (plateau natively, SQLite through its layer). */
export interface Query {
  where: Filter[];
  orderBy?: { field: string; desc?: boolean };
  limit?: number;
  count?: boolean;
}
export type Filter =
  | { field: string; op: "eq"; value: number }
  | { field: string; op: "in"; values: number[] }
  | { field: string; op: "range"; gt?: number; gte?: number; lt?: number; lte?: number };

export const q1Query = (p: Q1): Query => ({
  where: [
    { field: "teamId", op: "eq", value: p.teamId },
    { field: "stateId", op: "in", values: p.stateIds },
  ],
  orderBy: { field: "updatedAt", desc: true },
  limit: p.limit,
});

export const q2Query = (p: Q2): Query => ({
  where: [
    { field: "assigneeId", op: "eq", value: p.assigneeId },
    { field: "labelIds", op: "eq", value: p.labelId },
    { field: "priority", op: "range", lte: p.maxPriority },
  ],
});

export const q3Query = (p: Q3): Query => ({
  where: [
    { field: "teamId", op: "eq", value: p.teamId },
    { field: "updatedAt", op: "range", gt: p.updatedAfter },
  ],
  count: true,
});

export const q4Query = (p: Q4): Query => ({
  where: [
    { field: "teamId", op: "eq", value: p.teamId },
    { field: "stateId", op: "in", values: p.stateIds },
    { field: "priority", op: "range", lte: p.maxPriority },
  ],
  orderBy: { field: "updatedAt", desc: true },
  limit: p.limit,
});

export interface Params {
  gets: number[][];
  q1: Q1[];
  q2: Q2[];
  q3: Q3[];
  q4: Q4[];
}

/** Query parameters for runs `from..to` (inclusive), the same for every engine. Run 0 and runs
 * past the measured ones are warm-up parameters. */
export function params(seed: number, size: number, to: number, from = 0): Params {
  const p: Params = { gets: [], q1: [], q2: [], q3: [], q4: [] };
  for (let k = from; k <= to; k++) {
    const r = rng(seed, 2, size * 1000 + k);
    const ids: number[] = [];
    for (let j = 0; j < 1000; j++) ids.push(1 + int(r, size));
    p.gets.push(ids);

    const team = int(r, TEAMS);
    const a = int(r, STATES_PER_TEAM);
    const b = (a + 1 + int(r, STATES_PER_TEAM - 1)) % STATES_PER_TEAM;
    p.q1.push({ teamId: team, stateIds: [team * STATES_PER_TEAM + a, team * STATES_PER_TEAM + b], limit: 50 });

    // Anchor Q2 on an existing row, so the result is rarely empty.
    const row = issueAt(seed, int(r, size));
    const labelId = row.labelIds.length ? row.labelIds[int(r, row.labelIds.length)] : int(r, LABELS);
    p.q2.push({ assigneeId: row.assigneeId, labelId, maxPriority: 2 });

    p.q3.push({ teamId: int(r, TEAMS), updatedAfter: T0 - (1 + int(r, 90)) * DAY });

    // Drawn after Q1..Q3 so their parameters are the same as in the M0 run.
    const t4 = int(r, TEAMS);
    const a4 = int(r, STATES_PER_TEAM);
    const b4 = (a4 + 1 + int(r, STATES_PER_TEAM - 1)) % STATES_PER_TEAM;
    p.q4.push({ teamId: t4, stateIds: [t4 * STATES_PER_TEAM + a4, t4 * STATES_PER_TEAM + b4], maxPriority: 2, limit: 50 });
  }
  return p;
}

/** Rows per batch of the update workload: the first commit replaces and deletes this many rows
 * each, the second commit the rest. */
export const UPDATE_BATCH = 1000;

/** One commit of the update workload: rows to replace (put over an existing id) and ids to delete. */
export interface UpdateBatch {
  replace: number[];
  remove: number[];
}

/** The update workload: 1% of rows replaced and another 1% deleted. In each block of 100 ids one
 * id is replaced and a different one deleted, at positions drawn from the seed. Split into a first
 * commit of `UPDATE_BATCH` of each and a second commit of the rest. */
/** Rows per commit when a plateau engine loads the table: plateau, plateau-idb and
 * plateau-idb-generic (whose IndexedDB code commits a 10,000-row chunk at a time) all commit in
 * batches, so the unsaved rows a commit holds stay bounded. plateau and plateau-idb then compact,
 * so the measured runs start from one segment as before. */
export const PLATEAU_COMMIT_ROWS = 50_000;

/** A memory budget variant of a plateau engine: `plateau@24mb`, `plateau-idb@unbounded`. `null`
 * is no limit, `undefined` the runtime's default. */
export function budgetOf(spec: string): number | null | undefined {
  const b = spec.split("@")[1];
  if (b === undefined || b === "default") return undefined;
  if (b === "unbounded") return null;
  const m = /^(\d+)mb$/.exec(b);
  if (!m) throw new Error(`unknown memory budget ${b} in ${spec}`);
  return Number(m[1]) << 20;
}

export function updateBatches(seed: number, size: number): UpdateBatch[] {
  const replace: number[] = [];
  const remove: number[] = [];
  for (let k = 0; k * 100 < size; k++) {
    const r = rng(seed, 3, k);
    const a = int(r, 100);
    const b = (a + 1 + int(r, 99)) % 100;
    if (k * 100 + a < size) replace.push(k * 100 + a + 1);
    if (k * 100 + b < size) remove.push(k * 100 + b + 1);
  }
  const first = { replace: replace.slice(0, UPDATE_BATCH), remove: remove.slice(0, UPDATE_BATCH) };
  const rest = { replace: replace.slice(UPDATE_BATCH), remove: remove.slice(UPDATE_BATCH) };
  return rest.replace.length || rest.remove.length ? [first, rest] : [first];
}

/** The row that replaces issue `id`: an edit, as an app makes one. It keeps the id, createdAt and
 * (nine times in ten) the team; it gets a new state, assignee, labels and priority, an updatedAt in
 * the last 30 days, and an edited title. */
export function replacementFor(seed: number, id: number): Issue {
  const old = issueAt(seed, id - 1);
  const r = rng(seed, 4, id);
  const teamId = int(r, 10) === 0 ? int(r, TEAMS) : old.teamId;
  const stateId = teamId * STATES_PER_TEAM + int(r, STATES_PER_TEAM);
  const assigneeId = int(r, ASSIGNEES);
  const nLabels = int(r, 4);
  const labelIds: number[] = [];
  while (labelIds.length < nLabels) {
    const l = int(r, LABELS);
    if (!labelIds.includes(l)) labelIds.push(l);
  }
  labelIds.sort((a, b) => a - b);
  const priority = int(r, PRIORITIES);
  const recent = T0 - int(r, 30 * DAY);
  const updatedAt = Math.max(recent, old.createdAt);
  return { ...old, teamId, stateId, assigneeId, labelIds, priority, updatedAt, title: `${old.title} (edited)` };
}
