// Conformance tests for plateau's IndexedDB-compatible API, modelled on the WPT IndexedDB tests
// (IndexedDB/*.any.js) for the M2a scope: open and upgrade, object stores and indexes, keys and key
// order, key ranges, values, transactions and their events, store and index operations, cursors.
// Every test takes the factory and key range class from `env`, so the same file runs against the
// browser's IndexedDB and against plateau.

import {
  aborted,
  assert_equals,
  assert_false,
  assert_not_equals,
  assert_rejects_dom,
  assert_same,
  assert_throws_dom,
  assert_throws_js,
  assert_true,
  assert_unreached,
  done,
  nextTask,
  openDb,
  plateau_test,
  promise_test,
  req,
} from "./harness";

const bin = (...b: number[]) => new Uint8Array(b).buffer;

// Open, upgrade, delete (idbfactory_open*.any.js, idbfactory_deleteDatabase*.any.js,
// idbversionchange*.any.js).

promise_test("open: a new database fires upgradeneeded (0 to 1), then complete, then success", async (t, env) => {
  const name = t.dbName();
  await req(env.factory.deleteDatabase(name));
  const events: string[] = [];
  const open = env.factory.open(name, 1);
  t.add_cleanup(() => req(env.factory.deleteDatabase(name)));
  assert_equals(open.readyState, "pending");
  await new Promise<void>((resolve, reject) => {
    open.onupgradeneeded = (e) => {
      const ev = e as IDBVersionChangeEvent;
      events.push(`upgradeneeded ${ev.oldVersion}->${ev.newVersion}`);
      assert_equals(open.readyState, "done");
      assert_equals(open.result.version, 1);
      assert_equals(open.transaction!.mode, "versionchange");
      open.transaction!.oncomplete = () => events.push("complete");
    };
    open.onsuccess = () => {
      events.push("success");
      assert_equals(open.transaction, null);
      open.result.close();
      resolve();
    };
    open.onerror = () => reject(open.error);
  });
  assert_same(events, ["upgradeneeded 0->1", "complete", "success"]);
});

promise_test("open: without a version opens the current one, or version 1 for a new database", async (t, env) => {
  const name = t.dbName();
  await req(env.factory.deleteDatabase(name));
  t.add_cleanup(() => req(env.factory.deleteDatabase(name)));
  const a = await req<IDBDatabase>(env.factory.open(name));
  assert_equals(a.version, 1);
  a.close();
  const b = await req<IDBDatabase>(env.factory.open(name, 3));
  b.close();
  const c = await req<IDBDatabase>(env.factory.open(name));
  assert_equals(c.version, 3);
  c.close();
});

promise_test("open: a lower version fails with VersionError", async (t, env) => {
  const db = await openDb(t, env, () => {}, 2);
  db.close();
  const r = env.factory.open(db.name, 1);
  let upgraded = false;
  r.onupgradeneeded = () => (upgraded = true);
  try {
    await req(r);
    assert_unreached("open succeeded");
  } catch (e) {
    assert_equals((e as DOMException).name, "VersionError");
  }
  assert_false(upgraded);
  assert_equals(r.result, undefined);
});

promise_test("open: version 0, negative or NaN throws TypeError", async (t, env) => {
  for (const v of [0, -1, NaN, Infinity]) assert_throws_js(TypeError, () => env.factory.open(t.dbName(), v), `version ${v}`);
});

promise_test("open: upgrading an existing database reports the old version and keeps its stores", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s").put("v", 1));
  db.close();
  const open = env.factory.open(db.name, 2);
  let old = -1;
  open.onupgradeneeded = (e) => {
    old = (e as IDBVersionChangeEvent).oldVersion;
    assert_true(open.result.objectStoreNames.contains("s"));
  };
  const db2 = await req<IDBDatabase>(open);
  t.add_cleanup(() => db2.close());
  assert_equals(old, 1);
  assert_equals(db2.version, 2);
  assert_equals(await req(db2.transaction("s").objectStore("s").get(1)), "v");
});

promise_test("open: aborting the upgrade fails the open with AbortError and keeps the old version", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("keep"));
  db.close();
  const open = env.factory.open(db.name, 2);
  open.onupgradeneeded = () => {
    open.result.createObjectStore("dropped");
    open.transaction!.abort();
  };
  try {
    await req(open);
    assert_unreached("open succeeded");
  } catch (e) {
    assert_equals((e as DOMException).name, "AbortError");
  }
  const again = await req<IDBDatabase>(env.factory.open(db.name));
  t.add_cleanup(() => again.close());
  assert_equals(again.version, 1);
  assert_same([...again.objectStoreNames], ["keep"]);
});

promise_test("open: an exception in upgradeneeded aborts the upgrade", async (t, env) => {
  const name = t.dbName();
  await req(env.factory.deleteDatabase(name));
  t.add_cleanup(() => req(env.factory.deleteDatabase(name)));
  const open = env.factory.open(name, 1);
  const onerror = window.onerror;
  window.onerror = () => true;
  t.add_cleanup(() => (window.onerror = onerror));
  open.onupgradeneeded = () => {
    open.result.createObjectStore("s");
    throw new Error("boom");
  };
  try {
    await req(open);
    assert_unreached("open succeeded");
  } catch (e) {
    assert_equals((e as DOMException).name, "AbortError");
  }
});

promise_test("deleteDatabase: success carries the old version, and the data is gone", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s").put(1, 1), 4);
  db.close();
  const del = env.factory.deleteDatabase(db.name);
  const ev = await new Promise<IDBVersionChangeEvent>((resolve, reject) => {
    del.onsuccess = (e) => resolve(e as IDBVersionChangeEvent);
    del.onerror = () => reject(del.error);
  });
  assert_equals(ev.oldVersion, 4);
  assert_equals(ev.newVersion, null);
  assert_equals(del.result, undefined);
  const again = await req<IDBDatabase>(env.factory.open(db.name));
  assert_equals(again.version, 1);
  assert_equals(again.objectStoreNames.length, 0);
  again.close();
});

promise_test("versionchange: an open connection gets versionchange before another upgrades", async (t, env) => {
  const db = await openDb(t, env, () => {});
  let seen: [number, number | null] | null = null;
  db.onversionchange = (e) => {
    seen = [e.oldVersion, e.newVersion];
    db.close();
  };
  const db2 = await req<IDBDatabase>(env.factory.open(db.name, 2));
  db2.close();
  assert_same(seen, [1, 2]);
});

promise_test("factory.cmp orders keys and rejects invalid ones", async (_t, env) => {
  const f = env.factory;
  assert_equals(f.cmp(1, 2), -1);
  assert_equals(f.cmp("b", "a"), 1);
  assert_equals(f.cmp([1, "a"], [1, "a"]), 0);
  assert_equals(f.cmp(-0, 0), 0);
  assert_equals(f.cmp(Infinity, new Date(0)), -1);
  assert_equals(f.cmp("z", bin(0)), -1);
  assert_equals(f.cmp(bin(255), []), -1);
  assert_throws_dom("DataError", () => f.cmp(null, 1));
  assert_throws_dom("DataError", () => f.cmp(1, NaN));
  assert_throws_dom("DataError", () => f.cmp({}, 1));
  assert_throws_dom("DataError", () => f.cmp([1, undefined], 1));
});

// Object stores (idbdatabase_createObjectStore*.any.js, idbdatabase_deleteObjectStore*.any.js).

promise_test("createObjectStore: attributes, sorted objectStoreNames", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    const s = db.createObjectStore("b", { keyPath: "a.b", autoIncrement: true });
    assert_equals(s.name, "b");
    assert_equals(s.keyPath, "a.b");
    assert_true(s.autoIncrement);
    assert_equals(s.indexNames.length, 0);
    const c = db.createObjectStore("a", { keyPath: ["x", "y"] });
    assert_same(c.keyPath, ["x", "y"]);
    assert_equals(c.keyPath, c.keyPath, "keyPath is the same array each time");
    db.createObjectStore("c");
    assert_same([...db.objectStoreNames], ["a", "b", "c"]);
    assert_true(db.objectStoreNames.contains("c"));
    assert_false(db.objectStoreNames.contains("d"));
    assert_equals(db.objectStoreNames.item(0), "a");
  });
  assert_same([...db.objectStoreNames], ["a", "b", "c"]);
  const s = db.transaction("c").objectStore("c");
  assert_equals(s.keyPath, null);
  assert_false(s.autoIncrement);
});

