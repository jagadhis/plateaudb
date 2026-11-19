import { describe, expect, test } from "bun:test";
import { cmp, decodeKey, encodeKey, extractKey, indexKeys, PlateauKeyRange, skipKey, spelledKey, validKeyPath, type Key } from "../src/key";

/** IndexedDB's key comparison, written straight from the spec, for checking the encoding. */
function specCmp(a: Key, b: Key): number {
  const type = (k: Key) => (typeof k === "number" ? 0 : k instanceof Date ? 1 : typeof k === "string" ? 2 : k instanceof ArrayBuffer ? 3 : 4);
  const ta = type(a);
  const tb = type(b);
  if (ta !== tb) return ta < tb ? -1 : 1;
  switch (ta) {
    case 0:
    case 1: {
      const x = Number(a);
      const y = Number(b);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    case 2:
      return a < b ? -1 : a > b ? 1 : 0;
    case 3: {
      const x = new Uint8Array(a as ArrayBuffer);
      const y = new Uint8Array(b as ArrayBuffer);
      for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
      return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
    }
    default: {
      const x = a as Key[];
      const y = b as Key[];
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const c = specCmp(x[i], y[i]);
        if (c) return c;
      }
      return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
    }
  }
}

const bin = (...b: number[]) => new Uint8Array(b).buffer;

/** Keys in ascending IndexedDB order, no two equal. */
const ORDERED: Key[] = [
  -Infinity,
  -1e300,
  -1,
  -Number.MIN_VALUE,
  0,
  Number.MIN_VALUE,
  1,
  1.5,
  2 ** 53,
  1e300,
  Infinity,
  new Date(-8.64e15),
  new Date(-1),
  new Date(0),
  new Date(1),
  new Date(8.64e15),
  "",
  "\u0000",
  "\u0000\u0000",
  "\u0001",
  "\u0001a",
  "\u0002",
  "A",
  "a",
  "a\u0000",
  "a\u0000b",
  "a\u0001",
  "aa",
  "b",
  "\ud800",
  "𐀀",
  "￿",
  bin(),
  bin(0),
  bin(0, 0),
  bin(0, 1),
  bin(1),
  bin(255),
  bin(255, 255),
  [],
  [-Infinity],
  [0],
  [0, 0],
  [0, ""],
  [0, []],
  [1],
  [new Date(0)],
  [""],
  ["", 0],
  ["a"],
  [bin(0)],
  [[]],
  [[], []],
  [[0]],
  [[[]]],
];

