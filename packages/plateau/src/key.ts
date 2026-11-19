// IndexedDB keys, key paths and key ranges.
//
// A valid key is a number (not NaN), a Date with a valid time, a string, a binary key (an
// ArrayBuffer or a view of one) or an array of valid keys. Keys order as number < Date < string <
// binary < array; numbers and dates by value, strings by UTF-16 code unit, binary keys by byte,
// arrays element by element with a shorter prefix first.
//
// Internally every key is held as its sortable encoding: a JS string whose code-unit order is the
// IndexedDB key order, so sorted arrays, binary search and `<` work on encoded keys directly.
//
//   number  0x10, then the 64-bit order key of the double (sign bit flipped for positives, every
//           bit flipped for negatives, -0 as 0) as four 16-bit code units
//   date    0x20, then the same for the time value
//   string  0x30, each code unit c as c when c >= 2 and as (1, c + 1) when c < 2, then 0
//   binary  0x40, each byte b as b + 2, then 0
//   array   0x50, each element's encoding, then 0
//
// Every encoding is self-delimiting, so no encoding is a proper prefix of another: two encodings
// concatenated (an index key, then a primary key) sort by the first and then by the second, and an
// entry starts with an encoded key k exactly when its first key equals k.
//
// -0 and 0 are one key, so they share one encoding. The spelling of a key holding -0 is kept
// apart: `spelledKey` gives the raw encoding, the same except that each -0 keeps its own order key
// (every bit of -0's flipped, just below 0's), which `decodeKey` turns back into -0. The raw
// encoding is only ever decoded, never compared.

export type Key = number | string | Date | ArrayBuffer | Key[];

const NUMBER = 0x10;
const DATE = 0x20;
const STRING = 0x30;
const BINARY = 0x40;
const ARRAY = 0x50;

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const HI = LITTLE ? 1 : 0;
const LO = LITTLE ? 0 : 1;

function encodeNumber(tag: number, n: number, raw = false): string {
  f64[0] = n === 0 && !raw ? 0 : n;
  let hi = u32[HI];
  let lo = u32[LO];
  if (hi >>> 31) {
    hi = ~hi >>> 0;
    lo = ~lo >>> 0;
  } else {
    hi = (hi | 0x80000000) >>> 0;
  }
  return String.fromCharCode(tag, hi >>> 16, hi & 0xffff, lo >>> 16, lo & 0xffff);
}

function decodeNumber(s: string, at: number): number {
  let hi = ((s.charCodeAt(at) << 16) | s.charCodeAt(at + 1)) >>> 0;
  let lo = ((s.charCodeAt(at + 2) << 16) | s.charCodeAt(at + 3)) >>> 0;
  if (hi >>> 31) {
    hi = (hi & 0x7fffffff) >>> 0;
  } else {
    hi = ~hi >>> 0;
    lo = ~lo >>> 0;
  }
  u32[HI] = hi;
  u32[LO] = lo;
  return f64[0];
}

function isBinary(v: unknown): v is ArrayBuffer | ArrayBufferView {
  return v instanceof ArrayBuffer || ArrayBuffer.isView(v) || Object.prototype.toString.call(v) === "[object ArrayBuffer]";
}

function bytesOf(v: ArrayBuffer | ArrayBufferView): Uint8Array {
  return ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(v);
}

function isDate(v: unknown): v is Date {
  return v instanceof Date || Object.prototype.toString.call(v) === "[object Date]";
}

/** The sortable encoding of `v` if it is a valid key, else `undefined`. */
export function encodeKey(v: unknown): string | undefined {
  return enc(v, null, false);
}

/** The raw encoding of a valid key that holds -0 (as a number or inside an array), else
 * `undefined`: the key is spelled as its encoding says. */
export function spelledKey(v: unknown): string | undefined {
  return holdsNegZero(v, []) ? enc(v, null, true) : undefined;
}

function holdsNegZero(v: unknown, seen: unknown[]): boolean {
  if (typeof v === "number") return Object.is(v, -0);
  if (!Array.isArray(v) || seen.includes(v)) return false;
  seen.push(v);
  for (let i = 0; i < v.length; i++) if (holdsNegZero(v[i], seen)) return true;
  seen.pop();
  return false;
}