promise_test("createObjectStore: an existing name throws ConstraintError", async (t, env) => {
  await openDb(t, env, (db) => {
    db.createObjectStore("s");
    assert_throws_dom("ConstraintError", () => db.createObjectStore("s"));
  });
});

promise_test("createObjectStore: an invalid key path throws SyntaxError", async (t, env) => {
  await openDb(t, env, (db) => {
    for (const kp of ["a.", ".a", "a..b", "1a", "a b", "a-b", ["a", "b c"]]) {
      assert_throws_dom("SyntaxError", () => db.createObjectStore("s", { keyPath: kp }), `keyPath ${JSON.stringify(kp)}`);
    }
  });
});

promise_test("createObjectStore: autoIncrement with an empty or array key path throws InvalidAccessError", async (t, env) => {
  await openDb(t, env, (db) => {
    assert_throws_dom("InvalidAccessError", () => db.createObjectStore("a", { keyPath: "", autoIncrement: true }));
    assert_throws_dom("InvalidAccessError", () => db.createObjectStore("b", { keyPath: ["x"], autoIncrement: true }));
  });
});

promise_test("createObjectStore: outside an upgrade throws InvalidStateError", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s"));
  assert_throws_dom("InvalidStateError", () => db.createObjectStore("t"));
  assert_throws_dom("InvalidStateError", () => db.deleteObjectStore("s"));
});

promise_test("createObjectStore: after the upgrade transaction became inactive throws TransactionInactiveError", async (t, env) => {
  let tx: IDBTransaction | null = null;
  let dbRef: IDBDatabase | null = null;
  let error = "";
  await openDb(t, env, (db, upgrade) => {
    tx = upgrade;
    dbRef = db;
    db.createObjectStore("s").put(1, 1).onsuccess = () => {
      void tx;
    };
    setTimeout(() => {
      try {
        dbRef!.createObjectStore("late");
      } catch (e) {
        error = (e as DOMException).name;
      }
    }, 0);
  });
  await nextTask(20);
  assert_true(error === "TransactionInactiveError" || error === "InvalidStateError", `got ${error}`);
});

promise_test("deleteObjectStore: removes the store and its data; unknown names throw NotFoundError", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    db.createObjectStore("s").put(1, 1);
    db.createObjectStore("t");
  });
  db.close();
  const open = env.factory.open(db.name, 2);
  open.onupgradeneeded = () => {
    const d = open.result;
    d.deleteObjectStore("s");
    assert_false(d.objectStoreNames.contains("s"));
    assert_throws_dom("NotFoundError", () => d.deleteObjectStore("nope"));
    const s = d.createObjectStore("s");
    s.count().onsuccess = (e) => assert_equals((e.target as IDBRequest).result, 0);
  };
  const db2 = await req<IDBDatabase>(open);
  t.add_cleanup(() => db2.close());
  assert_equals(await req(db2.transaction("s").objectStore("s").count()), 0);
});

promise_test("objectStore: a deleted store's handle throws InvalidStateError", async (t, env) => {
  await openDb(t, env, (db) => {
    const s = db.createObjectStore("s");
    db.deleteObjectStore("s");
    assert_throws_dom("InvalidStateError", () => s.put(1, 1));
    assert_throws_dom("InvalidStateError", () => s.get(1));
  });
});

// Indexes (idbobjectstore_createIndex*.any.js, idbobjectstore_deleteIndex.any.js).

promise_test("createIndex: attributes, indexNames, and errors", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    const s = db.createObjectStore("s");
    const i = s.createIndex("by_a", "a", { unique: true });
    assert_equals(i.name, "by_a");
    assert_equals(i.keyPath, "a");
    assert_true(i.unique);
    assert_false(i.multiEntry);
    assert_equals(i.objectStore, s);
    const j = s.createIndex("by_ab", ["a", "b"]);
    assert_same(j.keyPath, ["a", "b"]);
    s.createIndex("tags", "tags", { multiEntry: true });
    assert_same([...s.indexNames], ["by_a", "by_ab", "tags"]);
    assert_throws_dom("ConstraintError", () => s.createIndex("by_a", "x"));
    assert_throws_dom("SyntaxError", () => s.createIndex("bad", "a b"));
    assert_throws_dom("InvalidAccessError", () => s.createIndex("m", ["a", "b"], { multiEntry: true }));
    assert_equals(s.index("by_a"), i);
    assert_throws_dom("NotFoundError", () => s.index("nope"));
  });
  const s = db.transaction("s").objectStore("s");
  assert_same([...s.indexNames], ["by_a", "by_ab", "tags"]);
  assert_throws_dom("InvalidStateError", () => s.createIndex("x", "x"));
});

promise_test("createIndex: on a store with data indexes the existing records", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    const s = db.createObjectStore("s", { keyPath: "id" });
    for (let i = 0; i < 5; i++) s.put({ id: i, a: 10 - i });
  });
  db.close();
  const open = env.factory.open(db.name, 2);
  open.onupgradeneeded = () => {
    open.transaction!.objectStore("s").createIndex("a", "a");
  };
  const db2 = await req<IDBDatabase>(open);
  t.add_cleanup(() => db2.close());
  const keys = await req(db2.transaction("s").objectStore("s").index("a").getAllKeys());
  assert_same(keys, [4, 3, 2, 1, 0]);
});

promise_test("createIndex: a unique index over duplicate data aborts the upgrade with ConstraintError", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    const s = db.createObjectStore("s");
    s.put({ a: 1 }, 1);
    s.put({ a: 1 }, 2);
  });
  db.close();
  const open = env.factory.open(db.name, 2);
  let txError = "";
  open.onupgradeneeded = () => {
    const tx = open.transaction!;
    tx.objectStore("s").createIndex("a", "a", { unique: true });
    tx.onabort = () => (txError = tx.error?.name ?? "null");
  };
  try {
    await req(open);
    assert_unreached("open succeeded");
  } catch (e) {
    assert_equals((e as DOMException).name, "AbortError");
  }
  assert_equals(txError, "ConstraintError");
});

promise_test("deleteIndex: removes the index; unknown names throw NotFoundError", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    const s = db.createObjectStore("s");
    const i = s.createIndex("a", "a");
    s.deleteIndex("a");
    assert_equals(s.indexNames.length, 0);
    assert_throws_dom("NotFoundError", () => s.deleteIndex("a"));
    assert_throws_dom("InvalidStateError", () => i.get(1));
  });
  assert_equals(db.transaction("s").objectStore("s").indexNames.length, 0);
});

// Keys (keyorder.any.js, key_valid.any.js, key_invalid.any.js, idb-binary-key-*.any.js).

const ORDERED: unknown[] = [
  -Infinity,
  -Number.MAX_VALUE,
  -1,
  -Number.MIN_VALUE,
  0,
  Number.MIN_VALUE,
  1,
  Number.MAX_VALUE,
  Infinity,
  new Date(-1e10),
  new Date(0),
  new Date(1e10),
  "",
  "\u0000",
  "\u0001",
  "A",
  "a",
  "a\u0000",
  "aa",
  "\ud800",
  "￿",
  bin(),
  bin(0),
  bin(0, 255),
  bin(1),
  bin(255),
  [],
  [-Infinity],
  [0],
  [0, 0],
  [new Date(0)],
  [""],
  [bin()],
  [[]],
  [[], []],
  [[[]]],
];

promise_test("keys: records come back in IndexedDB key order (number < Date < string < binary < array)", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    const s = db.createObjectStore("s");
    const shuffled = ORDERED.map((k, i) => [k, i] as const).sort((a, b) => ((a[1] * 7919) % 37) - ((b[1] * 7919) % 37));
    for (const [k, i] of shuffled) s.put(i, k as IDBValidKey);
  });
  const s = db.transaction("s").objectStore("s");
  const values = await req<number[]>(s.getAll());
  assert_same(values, ORDERED.map((_, i) => i));
  const keys = await req<unknown[]>(s.getAllKeys());
  assert_same(keys, ORDERED);
  for (let i = 0; i + 1 < ORDERED.length; i++) assert_equals(env.factory.cmp(ORDERED[i], ORDERED[i + 1]), -1, `${i}`);
});

promise_test("keys: Date keys come back as Dates, binary keys as ArrayBuffers", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    const s = db.createObjectStore("s");
    s.put("d", new Date(5));
    s.put("b", new Uint8Array([1, 2]));
  });
  const keys = await req<unknown[]>(db.transaction("s").objectStore("s").getAllKeys());
  assert_equals(keys.length, 2);
  assert_true(keys[0] instanceof Date && (keys[0] as Date).getTime() === 5, "date");
  assert_true(keys[1] instanceof ArrayBuffer, "binary key is an ArrayBuffer");
  assert_same([...new Uint8Array(keys[1] as ArrayBuffer)], [1, 2]);
});