function rnd(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomKey(r: () => number, depth = 0): Key {
  const pick = Math.floor(r() * (depth > 2 ? 4 : 5));
  switch (pick) {
    case 0:
      return [0, -0, 1, -1, 0.5, -2.5, 1e10, -1e-10, Infinity, -Infinity][Math.floor(r() * 10)] * (r() < 0.5 ? 1 : 1 + Math.floor(r() * 5));
    case 1:
      return new Date(Math.floor((r() - 0.5) * 1e13));
    case 2: {
      let s = "";
      const n = Math.floor(r() * 4);
      for (let i = 0; i < n; i++) s += String.fromCharCode([0, 1, 2, 65, 97, 0xd800, 0xdc00, 0xffff][Math.floor(r() * 8)]);
      return s;
    }
    case 3: {
      const n = Math.floor(r() * 4);
      return bin(...Array.from({ length: n }, () => [0, 1, 2, 254, 255][Math.floor(r() * 5)]));
    }
    default:
      return Array.from({ length: Math.floor(r() * 4) }, () => randomKey(r, depth + 1));
  }
}

describe("key encoding", () => {
  test("encodings sort in IndexedDB key order", () => {
    const enc = ORDERED.map((k) => encodeKey(k)!);
    for (let i = 0; i < enc.length; i++) {
      for (let j = 0; j < enc.length; j++) {
        const want = Math.sign(i - j);
        expect([i, j, enc[i] < enc[j] ? -1 : enc[i] > enc[j] ? 1 : 0]).toEqual([i, j, want]);
        expect(specCmp(ORDERED[i], ORDERED[j])).toBe(want);
      }
    }
  });

  test("random keys: encoded order equals spec order, and keys round-trip", () => {
    const r = rnd(7);
    const keys = Array.from({ length: 600 }, () => randomKey(r));
    const enc = keys.map((k) => encodeKey(k)!);
    for (let i = 0; i < keys.length; i++) {
      expect(specCmp(decodeKey(enc[i]), keys[i])).toBe(0);
      expect(encodeKey(decodeKey(enc[i]))).toBe(enc[i]);
      expect(skipKey(enc[i] + "P", 0)).toBe(enc[i].length);
      for (let j = i + 1; j < Math.min(keys.length, i + 40); j++) {
        const e = enc[i] < enc[j] ? -1 : enc[i] > enc[j] ? 1 : 0;
        expect(e).toBe(specCmp(keys[i], keys[j]));
      }
    }
  });

  test("a concatenated (index key, primary key) pair sorts by the index key, then the primary key", () => {
    const r = rnd(11);
    const pairs = Array.from({ length: 300 }, () => [randomKey(r), randomKey(r)] as const);
    const enc = pairs.map(([a, b]) => encodeKey(a)! + encodeKey(b)!);
    for (let i = 0; i + 1 < pairs.length; i++) {
      const want = specCmp(pairs[i][0], pairs[i + 1][0]) || specCmp(pairs[i][1], pairs[i + 1][1]);
      expect(Math.sign(enc[i] < enc[i + 1] ? -1 : enc[i] > enc[i + 1] ? 1 : 0)).toBe(want);
    }
  });

  test("-0 equals 0, views compare by their bytes, and invalid values are not keys", () => {
    expect(encodeKey(-0)).toBe(encodeKey(0));
    expect(encodeKey(new Uint8Array([1, 2, 3]).subarray(1))).toBe(encodeKey(bin(2, 3)));
    expect(decodeKey(encodeKey(new Int8Array([-1]))!)).toEqual(bin(255));
    for (const bad of [NaN, new Date(NaN), null, undefined, true, {}, [NaN], [1, {}], Symbol("x"), () => 1]) {
      expect(encodeKey(bad)).toBeUndefined();
    }
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(encodeKey(cyclic)).toBeUndefined();
    // eslint-disable-next-line no-sparse-arrays
    expect(encodeKey([1, , 3])).toBeUndefined();
    expect(cmp([1, "a"], [1, "b"])).toBe(-1);
    expect(() => cmp(1, null)).toThrow();
  });
});

describe("key paths and ranges", () => {
  test("key path validity", () => {
    for (const ok of ["", "a", "a.b", "$x._y", "été", ["a"], ["a", "b.c"]]) expect(validKeyPath(ok)).toBe(true);
    for (const bad of ["a.", ".a", "a..b", "1a", "a b", "a-b", [], [""].concat(["x y"]), [["a"]], 3, null]) expect(validKeyPath(bad)).toBe(false);
  });

  test("extracting keys and index keys", () => {
    const v = { a: { b: 3 }, s: "str", arr: [1, 1, "x", {}, 2], d: new Date(5) };
    expect(extractKey(v, "a.b")).toEqual({ key: encodeKey(3)! });
    expect(extractKey(v, "s.length")).toEqual({ key: encodeKey(3)! });
    expect(extractKey(v, "arr.length")).toEqual({ key: encodeKey(5)! });
    expect(extractKey(v, "nope")).toBe("missing");
    expect(extractKey(v, "a")).toBe("invalid");
    expect(extractKey(v, ["a.b", "s"])).toEqual({ key: encodeKey([3, "str"])! });
    expect(extractKey(v, ["a.b", "nope"])).toBe("invalid");
    expect(indexKeys(v, "arr", true).map((e) => e.k).sort()).toEqual([encodeKey(1)!, encodeKey(2)!, encodeKey("x")!].sort());
    expect(indexKeys(v, "arr", false)).toEqual([]);
    expect(indexKeys(v, "d", true)).toEqual([{ k: encodeKey(new Date(5))! }]);
  });

  test("-0 is the key 0, spelled apart", () => {
    expect(encodeKey(-0)).toBe(encodeKey(0)!);
    expect(spelledKey(0)).toBeUndefined();
    expect(spelledKey([1, "a", [0]])).toBeUndefined();
    expect(Object.is(decodeKey(spelledKey(-0)!), -0)).toBe(true);
    const arr = decodeKey(spelledKey([1, [-0, 0], -0])!) as unknown[];
    expect(Object.is((arr[1] as number[])[0], -0) && Object.is((arr[1] as number[])[1], 0) && Object.is(arr[2], -0)).toBe(true);
    // Same length as the encoding, so an index entry splits at the same place.
    expect(spelledKey([-0, "x"])!.length).toBe(encodeKey([0, "x"])!.length);
    expect(skipKey(spelledKey([-0, "x"])!, 0)).toBe(encodeKey([0, "x"])!.length);
    expect(extractKey({ a: -0 }, "a")).toEqual({ key: encodeKey(0)!, sk: spelledKey(-0)! });
    expect(extractKey({ a: 0 }, "a")).toEqual({ key: encodeKey(0)! });
    // multiEntry keeps one entry per key, spelled as its first occurrence.
    expect(indexKeys({ m: [-0, 0, 1] }, "m", true)).toEqual([{ k: encodeKey(0)!, sk: spelledKey(-0)! }, { k: encodeKey(1)! }]);
    expect(indexKeys({ m: [0, -0] }, "m", true)).toEqual([{ k: encodeKey(0)! }]);
    expect(Object.is(PlateauKeyRange.only(-0).lower, -0)).toBe(true);
    expect(Object.is(PlateauKeyRange.bound(-0, 0).upper, 0)).toBe(true);
    expect(PlateauKeyRange.only(-0).includes(0)).toBe(true);
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(spelledKey(cyclic)).toBeUndefined();
  });

  test("ranges", () => {
    expect(PlateauKeyRange.bound(1, 5).includes(5)).toBe(true);
    expect(PlateauKeyRange.bound(1, 5, false, true).includes(5)).toBe(false);
    expect(PlateauKeyRange.lowerBound("a", true).includes("a")).toBe(false);
    expect(PlateauKeyRange.lowerBound("a", true).includes([])).toBe(true);
    expect(PlateauKeyRange.only([1, 2]).lower).toEqual([1, 2]);
    expect(() => PlateauKeyRange.bound(2, 1)).toThrow();
    expect(() => PlateauKeyRange.bound(1, 1, true, false)).toThrow();
  });
});
