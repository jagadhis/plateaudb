// SQLite-WASM (official build) on OPFS through the opfs-sahpool VFS, in a dedicated worker,
// which sahpool requires. Indexes match the IndexedDB baseline; labels get a join table so Q2
// can use an index for the label as well.
//
// Queries go through a thin IndexedDB-style layer, as an app would use it: the caller passes the
// same query object plateau takes (where, orderBy, limit, count), the layer compiles it to SQL,
// keeps prepared statements by SQL text and returns row objects. M0 ran raw per-query SQL
// instead, which left out the cost of such a layer.

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { issues, q1Query, q2Query, q3Query, q4Query, replacementFor, updateBatches, type Filter, type Issue, type Q1, type Q2, type Q3, type Q4, type Query } from "../workload";
import { serve } from "./rpc";

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
type Db = InstanceType<Sqlite3["oo1"]["DB"]>;
type Stmt = ReturnType<Db["prepare"]>;

const FILE = "/plateau-bench.sqlite3";
const PRAGMAS = ["PRAGMA cache_size = -65536", "PRAGMA temp_store = MEMORY"];

let sqlite3: Sqlite3 | null = null;
let pool: Awaited<ReturnType<Sqlite3["installOpfsSAHPoolVfs"]>> | null = null;
let db: Db | null = null;
const stmts = new Map<string, Stmt>();

/** `clear` wipes the pool first: WebKit under Playwright keeps OPFS outside the per-run profile. */
/** SQLite's WASM starts loading as soon as the worker runs, before the first request. */
const loading = sqlite3InitModule();

async function init(clear: boolean): Promise<Record<string, number>> {
  const t0 = performance.now();
  sqlite3 = await loading;
  const t1 = performance.now();
  pool = await sqlite3.installOpfsSAHPoolVfs({ name: "plateau-bench", clearOnInit: clear });
  const t2 = performance.now();
  db = new pool.OpfsSAHPoolDb(FILE);
  for (const p of PRAGMAS) db.exec(p);
  const t3 = performance.now();
  return { wasmInit: t1 - t0, installSahpool: t2 - t1, openDb: t3 - t2 };
}

function info(): Record<string, unknown> {
  return {
    sqliteVersion: sqlite3?.version.libVersion,
    vfs: "opfs-sahpool",
    pragmas: PRAGMAS,
    journalMode: db?.selectValue("PRAGMA journal_mode"),
    indexes: [
      "issues(teamId, stateId, updatedAt)",
      "issues(assigneeId, priority)",
      "issues(teamId, updatedAt)",
      "issue_labels(labelId, issueId) WITHOUT ROWID primary key",
    ],
    loadPath: "prepared INSERT per row, one transaction per chunk, ANALYZE at the end",
    updatePath:
      "one transaction per batch: per replaced row, SELECT its old labelIds by primary key, DELETE those (labelId, issueId) pairs, UPDATE the row, INSERT its new labels; per deleted id the same label cleanup, then DELETE the row; all prepared statements",
  };
}

function stmt(sql: string): Stmt {
  let s = stmts.get(sql);
  if (!s) {
    s = db!.prepare(sql);
    stmts.set(sql, s);
  }
  return s;
}

const COLS = "id, teamId, stateId, assigneeId, labelIds, priority, createdAt, updatedAt, title";

function rowOf(s: Stmt): Issue {
  return {
    id: s.getInt(0) as number,
    teamId: s.getInt(1) as number,
    stateId: s.getInt(2) as number,
    assigneeId: s.getInt(3) as number,
    labelIds: JSON.parse(s.getString(4) as string),
    priority: s.getInt(5) as number,
    createdAt: Number(s.get(6)),
    updatedAt: Number(s.get(7)),
    title: s.getString(8) as string,
  };
}

function all(s: Stmt, bind: unknown[]): Issue[] {
  s.reset(true);
  s.bind(bind as never);
  const out: Issue[] = [];
  while (s.step()) out.push(rowOf(s));
  s.reset(true);
  return out;
}

const COLUMN_NAMES = new Set(["id", "teamId", "stateId", "assigneeId", "priority", "createdAt", "updatedAt"]);