promise_test("keys: -0 equals 0, and a record stored under -0 reports its key as -0", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s").put("z", -0));
  const s = db.transaction("s").objectStore("s");
  assert_equals(await req(s.get(0)), "z");
  const keys = await req<unknown[]>(s.getAllKeys());
  assert_true(Object.is(keys[0], -0), "the stored key -0 comes back as -0");
});

promise_test("keys: invalid keys throw DataError", async (t, env) => {
  await openDb(t, env, (db) => {
    const s = db.createObjectStore("s");
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    // eslint-disable-next-line no-sparse-arrays
    const bad = [NaN, new Date(NaN), null, true, {}, /x/, [1, NaN], [1, {}], cyclic, [1, , 3]];
    bad.forEach((k, i) => assert_throws_dom("DataError", () => s.put(1, k as IDBValidKey), `bad key #${i}`));
    assert_throws_dom("DataError", () => s.get(NaN));
    assert_throws_dom("DataError", () => s.get(null as unknown as IDBValidKey));
    assert_throws_dom("DataError", () => s.delete({} as IDBValidKey));
  });
});

promise_test("keys: array keys compare element by element", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    const s = db.createObjectStore("s");
    s.put("c", [1, "b"]);
    s.put("a", [1]);
    s.put("b", [1, "a"]);
    s.put("d", [2]);
  });
  const s = db.transaction("s").objectStore("s");
  assert_same(await req(s.getAll()), ["a", "b", "c", "d"]);
  assert_equals(await req(s.get([1, "a"])), "b");
});

// Key ranges (idbkeyrange*.any.js).

promise_test("IDBKeyRange: only, lowerBound, upperBound, bound and their attributes", async (_t, env) => {
  const R = env.KeyRange;
  const only = R.only(3);
  assert_equals(only.lower, 3);
  assert_equals(only.upper, 3);
  assert_false(only.lowerOpen);
  const lo = R.lowerBound("a", true);
  assert_equals(lo.lower, "a");
  assert_equals(lo.upper, undefined);
  assert_true(lo.lowerOpen);
  assert_true(lo.upperOpen);
  const up = R.upperBound([1, 2]);
  assert_same(up.upper, [1, 2]);
  assert_false(up.upperOpen);
  const b = R.bound(1, 5, true, false);
  assert_true(b.lowerOpen);
  assert_false(b.upperOpen);
});

promise_test("IDBKeyRange: invalid bounds throw DataError", async (_t, env) => {
  const R = env.KeyRange;
  assert_throws_dom("DataError", () => R.only(null));
  assert_throws_dom("DataError", () => R.lowerBound(NaN));
  assert_throws_dom("DataError", () => R.bound(2, 1));
  assert_throws_dom("DataError", () => R.bound(1, 1, true, false));
  assert_throws_dom("DataError", () => R.bound(1, 1, false, true));
  assert_throws_dom("DataError", () => R.bound("a", 1));
});

promise_test("IDBKeyRange.includes", async (_t, env) => {
  const R = env.KeyRange;
  const r = R.bound(1, 5, false, true);
  assert_true(r.includes(1));
  assert_true(r.includes(4.9));
  assert_false(r.includes(5));
  assert_false(r.includes("1"));
  assert_true(R.lowerBound(10).includes([]));
  assert_true(R.upperBound("z").includes(new Date()));
  assert_throws_dom("DataError", () => r.includes(null));
});

promise_test("key ranges select records in getAll, count and delete", async (t, env) => {
  const R = env.KeyRange;
  const db = await openDb(t, env, (db) => {
    const s = db.createObjectStore("s");
    for (let i = 1; i <= 10; i++) s.put(i, i);
  });
  const tx = db.transaction("s", "readwrite");
  const s = tx.objectStore("s");
  assert_same(await req(s.getAll(R.bound(3, 6))), [3, 4, 5, 6]);
  assert_same(await req(s.getAll(R.bound(3, 6, true, true))), [4, 5]);
  assert_same(await req(s.getAll(R.lowerBound(9))), [9, 10]);
  assert_same(await req(s.getAll(R.upperBound(2, true))), [1]);
  assert_same(await req(s.getAll(null, 3)), [1, 2, 3]);
  assert_same(await req(s.getAll(R.lowerBound(5), 2)), [5, 6]);
  assert_equals(await req(s.count(R.bound(2, 4))), 3);
  assert_equals(await req(s.count(7)), 1);
  await req(s.delete(R.bound(2, 9)));
  assert_same(await req(s.getAllKeys()), [1, 10]);
  assert_equals(await req(s.get(R.lowerBound(2))), 10);
  assert_equals(await req(s.getKey(R.upperBound(5))), 1);
  await done(tx);
});

// Values (structured clone: idbobjectstore_put*.any.js, structured-clone.any.js).

promise_test("values: supported structured-clone types round-trip", async (t, env) => {
  // eslint-disable-next-line no-sparse-arrays
  const sparse = [1, , 3];
  const value = {
    str: "s\u0000\ud800",
    num: [1.5, -0, NaN, Infinity, -Infinity],
    bool: [true, false],
    nul: null,
    undef: undefined,
    date: new Date(1700000000000),
    bytes: new Uint8Array([0, 1, 255]),
    floats: new Float64Array([1.25]),
    buf: bin(9, 8),
    map: new Map<unknown, unknown>([["k", 1], [2, { deep: [true] }]]),
    set: new Set(["a", 1]),
    nested: { a: [{ b: [1, [2, [3]]] }] },
    sparse,
    big: 10n ** 20n,
    $dollar: { $u: 1 },
  };
  const db = await openDb(t, env, (db) => db.createObjectStore("s"));
  const tx = db.transaction("s", "readwrite");
  tx.objectStore("s").put(value, 1);
  await done(tx);
  const got = await req<typeof value>(db.transaction("s").objectStore("s").get(1));
  assert_equals(got.str, value.str);
  assert_true(Object.is(got.num[1], -0), "-0");
  assert_true(Number.isNaN(got.num[2]), "NaN");
  assert_same(got.num, value.num);
  assert_same(got.bool, value.bool);
  assert_equals(got.nul, null);
  assert_true("undef" in got && got.undef === undefined, "undefined property kept");
  assert_true(got.date instanceof Date && got.date.getTime() === value.date.getTime(), "date");
  assert_true(got.bytes instanceof Uint8Array, "Uint8Array");
  assert_same(got.bytes, value.bytes);
  assert_true(got.floats instanceof Float64Array, "Float64Array");
  assert_same(got.buf, value.buf);
  assert_true(got.map instanceof Map && got.map.get("k") === 1, "map");
  assert_same(got.map, value.map);
  assert_true(got.set instanceof Set && got.set.has("a"), "set");
  assert_same(got.nested, value.nested);
  assert_equals(got.sparse.length, 3);
  assert_false(1 in got.sparse, "hole kept");
  assert_equals(got.big, value.big);
  assert_same(got.$dollar, { $u: 1 });
});

promise_test("values: shared references and cycles survive the clone", async (t, env) => {
  const shared = { n: 1 };
  const v: Record<string, unknown> = { a: shared, b: shared };
  v.self = v;
  const db = await openDb(t, env, (db) => db.createObjectStore("s").put(v, 1));
  const got = await req<Record<string, any>>(db.transaction("s").objectStore("s").get(1));
  assert_true(got.a === got.b, "shared");
  assert_true(got.self === got, "cycle");
});

promise_test("values: functions and symbols throw DataCloneError, synchronously", async (t, env) => {
  await openDb(t, env, (db) => {
    const s = db.createObjectStore("s");
    assert_throws_dom("DataCloneError", () => s.put(() => 1, 1));
    assert_throws_dom("DataCloneError", () => s.put({ f() {} }, 1));
    assert_throws_dom("DataCloneError", () => s.put([Symbol("x")], 1));
    assert_throws_dom("DataCloneError", () => s.put({ w: new WeakMap() }, 1));
  });
});

promise_test("values: the value is cloned when put is called, and each get returns a new copy", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s"));
  const v = { list: [1] };
  const tx = db.transaction("s", "readwrite");
  tx.objectStore("s").put(v, 1);
  v.list.push(2);
  await done(tx);
  const s = db.transaction("s").objectStore("s");
  const [a, b] = await Promise.all([req(s.get(1)), req(s.get(1))]);
  assert_same(a, { list: [1] });
  assert_not_equals(a, b);
});

