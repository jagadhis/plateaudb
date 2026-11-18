// A small testharness in the style of WPT's testharness.js, run against an IndexedDB factory: the
// browser's `indexedDB` or plateau's. Tests get the factory and key range class from `env`, so one
// file runs on both.

export interface Env {
  impl: "native" | "plateau";
  factory: IDBFactory;
  KeyRange: typeof IDBKeyRange;
}

export interface TestContext {
  name: string;
  add_cleanup(fn: () => unknown): void;
  /** A fresh database name for this test. */
  dbName(suffix?: string): string;
}

export interface Result {
  name: string;
  /** `plateau`: a test of plateau's own additions (typed columns, query), run only on plateau. */
  scope: "shared" | "plateau";
  status: "pass" | "fail";
  message?: string;
  ms: number;
}

type Body = (t: TestContext, env: Env) => Promise<unknown>;

const tests: { name: string; body: Body; scope: Result["scope"] }[] = [];

export function promise_test(name: string, body: Body): void {
  tests.push({ name, body, scope: "shared" });
}

/** A test of plateau's additions to the API; native IndexedDB does not have them. */
export function plateau_test(name: string, body: Body): void {
  tests.push({ name, body, scope: "plateau" });
}

export class AssertionError extends Error {}

function fmt(v: unknown): string {
  try {
    if (v instanceof ArrayBuffer) return `ArrayBuffer[${new Uint8Array(v).join(",")}]`;
    if (v instanceof Date) return `Date(${v.getTime()})`;
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number" && Object.is(v, -0)) return "-0";
    if (Array.isArray(v)) return `[${v.map(fmt).join(", ")}]`;
    if (v && typeof v === "object") return JSON.stringify(v);
    return String(v);
  } catch {
    return String(v);
  }
}

export function assert_true(v: unknown, msg = ""): void {
  if (v !== true) throw new AssertionError(`assert_true: ${msg} (got ${fmt(v)})`);
}

export function assert_false(v: unknown, msg = ""): void {
  if (v !== false) throw new AssertionError(`assert_false: ${msg} (got ${fmt(v)})`);
}

export function assert_equals(a: unknown, b: unknown, msg = ""): void {
  if (!Object.is(a, b)) throw new AssertionError(`assert_equals: ${msg} expected ${fmt(b)} but got ${fmt(a)}`);
}

export function assert_not_equals(a: unknown, b: unknown, msg = ""): void {
  if (Object.is(a, b)) throw new AssertionError(`assert_not_equals: ${msg} got disallowed ${fmt(a)}`);
}

/** Structural equality: same types, same own enumerable properties, recursively. */
export function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  const ta = Object.prototype.toString.call(a);
  if (ta !== Object.prototype.toString.call(b)) return false;
  if (a instanceof Date) return Object.is(a.getTime(), (b as Date).getTime());
  if (a instanceof ArrayBuffer) return same([...new Uint8Array(a)], [...new Uint8Array(b as ArrayBuffer)]);
  if (ArrayBuffer.isView(a)) return same([...new Uint8Array(a.buffer, a.byteOffset, a.byteLength)], [...new Uint8Array((b as ArrayBufferView).buffer, (b as ArrayBufferView).byteOffset, (b as ArrayBufferView).byteLength)]);
  if (a instanceof Map) return same([...a], [...(b as Map<unknown, unknown>)]);
  if (a instanceof Set) return same([...a], [...(b as Set<unknown>)]);
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) if (i in a !== i in bb || !same(a[i], bb[i])) return false;
    return true;
  }
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  return same(ka, kb) && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export function assert_same(a: unknown, b: unknown, msg = ""): void {
  if (!same(a, b)) throw new AssertionError(`assert_same: ${msg} expected ${fmt(b)} but got ${fmt(a)}`);
}

export async function assert_rejects_dom(name: string, p: Promise<unknown>, msg = ""): Promise<void> {
  try {
    await p;
  } catch (e) {
    const got = (e as DOMException)?.name;
    if (got !== name) throw new AssertionError(`assert_rejects_dom: ${msg} expected ${name} but got ${got}: ${(e as Error)?.message}`);
    return;
  }
  throw new AssertionError(`assert_rejects_dom: ${msg} expected ${name} but it resolved`);
}