function compile(query: Query): { sql: string; bind: number[] } {
  const joinBind: number[] = [];
  const bind: number[] = [];
  const joins: string[] = [];
  const where: string[] = [];
  for (const f of query.where) {
    if (f.field === "labelIds") {
      // A multi-value field lives in the join table: `eq` joins it, `in` is a subquery.
      if (f.op === "eq") {
        joins.push("JOIN issue_labels l ON l.issueId = i.id AND l.labelId = ?");
        joinBind.push(f.value);
      } else if (f.op === "in") {
        where.push(`i.id IN (SELECT issueId FROM issue_labels WHERE labelId IN (${f.values.map(() => "?").join(", ")}))`);
        bind.push(...f.values);
      } else throw new Error("labelIds supports eq and in");
      continue;
    }
    if (!COLUMN_NAMES.has(f.field)) throw new Error(`no field ${f.field}`);
    where.push(condition(f, bind));
  }
  const select = query.count ? "count(*)" : COLS.split(", ").map((c) => `i.${c}`).join(", ");
  let sql = `SELECT ${select} FROM issues i ${joins.join(" ")}`;
  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  if (!query.count) {
    const o = query.orderBy;
    if (o && !COLUMN_NAMES.has(o.field)) throw new Error(`no field ${o.field}`);
    const dir = o?.desc ? "DESC" : "ASC";
    sql += o && o.field !== "id" ? ` ORDER BY i.${o.field} ${dir}, i.id ${dir}` : ` ORDER BY i.id ${dir}`;
    if (query.limit !== undefined) {
      sql += " LIMIT ?";
      bind.push(query.limit);
    }
  }
  return { sql, bind: [...joinBind, ...bind] };
}

function condition(f: Filter, bind: number[]): string {
  const col = `i.${f.field}`;
  if (f.op === "eq") {
    bind.push(f.value);
    return `${col} = ?`;
  }
  if (f.op === "in") {
    bind.push(...f.values);
    return `${col} IN (${f.values.map(() => "?").join(", ")})`;
  }
  const parts: string[] = [];
  for (const [key, sym] of [["gt", ">"], ["gte", ">="], ["lt", "<"], ["lte", "<="]] as const) {
    const v = f[key];
    if (v !== undefined) {
      parts.push(`${col} ${sym} ?`);
      bind.push(v);
    }
  }
  return parts.length ? parts.join(" AND ") : "1";
}

function run(query: Query): Issue[] | number {
  const { sql, bind } = compile(query);
  const s = stmt(sql);
  if (query.count) {
    s.reset(true);
    s.bind(bind as never);
    s.step();
    const n = s.getInt(0) as number;
    s.reset(true);
    return n;
  }
  return all(s, bind);
}

let pending: { rows: Issue[]; remove: number[] } | null = null;

/** Removes an issue's label pairs: reads its old labelIds by primary key, then deletes each
 * (labelId, issueId) by the join table's primary key. */
function dropLabels(id: number): boolean {
  const sel = stmt("SELECT labelIds FROM issues WHERE id = ?");
  sel.bind([id]);
  const old = sel.step() ? (JSON.parse(sel.getString(0) as string) as number[]) : null;
  sel.reset(true);
  if (!old) return false;
  const del = stmt("DELETE FROM issue_labels WHERE labelId = ? AND issueId = ?");
  for (const l of old) del.bind([l, id]).stepReset();
  return true;
}