// Store operations (idbobjectstore_add*.any.js, _put*.any.js, _get*.any.js, _getKey.any.js,
// _getAll*.any.js, _count*.any.js, _delete*.any.js, _clear*.any.js).

promise_test("add: an existing key fails with ConstraintError, which aborts the transaction", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s", { keyPath: "id" }));
  const tx = db.transaction("s", "readwrite");
  const s = tx.objectStore("s");
  s.add({ id: 1, v: "first" });
  const r = s.add({ id: 1, v: "second" });
  const errName = await new Promise<string>((resolve) => (r.onerror = () => resolve(r.error!.name)));
  assert_equals(errName, "ConstraintError");
  assert_equals((await aborted(tx))?.name, "ConstraintError");
  assert_equals(await req(db.transaction("s").objectStore("s").count()), 0);
});

promise_test("add: a prevented ConstraintError lets the transaction commit", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s", { keyPath: "id" }));
  const tx = db.transaction("s", "readwrite");
  const s = tx.objectStore("s");
  s.add({ id: 1, v: "first" });
  s.add({ id: 1, v: "second" }).onerror = (e) => e.preventDefault();
  s.add({ id: 2, v: "third" });
  await done(tx);
  assert_same(await req(db.transaction("s").objectStore("s").getAll()), [
    { id: 1, v: "first" },
    { id: 2, v: "third" },
  ]);
});

promise_test("put: replaces the record with the same key and returns the key", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s", { keyPath: "k.id" }));
  const tx = db.transaction("s", "readwrite");
  const s = tx.objectStore("s");
  assert_same(await req(s.put({ k: { id: [1, "x"] }, v: 1 })), [1, "x"]);
  await req(s.put({ k: { id: [1, "x"] }, v: 2 }));
  assert_equals(await req(s.count()), 1);
  assert_same(await req(s.get([1, "x"])), { k: { id: [1, "x"] }, v: 2 });
  await done(tx);
});

promise_test("put: key rules for in-line and out-of-line keys throw DataError", async (t, env) => {
  await openDb(t, env, (db) => {
    const inline = db.createObjectStore("in", { keyPath: "id" });
    assert_throws_dom("DataError", () => inline.put({ id: 1 }, 1), "key given for in-line store");
    assert_throws_dom("DataError", () => inline.put({ nope: 1 }), "missing in-line key");
    assert_throws_dom("DataError", () => inline.put({ id: null }), "invalid in-line key");
    assert_throws_dom("DataError", () => inline.put(5), "primitive value with key path");
    const out = db.createObjectStore("out");
    assert_throws_dom("DataError", () => out.put("v"), "no key for out-of-line store");
  });
});

promise_test("put: in a readonly transaction throws ReadOnlyError", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s"));
  const s = db.transaction("s").objectStore("s");
  assert_throws_dom("ReadOnlyError", () => s.put(1, 1));
  assert_throws_dom("ReadOnlyError", () => s.add(1, 1));
  assert_throws_dom("ReadOnlyError", () => s.delete(1));
  assert_throws_dom("ReadOnlyError", () => s.clear());
});

promise_test("get, getKey: missing keys give undefined; ranges give the first match", async (t, env) => {
  const R = env.KeyRange;
  const db = await openDb(t, env, (db) => {
    const s = db.createObjectStore("s");
    s.put("a", 1);
    s.put("b", 2);
  });
  const s = db.transaction("s").objectStore("s");
  assert_equals(await req(s.get(3)), undefined);
  assert_equals(await req(s.get(R.lowerBound(1, true))), "b");
  assert_equals(await req(s.getKey(R.lowerBound(0))), 1);
  assert_equals(await req(s.getKey(5)), undefined);
  assert_throws_dom("DataError", () => s.getKey(null as unknown as IDBValidKey));
});

promise_test("getAll, getAllKeys: whole store, ranges and counts", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    const s = db.createObjectStore("s", { autoIncrement: true });
    for (const v of ["a", "b", "c", "d"]) s.add(v);
  });
  const s = db.transaction("s").objectStore("s");
  assert_same(await req(s.getAll()), ["a", "b", "c", "d"]);
  assert_same(await req(s.getAllKeys()), [1, 2, 3, 4]);
  assert_same(await req(s.getAll(undefined, 2)), ["a", "b"]);
  assert_same(await req(s.getAllKeys(2)), [2]);
  assert_same(await req(s.getAll(env.KeyRange.bound(5, 9))), []);
  assert_throws_js(TypeError, () => s.getAll(null, -1));
});

promise_test("count: whole store, one key, a range", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    const s = db.createObjectStore("s");
    for (let i = 0; i < 20; i++) s.put(i, i);
  });
  const s = db.transaction("s").objectStore("s");
  assert_equals(await req(s.count()), 20);
  assert_equals(await req(s.count(5)), 1);
  assert_equals(await req(s.count(50)), 0);
  assert_equals(await req(s.count(env.KeyRange.lowerBound(15))), 5);
});

promise_test("delete and clear", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    const s = db.createObjectStore("s");
    for (let i = 0; i < 5; i++) s.put(i, i);
  });
  let tx = db.transaction("s", "readwrite");
  let s = tx.objectStore("s");
  assert_equals(await req(s.delete(2)), undefined);
  assert_equals(await req(s.delete(99)), undefined);
  assert_same(await req(s.getAllKeys()), [0, 1, 3, 4]);
  await done(tx);
  tx = db.transaction("s", "readwrite");
  s = tx.objectStore("s");
  assert_equals(await req(s.clear()), undefined);
  assert_equals(await req(s.count()), 0);
  await done(tx);
  assert_equals(await req(db.transaction("s").objectStore("s").count()), 0);
});

promise_test("writes persist across close and reopen", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    db.createObjectStore("s", { keyPath: "id" }).createIndex("by_v", "v");
  });
  const tx = db.transaction("s", "readwrite");
  for (let i = 0; i < 50; i++) tx.objectStore("s").put({ id: i, v: i % 5 });
  tx.objectStore("s").delete(7);
  await done(tx);
  db.close();
  const db2 = await req<IDBDatabase>(env.factory.open(db.name));
  t.add_cleanup(() => db2.close());
  const s = db2.transaction("s").objectStore("s");
  assert_equals(await req(s.count()), 49);
  assert_same(await req(s.get(8)), { id: 8, v: 3 });
  assert_equals(await req(s.index("by_v").count(2)), 9);
});

// Key generators (keygenerator*.any.js).

promise_test("autoIncrement: keys 1, 2, 3; explicit larger keys move the generator", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s", { autoIncrement: true }));
  const tx = db.transaction("s", "readwrite");
  const s = tx.objectStore("s");
  assert_equals(await req(s.add("a")), 1);
  assert_equals(await req(s.add("b")), 2);
  assert_equals(await req(s.add("c", 10.5)), 10.5);
  assert_equals(await req(s.add("d")), 11);
  assert_equals(await req(s.add("e", "str")), "str");
  assert_equals(await req(s.add("f", -5)), -5);
  assert_equals(await req(s.add("g")), 12);
  await done(tx);
});

promise_test("autoIncrement: generated keys go into the key path, creating objects on the way", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s", { keyPath: "a.b.id", autoIncrement: true }));
  const tx = db.transaction("s", "readwrite");
  const s = tx.objectStore("s");
  assert_equals(await req(s.put({ name: "x" })), 1);
  assert_equals(await req(s.put({ a: { c: 1 }, name: "y" })), 2);
  assert_same(await req(s.get(1)), { name: "x", a: { b: { id: 1 } } });
  assert_same(await req(s.get(2)), { a: { c: 1, b: { id: 2 } }, name: "y" });
  assert_throws_dom("DataError", () => s.put({ a: 5 }), "cannot inject into a number");
  await done(tx);
});

promise_test("autoIncrement: deleting records does not reuse keys, across reopen", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    const s = db.createObjectStore("s", { autoIncrement: true });
    s.add("a");
    s.add("b");
  });
  let tx = db.transaction("s", "readwrite");
  tx.objectStore("s").clear();
  await done(tx);
  db.close();
  const db2 = await req<IDBDatabase>(env.factory.open(db.name));
  t.add_cleanup(() => db2.close());
  tx = db2.transaction("s", "readwrite");
  assert_equals(await req(tx.objectStore("s").add("c")), 3);
  await done(tx);
});