function enc(v: unknown, seen: unknown[] | null, raw: boolean): string | undefined {
  switch (typeof v) {
    case "number":
      return Number.isNaN(v) ? undefined : encodeNumber(NUMBER, v, raw);
    case "string": {
      let out = String.fromCharCode(STRING);
      let from = 0;
      for (let i = 0; i < v.length; i++) {
        const c = v.charCodeAt(i);
        if (c < 2) {
          out += v.slice(from, i) + String.fromCharCode(1, c + 1);
          from = i + 1;
        }
      }
      return out + v.slice(from) + "\u0000";
    }
    case "object": {
      if (v === null) return undefined;
      if (isDate(v)) {
        const t = (v as Date).getTime();
        return Number.isNaN(t) ? undefined : encodeNumber(DATE, t);
      }
      if (isBinary(v)) {
        const b = bytesOf(v);
        const units = new Array<number>(b.length);
        for (let i = 0; i < b.length; i++) units[i] = b[i] + 2;
        let out = String.fromCharCode(BINARY);
        for (let i = 0; i < units.length; i += 8192) out += String.fromCharCode(...units.slice(i, i + 8192));
        return out + "\u0000";
      }
      if (Array.isArray(v)) {
        const stack = seen ?? [];
        if (stack.includes(v)) return undefined;
        stack.push(v);
        let out = String.fromCharCode(ARRAY);
        for (let i = 0; i < v.length; i++) {
          if (!Object.prototype.hasOwnProperty.call(v, i)) return undefined;
          const e = enc(v[i], stack, raw);
          if (e === undefined) return undefined;
          out += e;
        }
        stack.pop();
        return out + "\u0000";
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Where the key encoded at `at` ends. */
export function skipKey(s: string, at: number): number {
  const tag = s.charCodeAt(at);
  switch (tag) {
    case NUMBER:
    case DATE:
      return at + 5;
    case STRING:
    case BINARY: {
      let i = at + 1;
      for (;;) {
        const c = s.charCodeAt(i);
        if (c === 0) return i + 1;
        i += tag === STRING && c === 1 ? 2 : 1;
      }
    }
    case ARRAY: {
      let i = at + 1;
      while (s.charCodeAt(i) !== 0) i = skipKey(s, i);
      return i + 1;
    }
    default:
      throw new Error(`plateau: corrupt key encoding (tag ${tag})`);
  }
}

/** The key (as IndexedDB hands keys out: numbers, Dates, strings, ArrayBuffers, arrays) encoded
 * at `at`, and where its encoding ends. */
export function decodeKeyAt(s: string, at: number): [Key, number] {
  const tag = s.charCodeAt(at);
  switch (tag) {
    case NUMBER:
      return [decodeNumber(s, at + 1), at + 5];
    case DATE:
      return [new Date(decodeNumber(s, at + 1)), at + 5];
    case STRING: {
      let out = "";
      let i = at + 1;
      let from = i;
      for (;;) {
        const c = s.charCodeAt(i);
        if (c === 0) return [out + s.slice(from, i), i + 1];
        if (c === 1) {
          out += s.slice(from, i) + String.fromCharCode(s.charCodeAt(i + 1) - 1);
          i += 2;
          from = i;
        } else i++;
      }
    }
    case BINARY: {
      const end = s.indexOf("\u0000", at + 1);
      const b = new Uint8Array(end - at - 1);
      for (let i = 0; i < b.length; i++) b[i] = s.charCodeAt(at + 1 + i) - 2;
      return [b.buffer, end + 1];
    }
    case ARRAY: {
      const out: Key[] = [];
      let i = at + 1;
      while (s.charCodeAt(i) !== 0) {
        const [k, next] = decodeKeyAt(s, i);
        out.push(k);
        i = next;
      }
      return [out, i + 1];
    }
    default:
      throw new Error(`plateau: corrupt key encoding (tag ${tag})`);
  }
}

export function decodeKey(s: string): Key {
  return decodeKeyAt(s, 0)[0];
}

/** The number an encoded number key holds, or `undefined` for another key type. */
export function encodedNumber(s: string): number | undefined {
  return s.charCodeAt(0) === NUMBER && s.length === 5 ? decodeNumber(s, 1) : undefined;
}

export function encodeNumberKey(n: number): string {
  return encodeNumber(NUMBER, n);
}

export function dataError(message: string): DOMException {
  return new DOMException(message, "DataError");
}

/** The encoding of `v`, or a DataError. */
export function requireKey(v: unknown, what = "The parameter"): string {
  const e = encodeKey(v);
  if (e === undefined) throw dataError(`${what} is not a valid key.`);
  return e;
}

/** `indexedDB.cmp`: -1, 0 or 1. */
export function cmp(a: unknown, b: unknown): number {
  const x = requireKey(a, "The first parameter");
  const y = requireKey(b, "The second parameter");
  return x < y ? -1 : x > y ? 1 : 0;
}

// Key paths.

export type KeyPath = string | string[];

const IDENT = /^[$_\p{ID_Start}][$‌‍\p{ID_Continue}]*$/u;

function validPathString(p: string): boolean {
  return p === "" || p.split(".").every((part) => IDENT.test(part));
}

export function validKeyPath(p: unknown): p is KeyPath {
  if (typeof p === "string") return validPathString(p);
  if (Array.isArray(p)) return p.length > 0 && p.every((x) => typeof x === "string" && validPathString(x));
  return false;
}

/** A key path given as any sequence (an array or a DOMStringList-like) or any value converted to a
 * string, as WebIDL does for `(DOMString or sequence<DOMString>)`. */
export function normalizeKeyPath(p: unknown): unknown {
  if (p === null || p === undefined) return p;
  if (Array.isArray(p)) return p.map((x) => String(x));
  if (typeof p === "object" && typeof (p as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function") {
    return Array.from(p as Iterable<unknown>, (x) => String(x));
  }
  return String(p);
}

const FAIL = Symbol("no value at key path");

function evalPath(value: unknown, path: string): unknown {
  if (path === "") return value;
  let v = value;
  for (const id of path.split(".")) {
    if (typeof v === "string" && id === "length") {
      v = v.length;
      continue;
    }
    if (v === null || typeof v !== "object") return FAIL;
    if (Array.isArray(v) && id === "length") {
      v = v.length;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(v, id)) return FAIL;
    v = (v as Record<string, unknown>)[id];
  }
  return v;
}

/** What evaluating a key path on a value gives: `{ key }` (the encoding of a valid key, and `sk`, its
 * raw encoding, when it holds -0), `"invalid"` (a value that is not a key) or `"missing"` (no value
 * at the path). An array key path gives an array key, or `"invalid"` if any part is missing or
 * invalid. */
export function extractKey(value: unknown, path: KeyPath): { key: string; sk?: string } | "invalid" | "missing" {
  let v: unknown;
  if (Array.isArray(path)) {
    const parts: unknown[] = [];
    for (const p of path) {
      const x = evalPath(value, p);
      if (x === FAIL) return "invalid";
      parts.push(x);
    }
    v = parts;
  } else {
    v = evalPath(value, path);
    if (v === FAIL) return "missing";
  }
  const key = encodeKey(v);
  if (key === undefined) return "invalid";
  const sk = spelledKey(v);
  return sk === undefined ? { key } : { key, sk };
}

/** An index key of a record: its encoding, and its raw encoding when it holds -0. */
export interface SpelledKey {
  k: string;
  sk?: string;
}

/** The keys an index with this key path holds for a record: none, one, or (multiEntry over an
 * array value) each distinct valid element, spelled as its first occurrence. */
export function indexKeys(value: unknown, path: KeyPath, multiEntry: boolean): SpelledKey[] {
  const one = (x: unknown): SpelledKey | undefined => {
    const k = encodeKey(x);
    if (k === undefined) return undefined;
    const sk = spelledKey(x);
    return sk === undefined ? { k } : { k, sk };
  };
  if (multiEntry && typeof path === "string") {
    const v = evalPath(value, path);
    if (v === FAIL) return [];
    if (Array.isArray(v)) {
      const out = new Map<string, SpelledKey>();
      for (let i = 0; i < v.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(v, i)) continue;
        const e = one(v[i]);
        if (e !== undefined && !out.has(e.k)) out.set(e.k, e);
      }
      return [...out.values()];
    }
    const e = one(v);
    return e === undefined ? [] : [e];
  }
  const r = extractKey(value, path);
  return typeof r === "object" ? [r.sk === undefined ? { k: r.key } : { k: r.key, sk: r.sk }] : [];
}

/** Whether a generated key could be put at `path` in `value` (every step before the last is an
 * object or absent). */
export function canInjectKey(value: unknown, path: string): boolean {
  const ids = path.split(".");
  let v = value;
  for (let i = 0; i < ids.length - 1; i++) {
    if (v === null || typeof v !== "object") return false;
    if (!Object.prototype.hasOwnProperty.call(v, ids[i])) return true;
    v = (v as Record<string, unknown>)[ids[i]];
  }
  return v !== null && typeof v === "object";
}

/** Puts `key` at `path` in `value`, creating the objects on the way. */
export function injectKey(value: unknown, path: string, key: Key): void {
  const ids = path.split(".");
  let v = value as Record<string, unknown>;
  for (let i = 0; i < ids.length - 1; i++) {
    if (!Object.prototype.hasOwnProperty.call(v, ids[i])) v[ids[i]] = {};
    v = v[ids[i]] as Record<string, unknown>;
  }
  v[ids[ids.length - 1]] = key;
}

// Key ranges.

/** A key range as the worker takes it: encoded bounds, `undefined` for unbounded. */
export interface WireRange {
  lo?: string;
  hi?: string;
  loOpen: boolean;
  hiOpen: boolean;
}

let nativeRanges = false;

/** @internal From now on `PlateauKeyRange`'s factories return the browser's `IDBKeyRange`: the page
 * runs on the browser's IndexedDB, which takes no other range. */
export function useNativeKeyRanges(): void {
  nativeRanges = typeof IDBKeyRange !== "undefined";
}

/** On the IndexedDB fallback, the factories return the browser's own `IDBKeyRange`. */
export class PlateauKeyRange {
  /** @internal */ readonly lo: string | undefined;
  /** @internal */ readonly hi: string | undefined;
  readonly lowerOpen: boolean;
  readonly upperOpen: boolean;
  /** The raw encodings of bounds that hold -0, kept only to hand them back. */
  readonly #slo: string | undefined;
  readonly #shi: string | undefined;

  private constructor(lo: string | undefined, hi: string | undefined, lowerOpen: boolean, upperOpen: boolean, lower?: unknown, upper?: unknown) {
    this.lo = lo;
    this.hi = hi;
    this.lowerOpen = lowerOpen;
    this.upperOpen = upperOpen;
    this.#slo = lo === undefined ? undefined : spelledKey(lower);
    this.#shi = hi === undefined ? undefined : spelledKey(upper);
  }

  get lower(): Key | undefined {
    return this.lo === undefined ? undefined : decodeKey(this.#slo ?? this.lo);
  }

  get upper(): Key | undefined {
    return this.hi === undefined ? undefined : decodeKey(this.#shi ?? this.hi);
  }

  static only(value: unknown): PlateauKeyRange {
    if (nativeRanges) return IDBKeyRange.only(value) as unknown as PlateauKeyRange;
    const k = requireKey(value);
    return new PlateauKeyRange(k, k, false, false, value, value);
  }

  static lowerBound(lower: unknown, open = false): PlateauKeyRange {
    if (nativeRanges) return IDBKeyRange.lowerBound(lower, open) as unknown as PlateauKeyRange;
    return new PlateauKeyRange(requireKey(lower), undefined, !!open, true, lower);
  }

  static upperBound(upper: unknown, open = false): PlateauKeyRange {
    if (nativeRanges) return IDBKeyRange.upperBound(upper, open) as unknown as PlateauKeyRange;
    return new PlateauKeyRange(undefined, requireKey(upper), true, !!open, undefined, upper);
  }

  static bound(lower: unknown, upper: unknown, lowerOpen = false, upperOpen = false): PlateauKeyRange {
    if (nativeRanges) return IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen) as unknown as PlateauKeyRange;
    const lo = requireKey(lower);
    const hi = requireKey(upper);
    if (lo > hi || (lo === hi && (lowerOpen || upperOpen))) throw dataError("The lower key is greater than the upper key.");
    return new PlateauKeyRange(lo, hi, !!lowerOpen, !!upperOpen, lower, upper);
  }

  includes(key: unknown): boolean {
    return inRange(this.wire(), requireKey(key));
  }

  /** @internal */
  wire(): WireRange {
    return { lo: this.lo, hi: this.hi, loOpen: this.lowerOpen, hiOpen: this.upperOpen };
  }
}

export function inRange(r: WireRange, k: string): boolean {
  if (r.lo !== undefined && (r.loOpen ? k <= r.lo : k < r.lo)) return false;
  if (r.hi !== undefined && (r.hiOpen ? k >= r.hi : k > r.hi)) return false;
  return true;
}

/** Converts a query argument (a key, a key range or, where allowed, nothing) to a wire range.
 * Accepts native `IDBKeyRange` objects too. */
export function toRange(q: unknown, nullOk: boolean): WireRange | null {
  if (q === undefined || q === null) {
    if (nullOk) return null;
    throw dataError("No key or key range specified.");
  }
  if (q instanceof PlateauKeyRange) return q.wire();
  if (typeof IDBKeyRange !== "undefined" && q instanceof IDBKeyRange) {
    return {
      lo: q.lower === undefined ? undefined : requireKey(q.lower),
      hi: q.upper === undefined ? undefined : requireKey(q.upper),
      loOpen: q.lowerOpen,
      hiOpen: q.upperOpen,
    };
  }
  const k = requireKey(q);
  return { lo: k, hi: k, loOpen: false, hiOpen: false };
}