serve({
  async create() {
    const t = performance.now();
    const parts = await init(true);
    db!.exec(`
      CREATE TABLE issues (
        id INTEGER PRIMARY KEY, teamId INTEGER NOT NULL, stateId INTEGER NOT NULL,
        assigneeId INTEGER NOT NULL, labelIds TEXT NOT NULL, priority INTEGER NOT NULL,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, title TEXT NOT NULL);
      CREATE TABLE issue_labels (labelId INTEGER NOT NULL, issueId INTEGER NOT NULL,
        PRIMARY KEY (labelId, issueId)) WITHOUT ROWID;
      CREATE INDEX issues_team_state_updated ON issues (teamId, stateId, updatedAt);
      CREATE INDEX issues_assignee_priority ON issues (assigneeId, priority);
      CREATE INDEX issues_team_updated ON issues (teamId, updatedAt);
    `);
    return { totalMs: performance.now() - t, parts, info: info() };
  },

  async open() {
    const t = performance.now();
    if (!sqlite3 || !pool) {
      const parts = await init(false);
      return { totalMs: performance.now() - t, parts, info: info() };
    }
    // The runtime is up: take the pool's file handles back and open the database.
    await pool.unpauseVfs();
    const t1 = performance.now();
    db = new pool.OpfsSAHPoolDb(FILE);
    for (const p of PRAGMAS) db.exec(p);
    const parts = { unpauseVfs: t1 - t, openDb: performance.now() - t1 };
    return { totalMs: performance.now() - t, parts, info: info() };
  },

  close() {
    for (const s of stmts.values()) s.finalize();
    stmts.clear();
    db?.close();
    db = null;
    pool?.pauseVfs();
    return null;
  },

  load(seed: number, size: number, chunk: number) {
    let insert = 0;
    const insIssue = stmt(`INSERT INTO issues (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insLabel = stmt("INSERT INTO issue_labels (labelId, issueId) VALUES (?, ?)");
    for (let start = 0; start < size; start += chunk) {
      const rows = issues(seed, start, Math.min(chunk, size - start));
      const t = performance.now();
      db!.exec("BEGIN");
      for (const r of rows) {
        insIssue
          .bind([r.id, r.teamId, r.stateId, r.assigneeId, JSON.stringify(r.labelIds), r.priority, r.createdAt, r.updatedAt, r.title])
          .stepReset();
        for (const l of r.labelIds) insLabel.bind([l, r.id]).stepReset();
      }
      db!.exec("COMMIT");
      insert += performance.now() - t;
    }
    const t = performance.now();
    db!.exec("ANALYZE");
    const analyze = performance.now() - t;
    return { totalMs: insert + analyze, parts: { insertAndCommit: insert, analyze } };
  },

  prepareUpdate(seed: number, size: number, batch: number) {
    const b = updateBatches(seed, size)[batch];
    pending = { rows: b.replace.map((id) => replacementFor(seed, id)), remove: b.remove };
    return null;
  },

  applyUpdate() {
    const b = pending;
    if (!b) throw new Error("sqlite: no update prepared");
    pending = null;
    const t = performance.now();
    const upd = stmt(
      "UPDATE issues SET teamId = ?, stateId = ?, assigneeId = ?, labelIds = ?, priority = ?, createdAt = ?, updatedAt = ?, title = ? WHERE id = ?",
    );
    const insLabel = stmt("INSERT INTO issue_labels (labelId, issueId) VALUES (?, ?)");
    const delIssue = stmt("DELETE FROM issues WHERE id = ?");
    db!.exec("BEGIN");
    for (const r of b.rows) {
      dropLabels(r.id);
      upd.bind([r.teamId, r.stateId, r.assigneeId, JSON.stringify(r.labelIds), r.priority, r.createdAt, r.updatedAt, r.title, r.id]).stepReset();
      for (const l of r.labelIds) insLabel.bind([l, r.id]).stepReset();
    }
    for (const id of b.remove) {
      if (dropLabels(id)) delIssue.bind([id]).stepReset();
    }
    db!.exec("COMMIT");
    const ms = performance.now() - t;
    return { totalMs: ms, parts: { updateDeleteAndCommit: ms } };
  },

  getMany(ids: number[]) {
    const s = stmt(`SELECT ${COLS} FROM issues WHERE id = ?`);
    return ids.map((id) => {
      s.bind([id]);
      const row = s.step() ? rowOf(s) : null;
      s.reset(true);
      return row;
    });
  },

  q1(p: Q1) {
    return run(q1Query(p)) as Issue[];
  },

  q2(p: Q2) {
    return run(q2Query(p)) as Issue[];
  },

  q3(p: Q3) {
    return run(q3Query(p)) as number;
  },

  q4(p: Q4) {
    return run(q4Query(p)) as Issue[];
  },

  /** EXPLAIN QUERY PLAN for each query shape, after ANALYZE. */
  details() {
    const eqp = (sql: string) =>
      (db!.exec({ sql: `EXPLAIN QUERY PLAN ${sql}`, rowMode: "object", returnValue: "resultRows" }) as { detail: string }[])
        .map((r) => r.detail)
        .join("; ");
    return {
      q1: eqp("SELECT * FROM issues WHERE teamId = 1 AND stateId IN (6, 7) ORDER BY updatedAt DESC, id DESC LIMIT 50"),
      q2: eqp("SELECT i.* FROM issue_labels l JOIN issues i ON i.id = l.issueId WHERE l.labelId = 1 AND i.assigneeId = 1 AND i.priority <= 2 ORDER BY i.id"),
      q3: eqp("SELECT count(*) FROM issues WHERE teamId = 1 AND updatedAt > 1"),
      q4: eqp("SELECT * FROM issues WHERE teamId = 1 AND stateId IN (6, 7) AND priority <= 2 ORDER BY updatedAt DESC, id DESC LIMIT 50"),
    };
  },
});