promise_test("autoIncrement: an aborted transaction rolls the generator back", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s", { autoIncrement: true }));
  let tx = db.transaction("s", "readwrite");
  await req(tx.objectStore("s").add("a"));
  await req(tx.objectStore("s").add("b"));
  tx.abort();
  await aborted(tx);
  tx = db.transaction("s", "readwrite");
  assert_equals(await req(tx.objectStore("s").add("c")), 1);
  await done(tx);
});

// Transactions (idbtransaction*.any.js, transaction-lifetime*.any.js, idbdatabase_transaction*.any.js).

promise_test("transaction: arguments, mode, scope and errors", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    db.createObjectStore("a");
    db.createObjectStore("b");
  });
  const tx = db.transaction(["b", "a", "a"]);
  assert_equals(tx.mode, "readonly");
  assert_same([...tx.objectStoreNames], ["a", "b"]);
  assert_equals(tx.db, db);
  assert_equals(tx.error, null);
  assert_equals(db.transaction("a", "readwrite").mode, "readwrite");
  assert_throws_dom("NotFoundError", () => db.transaction("nope"));
  assert_throws_dom("InvalidAccessError", () => db.transaction([]));
  assert_throws_js(TypeError, () => db.transaction("a", "versionchange" as IDBTransactionMode));
  assert_throws_dom("NotFoundError", () => tx.objectStore("c"));
  assert_equals(tx.objectStore("a"), tx.objectStore("a"));
  await done(tx);
  assert_throws_dom("InvalidStateError", () => tx.objectStore("a"));
});

promise_test("transaction: during an upgrade, db.transaction throws InvalidStateError", async (t, env) => {
  await openDb(t, env, (db) => {
    db.createObjectStore("s");
    assert_throws_dom("InvalidStateError", () => db.transaction("s"));
  });
});

promise_test("transaction: on a closed connection throws InvalidStateError", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s"));
  db.close();
  assert_throws_dom("InvalidStateError", () => db.transaction("s"));
});

promise_test("transaction: inactive after the creating task; requests then throw TransactionInactiveError", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s"));
  const tx = db.transaction("s", "readwrite");
  const s = tx.objectStore("s");
  await nextTask(10);
  assert_throws_dom("TransactionInactiveError", () => s.put(1, 1));
  assert_throws_dom("TransactionInactiveError", () => s.get(1));
});

promise_test("transaction: active inside request callbacks and in promise continuations from them", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s"));
  const tx = db.transaction("s", "readwrite");
  const s = tx.objectStore("s");
  await req(s.put("a", 1));
  await req(s.put("b", 2));
  assert_equals(await req(s.get(1)), "a");
  await done(tx);
});

promise_test("transaction: completes when its requests are done, with complete after the last success", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s"));
  const tx = db.transaction("s", "readwrite");
  const events: string[] = [];
  const r1 = tx.objectStore("s").put("a", 1);
  r1.onsuccess = () => {
    events.push("put1");
    tx.objectStore("s").put("b", 2).onsuccess = () => events.push("put2");
  };
  tx.oncomplete = () => events.push("complete");
  await done(tx);
  assert_same(events, ["put1", "put2", "complete"]);
});

promise_test("transaction: an empty transaction completes", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s"));
  await done(db.transaction("s"));
  await done(db.transaction("s", "readwrite"));
});

promise_test("abort: pending requests fail with AbortError, then abort fires; changes are rolled back", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s").put("old", 1));
  const tx = db.transaction("s", "readwrite");
  const s = tx.objectStore("s");
  const events: string[] = [];
  s.put("new", 1).onsuccess = () => {
    const r = s.put("x", 2);
    r.onerror = (e) => {
      events.push(`error ${r.error!.name}`);
      assert_equals((e as Event).type, "error");
    };
    r.onsuccess = () => events.push("unexpected success");
    tx.abort();
    events.push("aborted");
    assert_throws_dom("InvalidStateError", () => tx.abort());
  };
  tx.onabort = () => events.push("abort");
  assert_equals(await aborted(tx), null);
  assert_same(events, ["aborted", "error AbortError", "abort"]);
  const s2 = db.transaction("s").objectStore("s");
  assert_equals(await req(s2.get(1)), "old");
  assert_equals(await req(s2.get(2)), undefined);
});

promise_test("abort: the abort event bubbles to the database", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s"));
  const tx = db.transaction("s", "readwrite");
  let seen = "";
  db.onabort = (e) => (seen = (e.target as IDBTransaction) === tx ? "tx" : "other");
  tx.abort();
  await aborted(tx);
  await nextTask();
  assert_equals(seen, "tx");
});

promise_test("errors: a request error bubbles to the transaction and the database", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s", { keyPath: "id" }));
  const tx = db.transaction("s", "readwrite");
  const s = tx.objectStore("s");
  s.add({ id: 1 });
  const r = s.add({ id: 1 });
  const path: string[] = [];
  r.onerror = (e) => path.push(`request ${(e.target as IDBRequest) === r} ${e.bubbles} ${e.cancelable}`);
  tx.onerror = (e) => path.push(`tx ${(e.target as IDBRequest) === r}`);
  db.onerror = (e) => {
    path.push(`db ${(e.target as IDBRequest) === r}`);
    e.preventDefault();
  };
  await done(tx);
  assert_same(path, ["request true true true", "tx true", "db true"]);
});

promise_test("errors: success events do not bubble", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s"));
  const tx = db.transaction("s", "readwrite");
  let txSaw = false;
  tx.addEventListener("success", () => (txSaw = true));
  const r = tx.objectStore("s").put(1, 1);
  const bubbles = await new Promise<boolean>((resolve) => (r.onsuccess = (e) => resolve(e.bubbles)));
  await done(tx);
  assert_false(bubbles);
  assert_false(txSaw);
});

promise_test("errors: an exception in a success handler aborts the transaction", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s"));
  const onerror = window.onerror;
  window.onerror = () => true;
  t.add_cleanup(() => (window.onerror = onerror));
  const tx = db.transaction("s", "readwrite");
  tx.objectStore("s").put(1, 1).onsuccess = () => {
    throw new Error("thrown on purpose");
  };
  const e = await aborted(tx);
  assert_equals(e?.name, "AbortError");
  assert_equals(await req(db.transaction("s").objectStore("s").count()), 0);
});

promise_test("commit(): commits early; later requests throw", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s"));
  const tx = db.transaction("s", "readwrite");
  const s = tx.objectStore("s");
  s.put("a", 1);
  tx.commit();
  assert_throws_dom("TransactionInactiveError", () => s.put("b", 2));
  await done(tx);
  assert_equals(await req(db.transaction("s").objectStore("s").get(1)), "a");
});

promise_test("ordering: overlapping readwrite transactions run in creation order", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s"));
  const order: string[] = [];
  const t1 = db.transaction("s", "readwrite");
  const t2 = db.transaction("s", "readwrite");
  const t3 = db.transaction("s");
  t1.objectStore("s").put("one", 1).onsuccess = () => order.push("t1");
  t2.objectStore("s").get(1).onsuccess = (e) => order.push(`t2 sees ${(e.target as IDBRequest).result}`);
  t2.objectStore("s").put("two", 1);
  t3.objectStore("s").get(1).onsuccess = (e) => order.push(`t3 sees ${(e.target as IDBRequest).result}`);
  await Promise.all([done(t1), done(t2), done(t3)]);
  assert_same(order, ["t1", "t2 sees one", "t3 sees two"]);
});

promise_test("ordering: a transaction spanning two stores commits both", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    db.createObjectStore("a");
    db.createObjectStore("b");
  });
  const tx = db.transaction(["a", "b"], "readwrite");
  tx.objectStore("a").put("x", 1);
  tx.objectStore("b").put("y", 1);
  await done(tx);
  db.close();
  const db2 = await req<IDBDatabase>(env.factory.open(db.name));
  t.add_cleanup(() => db2.close());
  const r = db2.transaction(["a", "b"]);
  assert_equals(await req(r.objectStore("a").get(1)), "x");
  assert_equals(await req(r.objectStore("b").get(1)), "y");
});

promise_test("requests: readyState, source, transaction, result before done throws", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s"));
  const tx = db.transaction("s", "readwrite");
  const s = tx.objectStore("s");
  const r = s.put("v", 1);
  assert_equals(r.readyState, "pending");
  assert_equals(r.source, s);
  assert_equals(r.transaction, tx);
  assert_throws_dom("InvalidStateError", () => r.result);
  assert_throws_dom("InvalidStateError", () => r.error);
  await req(r);
  assert_equals(r.readyState, "done");
  assert_equals(r.result, 1);
  assert_equals(r.error, null);
  await done(tx);
});