export function assert_throws_dom(name: string, fn: () => unknown, msg = ""): void {
  try {
    fn();
  } catch (e) {
    const got = (e as { name?: string })?.name;
    if (got !== name) throw new AssertionError(`assert_throws_dom: ${msg} expected ${name} but got ${got}: ${(e as Error)?.message}`);
    return;
  }
  throw new AssertionError(`assert_throws_dom: ${msg} expected ${name} but nothing was thrown`);
}

export function assert_throws_js(ctor: ErrorConstructor | TypeErrorConstructor, fn: () => unknown, msg = ""): void {
  try {
    fn();
  } catch (e) {
    if ((e as Error)?.name !== ctor.name) throw new AssertionError(`assert_throws_js: ${msg} expected ${ctor.name} but got ${(e as Error)?.name}`);
    return;
  }
  throw new AssertionError(`assert_throws_js: ${msg} expected ${ctor.name} but nothing was thrown`);
}

export function assert_unreached(msg = ""): never {
  throw new AssertionError(`assert_unreached: ${msg}`);
}

/** A promise for a request's result; rejects with its error. */
export function req<T = any>(r: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    r.addEventListener("success", () => resolve(r.result));
    r.addEventListener("error", () => reject(r.error));
  });
}

/** Resolves when the transaction completes; rejects with its error on abort. */
export function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("abort", () => reject(tx.error ?? new DOMException("aborted", "AbortError")));
  });
}

/** Resolves on the transaction's abort event. */
export function aborted(tx: IDBTransaction): Promise<DOMException | null> {
  return new Promise((resolve, reject) => {
    tx.addEventListener("abort", () => resolve(tx.error));
    tx.addEventListener("complete", () => reject(new AssertionError("transaction completed, expected abort")));
  });
}

export function nextTask(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Deletes then opens `name` at `version`, running `upgrade` in upgradeneeded. Closes and deletes
 * it after the test. */
export async function openDb(t: TestContext, env: Env, upgrade: (db: IDBDatabase, tx: IDBTransaction, e: IDBVersionChangeEvent) => void, version = 1, name = t.dbName()): Promise<IDBDatabase> {
  await req(env.factory.deleteDatabase(name));
  const open = env.factory.open(name, version);
  let db: IDBDatabase | null = null;
  t.add_cleanup(() => {
    db?.close();
    return req(env.factory.deleteDatabase(name)).catch(() => {});
  });
  open.onupgradeneeded = (e) => upgrade(open.result, open.transaction!, e as IDBVersionChangeEvent);
  db = await req<IDBDatabase>(open);
  return db;
}

let counter = 0;

export async function run(env: Env, filter?: string): Promise<Result[]> {
  const out: Result[] = [];
  const stamp = Date.now().toString(36);
  for (const { name, body, scope } of tests) {
    if (filter && !name.includes(filter)) continue;
    if (scope === "plateau" && env.impl !== "plateau") continue;
    const cleanups: (() => unknown)[] = [];
    const t: TestContext = {
      name,
      add_cleanup: (fn) => cleanups.push(fn),
      dbName: (suffix = "") => `conf-${stamp}-${++counter}${suffix}`,
    };
    const start = performance.now();
    let status: Result["status"] = "pass";
    let message: string | undefined;
    try {
      await Promise.race([
        body(t, env),
        new Promise((_, reject) => setTimeout(() => reject(new AssertionError("timed out after 8 s")), 8000)),
      ]);
    } catch (e) {
      status = "fail";
      message = e instanceof Error ? `${e.name === "AssertionError" ? "" : e.name + ": "}${e.message}` : String(e);
    }
    for (const fn of cleanups.reverse()) {
      try {
        await Promise.race([fn(), nextTask(2000)]);
      } catch {
        // cleanup failures do not change the result
      }
    }
    out.push({ name, scope, status, message, ms: Math.round(performance.now() - start) });
  }
  return out;
}