promise_test("events: addEventListener, on-handlers and stopPropagation", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s", { keyPath: "id" }));
  const tx = db.transaction("s", "readwrite");
  const s = tx.objectStore("s");
  s.add({ id: 1 });
  const r = s.add({ id: 1 });
  const seen: string[] = [];
  r.addEventListener("error", () => seen.push("listener"));
  r.onerror = (e) => {
    seen.push("handler");
    e.stopPropagation();
    e.preventDefault();
  };
  tx.onerror = () => seen.push("tx");
  await done(tx);
  assert_same(seen, ["listener", "handler"]);
});

// Indexes in use (idbindex_get*.any.js, idbindex_getKey, idbindex_getAll*, idbindex_count,
// idbindex-multientry*.any.js, idbindex_unique).

async function people(t: Parameters<Parameters<typeof promise_test>[1]>[0], env: Parameters<Parameters<typeof promise_test>[1]>[1]) {
  return openDb(t, env, (db) => {
    const s = db.createObjectStore("people", { keyPath: "id" });
    s.createIndex("name", "name");
    s.createIndex("email", "email", { unique: true });
    s.createIndex("tags", "tags", { multiEntry: true });
    s.createIndex("name_age", ["name", "age"]);
    s.createIndex("city", "address.city");
    s.put({ id: 3, name: "bob", age: 30, email: "b@x", tags: ["a", "b", "a"], address: { city: "Oslo" } });
    s.put({ id: 1, name: "amy", age: 40, email: "a@x", tags: ["b"], address: { city: "Rome" } });
    s.put({ id: 2, name: "bob", age: 20, email: "c@x", tags: [], address: { city: "Oslo" } });
    s.put({ id: 4, name: "cat", age: 50, tags: "c" });
  });
}

promise_test("index: get, getKey, count and duplicates ordered by primary key", async (t, env) => {
  const db = await people(t, env);
  const s = db.transaction("people").objectStore("people");
  const name = s.index("name");
  assert_equals((await req<{ id: number }>(name.get("bob"))).id, 2);
  assert_equals(await req(name.getKey("bob")), 2);
  assert_equals(await req(name.get("zed")), undefined);
  assert_equals(await req(name.count("bob")), 2);
  assert_equals(await req(name.count()), 4);
  assert_same(await req(name.getAllKeys("bob")), [2, 3]);
  assert_same(await req(name.getAllKeys()), [1, 2, 3, 4]);
  assert_same((await req<{ id: number }[]>(name.getAll(env.KeyRange.lowerBound("b")))).map((p) => p.id), [2, 3, 4]);
  assert_same(await req(name.getAllKeys(undefined, 2)), [1, 2]);
});

promise_test("index: records without a valid key at the key path are not indexed", async (t, env) => {
  const db = await people(t, env);
  const s = db.transaction("people").objectStore("people");
  assert_equals(await req(s.index("email").count()), 3);
  assert_equals(await req(s.index("city").count()), 3);
  assert_same(await req(s.index("city").getAllKeys("Oslo")), [2, 3]);
});

promise_test("index: compound key path", async (t, env) => {
  const db = await people(t, env);
  const idx = db.transaction("people").objectStore("people").index("name_age");
  assert_same(await req(idx.getAllKeys(env.KeyRange.bound(["bob", 0], ["bob", 100]))), [2, 3]);
  assert_equals(await req(idx.getKey(["bob", 30])), 3);
  assert_same(await req(idx.getAllKeys()), [1, 2, 3, 4]);
});

promise_test("index: multiEntry indexes each distinct element; a non-array value is one key", async (t, env) => {
  const db = await people(t, env);
  const tags = db.transaction("people").objectStore("people").index("tags");
  assert_equals(await req(tags.count()), 4);
  assert_same(await req(tags.getAllKeys("b")), [1, 3]);
  assert_same(await req(tags.getAllKeys("a")), [3]);
  assert_same(await req(tags.getAllKeys("c")), [4]);
});

promise_test("index: unique index rejects a second record with the same key (ConstraintError)", async (t, env) => {
  const db = await people(t, env);
  const tx = db.transaction("people", "readwrite");
  const s = tx.objectStore("people");
  const r = s.put({ id: 9, name: "dup", email: "a@x" });
  const name = await new Promise<string>((resolve) => (r.onerror = () => resolve(r.error!.name)));
  assert_equals(name, "ConstraintError");
  await aborted(tx);
  const tx2 = db.transaction("people", "readwrite");
  await req(tx2.objectStore("people").put({ id: 1, name: "amy", age: 41, email: "a@x", tags: [] }));
  await done(tx2);
});

promise_test("index: updates and deletes move index entries", async (t, env) => {
  const db = await people(t, env);
  const tx = db.transaction("people", "readwrite");
  const s = tx.objectStore("people");
  s.put({ id: 3, name: "zoe", tags: ["z"] });
  s.delete(2);
  await done(tx);
  const r = db.transaction("people").objectStore("people");
  assert_same(await req(r.index("name").getAllKeys()), [1, 4, 3]);
  assert_same(await req(r.index("name").getAllKeys("bob")), []);
  assert_same(await req(r.index("tags").getAllKeys("a")), []);
  assert_same(await req(r.index("tags").getAllKeys("z")), [3]);
});

// Cursors (idbcursor-*.any.js, idbcursor_continue*, idbcursor_advance*, idbcursor_update*,
// idbcursor_delete*, idbcursor-continuePrimaryKey*, idbobjectstore_openKeyCursor*).

async function walk(r: IDBRequest, take: (c: IDBCursorWithValue) => unknown, step?: (c: IDBCursorWithValue) => void): Promise<unknown[]> {
  const out: unknown[] = [];
  return new Promise((resolve, reject) => {
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const c = r.result as IDBCursorWithValue | null;
      if (!c) return resolve(out);
      out.push(take(c));
      if (step) step(c);
      else c.continue();
    };
  });
}

promise_test("cursor: store cursor next and prev, with a range", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    const s = db.createObjectStore("s");
    for (const k of [5, 1, 3, 2, 4]) s.put(`v${k}`, k);
  });
  const s = db.transaction("s").objectStore("s");
  assert_same(await walk(s.openCursor(), (c) => [c.key, c.primaryKey, c.value]), [
    [1, 1, "v1"],
    [2, 2, "v2"],
    [3, 3, "v3"],
    [4, 4, "v4"],
    [5, 5, "v5"],
  ]);
  assert_same(await walk(s.openCursor(env.KeyRange.bound(2, 4), "prev"), (c) => c.key), [4, 3, 2]);
  assert_same(await walk(s.openCursor(3), (c) => c.value), ["v3"]);
  assert_same(await walk(s.openCursor(env.KeyRange.lowerBound(9)), (c) => c.key), []);
});

promise_test("cursor: index cursor in all four directions over duplicates", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    const s = db.createObjectStore("s");
    s.createIndex("i", "k");
    s.put({ k: "a" }, 1);
    s.put({ k: "b" }, 2);
    s.put({ k: "a" }, 3);
    s.put({ k: "c" }, 4);
    s.put({ k: "b" }, 5);
  });
  const i = db.transaction("s").objectStore("s").index("i");
  const take = (c: IDBCursorWithValue) => `${c.key}${c.primaryKey}`;
  assert_same(await walk(i.openCursor(), take), ["a1", "a3", "b2", "b5", "c4"]);
  assert_same(await walk(i.openCursor(null, "prev"), take), ["c4", "b5", "b2", "a3", "a1"]);
  assert_same(await walk(i.openCursor(null, "nextunique"), take), ["a1", "b2", "c4"]);
  assert_same(await walk(i.openCursor(null, "prevunique"), take), ["c4", "b2", "a1"]);
  assert_same(await walk(i.openKeyCursor(env.KeyRange.bound("a", "b", true, false)), take), ["b2", "b5"]);
  assert_throws_js(TypeError, () => i.openCursor(null, "sideways" as IDBCursorDirection));
});

promise_test("cursor: attributes, and key cursors have no value", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s").put({ x: 1 }, [1, 2]));
  const s = db.transaction("s").objectStore("s");
  const r = s.openCursor();
  const c = (await req<IDBCursorWithValue>(r))!;
  assert_equals(c.source, s);
  assert_equals(c.direction, "next");
  assert_equals(c.request, r);
  assert_same(c.key, [1, 2]);
  assert_equals(c.value, c.value, "value is the same object each time");
  const k = (await req<IDBCursor>(s.openKeyCursor()))!;
  assert_false("value" in k, "a key cursor has no value attribute");
});

promise_test("cursor: continue(key) jumps; a key behind the cursor throws DataError", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    const s = db.createObjectStore("s");
    for (let i = 1; i <= 10; i++) s.put(i, i);
  });
  const s = db.transaction("s").objectStore("s");
  let threw = "";
  const keys = await walk(
    s.openCursor(),
    (c) => c.key,
    (c) => {
      if (c.key === 2) {
        try {
          c.continue(1);
        } catch (e) {
          threw = (e as DOMException).name;
        }
        c.continue(7.5);
      } else c.continue();
    },
  );
  assert_same(keys, [1, 2, 8, 9, 10]);
  assert_equals(threw, "DataError");
  const back = await walk(
    s.openCursor(null, "prev"),
    (c) => c.key,
    (c) => (c.key === 9 ? c.continue(3) : c.continue()),
  );
  assert_same(back, [10, 9, 3, 2, 1]);
});

promise_test("cursor: advance(n) skips records; advance(0) throws TypeError", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    const s = db.createObjectStore("s");
    for (let i = 1; i <= 10; i++) s.put(i, i);
  });
  const s = db.transaction("s").objectStore("s");
  let threw = "";
  const keys = await walk(
    s.openCursor(),
    (c) => c.key,
    (c) => {
      try {
        c.advance(0);
      } catch (e) {
        threw = (e as Error).name;
      }
      c.advance(3);
    },
  );
  assert_same(keys, [1, 4, 7, 10]);
  assert_equals(threw, "TypeError");
});

promise_test("cursor: calling continue twice, or after the end, throws InvalidStateError", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    const s = db.createObjectStore("s");
    s.put(1, 1);
    s.put(2, 2);
  });
  const s = db.transaction("s").objectStore("s");
  const r = s.openCursor();
  const errors: string[] = [];
  let last: IDBCursor | null = null;
  await new Promise<void>((resolve) => {
    r.onsuccess = () => {
      const c = r.result as IDBCursor | null;
      if (!c) {
        try {
          last!.continue();
        } catch (e) {
          errors.push((e as DOMException).name);
        }
        return resolve();
      }
      last = c;
      c.continue();
      try {
        c.continue();
      } catch (e) {
        errors.push((e as DOMException).name);
      }
    };
  });
  assert_same(errors, ["InvalidStateError", "InvalidStateError", "InvalidStateError"]);
});

promise_test("cursor: continuePrimaryKey on an index cursor", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    const s = db.createObjectStore("s");
    s.createIndex("i", "k");
    for (let p = 1; p <= 6; p++) s.put({ k: p <= 3 ? "a" : "b" }, p);
  });
  const s = db.transaction("s").objectStore("s");
  let first = true;
  const got = await walk(
    s.index("i").openCursor(),
    (c) => `${c.key}${c.primaryKey}`,
    (c) => {
      if (first) {
        first = false;
        c.continuePrimaryKey("b", 5);
      } else c.continue();
    },
  );
  assert_same(got, ["a1", "b5", "b6"]);
  const sc = (await req<IDBCursor>(s.openCursor()))!;
  assert_throws_dom("InvalidAccessError", () => sc.continuePrimaryKey(1, 1));
});

promise_test("cursor: update and delete through a cursor", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    const s = db.createObjectStore("s", { keyPath: "id" });
    s.createIndex("v", "v");
    for (let i = 1; i <= 5; i++) s.put({ id: i, v: i });
  });
  const tx = db.transaction("s", "readwrite");
  const s = tx.objectStore("s");
  let threw = "";
  await walk(
    s.openCursor(),
    (c) => c.key,
    (c) => {
      const v = c.value as { id: number; v: number };
      if (v.id % 2 === 0) c.delete();
      else c.update({ id: v.id, v: v.v * 10 });
      if (v.id === 1) {
        try {
          c.update({ id: 99, v: 0 });
        } catch (e) {
          threw = (e as DOMException).name;
        }
      }
      c.continue();
    },
  );
  await done(tx);
  assert_equals(threw, "DataError");
  const r = db.transaction("s").objectStore("s");
  assert_same(await req(r.getAll()), [
    { id: 1, v: 10 },
    { id: 3, v: 30 },
    { id: 5, v: 50 },
  ]);
  assert_same(await req(r.index("v").getAllKeys(env.KeyRange.lowerBound(10))), [1, 3, 5]);
});

promise_test("cursor: update and delete in a readonly transaction throw ReadOnlyError", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s").put(1, 1));
  const c = (await req<IDBCursorWithValue>(db.transaction("s").objectStore("s").openCursor()))!;
  assert_throws_dom("ReadOnlyError", () => c.update(2));
  assert_throws_dom("ReadOnlyError", () => c.delete());
});

promise_test("cursor: a cursor sees records written during iteration in key order", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    const s = db.createObjectStore("s");
    s.put("a", 1);
    s.put("c", 3);
  });
  const tx = db.transaction("s", "readwrite");
  const s = tx.objectStore("s");
  let added = false;
  const seen = await walk(
    s.openCursor(),
    (c) => c.key,
    (c) => {
      if (!added) {
        added = true;
        s.put("b", 2);
        s.put("d", 4);
      }
      c.continue();
    },
  );
  assert_same(seen, [1, 2, 3, 4]);
  await done(tx);
});

promise_test("cursor: on an empty store the result is null", async (t, env) => {
  const db = await openDb(t, env, (db) => db.createObjectStore("s"));
  assert_equals(await req(db.transaction("s").objectStore("s").openCursor()), null);
  assert_equals(await req(db.transaction("s").objectStore("s").openKeyCursor(null, "prev")), null);
});

// Larger data: a few thousand records through every path.

promise_test("bulk: 3000 records, an index, ranges and a cursor walk agree", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    const s = db.createObjectStore("s", { keyPath: "id" });
    s.createIndex("g", "g");
  });
  const tx = db.transaction("s", "readwrite");
  const s = tx.objectStore("s");
  for (let i = 0; i < 3000; i++) s.put({ id: (i * 7919) % 3000, g: i % 7, title: `row ${i}` });
  await done(tx);
  const r = db.transaction("s").objectStore("s");
  assert_equals(await req(r.count()), 3000);
  assert_equals(await req(r.index("g").count(3)), 429);
  const keys = await req<number[]>(r.getAllKeys(env.KeyRange.bound(100, 200, false, true)));
  assert_same(keys, Array.from({ length: 100 }, (_, i) => 100 + i));
  let n = 0;
  let prev = -1;
  await walk(r.index("g").openKeyCursor(2), (c) => {
    n++;
    assert_true((c.primaryKey as number) > prev, "primary keys ascend within one index key");
    prev = c.primaryKey as number;
  });
  assert_equals(n, 429);
});

promise_test("cursor: long walks in both directions over an index, mixing continue and advance", async (t, env) => {
  const db = await openDb(t, env, (db) => {
    const s = db.createObjectStore("s");
    s.createIndex("g", "g");
    for (let i = 0; i < 300; i++) s.put({ g: i % 3, n: i }, i);
  });
  const idx = db.transaction("s").objectStore("s").index("g");
  const back = await walk(idx.openCursor(1, "prev"), (c) => (c.value as { n: number }).n);
  assert_same(back, Array.from({ length: 100 }, (_, i) => 298 - 3 * i));
  let k = 0;
  const mixed = await walk(
    idx.openCursor(2),
    (c) => c.primaryKey,
    (c) => (k++ % 2 ? c.advance(5) : c.continue()),
  );
  const want: number[] = [];
  for (let i = 0, j = 0; i < 100; j++) {
    want.push(2 + 3 * i);
    i += j % 2 ? 5 : 1;
  }
  assert_same(mixed, want);
});

// plateau's additions: declared typed columns ("hybrid values") and store.query. These run only
// against plateau; native IndexedDB has neither.

async function typed(t: Parameters<Parameters<typeof promise_test>[1]>[0], env: Parameters<Parameters<typeof promise_test>[1]>[1]) {
  return openDb(t, env, (db) => {
    const s = db.createObjectStore("issues", {
      keyPath: "id",
      columns: {
        id: "f64",
        team: { kind: "u32", index: "bitmap" },
        labels: { kind: "u32_multi", index: "bitmap" },
        updated: { kind: "f64", index: "ordered", group: "team" },
        title: "str",
      },
    } as IDBObjectStoreParameters);
    s.createIndex("by_title", "title");
    for (let i = 1; i <= 30; i++) s.put({ id: i, team: i % 3, labels: [i % 5], updated: 1000 - i, title: `t${i % 10}`, extra: { n: i, when: new Date(i) } });
  });
}

plateau_test("typed store: declared fields and the rest of the value round-trip", async (t, env) => {
  const db = await typed(t, env);
  const v = await req<Record<string, unknown>>(db.transaction("issues").objectStore("issues").get(7));
  assert_same(v, { id: 7, team: 1, labels: [2], updated: 993, title: "t7", extra: { n: 7, when: new Date(7) } });
});

plateau_test("typed store: a declared field of the wrong type throws DataError", async (t, env) => {
  const db = await typed(t, env);
  const s = db.transaction("issues", "readwrite").objectStore("issues");
  assert_throws_dom("DataError", () => s.put({ id: 1, team: -1, labels: [], updated: 1, title: "x" }));
  assert_throws_dom("DataError", () => s.put({ id: 1, team: 1, labels: [1.5], updated: 1, title: "x" }));
  assert_throws_dom("DataError", () => s.put({ id: "1", team: 1, labels: [], updated: 1, title: "x" }));
  assert_throws_dom("DataError", () => s.put({ id: 1, team: 1, labels: [], updated: 1 }));
  assert_throws_dom("DataError", () => s.put(new Map()));
});

plateau_test("typed store: query with where, orderBy and limit, and count", async (t, env) => {
  const db = await typed(t, env);
  const s = db.transaction("issues").objectStore("issues") as unknown as { query(q: unknown): IDBRequest & { plan?: string } };
  const r = s.query({ where: [{ field: "team", op: "eq", value: 2 }], orderBy: { field: "updated", desc: true }, limit: 3 });
  const rows = await req<{ id: number }[]>(r);
  assert_same(rows.map((x) => x.id), [2, 5, 8]);
  assert_true(typeof r.plan === "string" && r.plan.length > 0, "plan reported");
  assert_equals(await req(s.query({ where: [{ field: "labels", op: "eq", value: 0 }], count: true })), 6);
});

plateau_test("typed store: writes, an IndexedDB index and a cursor agree with query after an abort", async (t, env) => {
  const db = await typed(t, env);
  let tx = db.transaction("issues", "readwrite");
  let s = tx.objectStore("issues");
  s.put({ id: 31, team: 0, labels: [], updated: 5, title: "t1" });
  s.delete(2);
  await done(tx);
  tx = db.transaction("issues", "readwrite");
  s = tx.objectStore("issues");
  s.put({ id: 32, team: 0, labels: [], updated: 6, title: "t1" });
  s.delete(3);
  tx.abort();
  await aborted(tx);
  const r = db.transaction("issues").objectStore("issues");
  assert_equals(await req(r.count()), 30);
  assert_same(await req(r.index("by_title").getAllKeys("t1")), [1, 11, 21, 31]);
  assert_equals(await req((r as unknown as { query(q: unknown): IDBRequest }).query({ where: [{ field: "team", op: "eq", value: 0 }], count: true })), 11);
  const keys: unknown[] = [];
  await new Promise<void>((resolve) => {
    const c = r.openKeyCursor(env.KeyRange.bound(1, 4));
    c.onsuccess = () => {
      if (!c.result) return resolve();
      keys.push(c.result.key);
      c.result.continue();
    };
  });
  assert_same(keys, [1, 3, 4]);
});

plateau_test("typed store: data persists across close and reopen", async (t, env) => {
  const db = await typed(t, env);
  db.close();
  const db2 = await req<IDBDatabase>(env.factory.open(db.name));
  t.add_cleanup(() => db2.close());
  const s = db2.transaction("issues").objectStore("issues");
  assert_equals(await req(s.count()), 30);
  assert_same(await req(s.index("by_title").getAllKeys("t3")), [3, 13, 23]);
});

// plateau's memory budget and compaction.

type PlateauExtras = {
  setMemoryBudget(bytes: number | null): Promise<void>;
  memoryStats(name?: string): Promise<{ wasmMemoryBytes: number; budgetBytes: number; cachedBytes: number; fileBytes?: number; usedBytes?: number }>;
};

plateau_test("compact: drops deleted and replaced rows, keeps every answer, and of two compactions one cuts the files to what they use", async (t, env) => {
  const db = await typed(t, env);
  const factory = env.factory as unknown as PlateauExtras;
  for (let round = 0; round < 3; round++) {
    const tx = db.transaction("issues", "readwrite");
    const s = tx.objectStore("issues");
    for (let i = 1; i <= 30; i++) if ((i + round) % 4 === 0) s.put({ id: i, team: (i + round) % 3, labels: [i % 5], updated: 2000 + i, title: `u${i % 10}` });
    for (let i = 40 + round * 100; i < 140 + round * 100; i++) s.put({ id: i, team: i % 3, labels: [], updated: i, title: `n${i % 10}` });
    for (let i = 40 + round * 100; i < 120 + round * 100; i++) s.delete(i);
    await done(tx);
  }
  const read = async () => {
    const s = db.transaction("issues").objectStore("issues");
    const q = (s as unknown as { query(q: unknown): IDBRequest }).query({ where: [{ field: "team", op: "eq", value: 1 }], orderBy: { field: "updated", desc: true }, limit: 7 });
    return JSON.stringify(await Promise.all([req(s.getAll()), req(s.index("by_title").getAllKeys()), req(q)]));
  };
  const before = await read();
  const used = (await factory.memoryStats(db.name)).usedBytes!;
  // Compaction waits for the connection's running transaction.
  const tx = db.transaction("issues", "readwrite");
  tx.objectStore("issues").put({ id: 7, team: 2, labels: [2], updated: 2007, title: "u7" });
  const compacted = (db as unknown as { compact(): Promise<void> }).compact();
  await done(tx);
  await compacted;
  assert_equals(await read(), before);
  const first = await factory.memoryStats(db.name);
  assert_true(first.usedBytes! <= used, `used ${used} -> ${first.usedBytes}`);
  // A compaction goes into the space the old state frees once it fits there, after it otherwise;
  // either way the file is cut after the new state. Of two in a row, one fits.
  await (db as unknown as { compact(): Promise<void> }).compact();
  const second = await factory.memoryStats(db.name);
  // The same rows; the manifest may list the segment in a different number of extents.
  assert_true(Math.abs(second.usedBytes! - first.usedBytes!) <= 1024, `used ${first.usedBytes} then ${second.usedBytes}`);
  const least = Math.min(first.fileBytes!, second.fileBytes!);
  assert_true(least <= second.usedBytes! * 1.15, `files ${first.fileBytes} and ${second.fileBytes}, used ${second.usedBytes}`);
  assert_equals(await read(), before);
  db.close();
  const db2 = await req<IDBDatabase>(env.factory.open(db.name));
  t.add_cleanup(() => db2.close());
  assert_equals(await req(db2.transaction("issues").objectStore("issues").count()), 30 + 3 * 20);
});

plateau_test("memory budget: a tiny budget drops loaded sections and every answer stays the same", async (t, env) => {
  const factory = env.factory as unknown as PlateauExtras;
  const db = await typed(t, env);
  const read = async () => {
    const s = db.transaction("issues").objectStore("issues");
    const q = (s as unknown as { query(q: unknown): IDBRequest }).query({ where: [{ field: "labels", op: "eq", value: 2 }], orderBy: { field: "updated" } });
    const rest = Promise.all([req(s.getAll()), req(s.get(17)), req(q)]);
    const keys: unknown[] = [];
    await new Promise<void>((resolve) => {
      const c = s.index("by_title").openCursor(null, "prev");
      c.onsuccess = () => {
        if (!c.result) return resolve();
        keys.push(c.result.primaryKey);
        c.result.continue();
      };
    });
    return JSON.stringify([...(await rest), keys]);
  };
  const want = await read();
  const stats = await factory.memoryStats();
  assert_true(stats.wasmMemoryBytes > 0 && stats.budgetBytes > 0 && stats.cachedBytes > 0, JSON.stringify(stats));
  t.add_cleanup(() => factory.setMemoryBudget(stats.budgetBytes));
  await factory.setMemoryBudget(1);
  for (let i = 0; i < 3; i++) assert_equals(await read(), want);
  assert_true((await factory.memoryStats()).cachedBytes < stats.cachedBytes, "loaded sections dropped");
  await factory.setMemoryBudget(null);
  assert_equals((await factory.memoryStats()).budgetBytes, Infinity);
  assert_equals(await read(), want);
});
