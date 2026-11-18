// Values: the structured-clone types plateau stores, as text.
//
// `encodeValue` is the clone IndexedDB takes when a value is stored: it walks the value at the call,
// so later changes to the object do not reach the database, and throws DataCloneError for a type
// it does not store. The text is JSON, which every browser parses natively and fast, and which a
// string column of the engine stores as UTF-8 (JSON.stringify escapes lone surrogates).
//
// Plain JSON data (objects, dense arrays, strings, finite numbers other than -0, booleans, null)
// is written as is behind the prefix "J". Anything else is written behind "T" with tags: an object
// with one key from the list below stands for that type, and an object key the value itself starts
// with "$" gets one more "$" in front, so a tag never collides with data.
//
//   {"$u":0} undefined          {"$n":"NaN"|"Infinity"|"-Infinity"|"-0"} a number JSON lacks
//   {"$bi":"12"} BigInt         {"$d":t} Date (t a number or a tagged NaN)
//   {"$re":[source,flags]}      {"$bo":b} {"$no":n} {"$so":s} Boolean, Number, String objects
//   {"$ab":base64} ArrayBuffer  {"$ta":[type,base64]} typed array or DataView (own copy of its bytes)
//   {"$sa":[length,[[i,v]...]]} sparse array       {"$m":[[k,v]...]} Map    {"$set":[v...]} Set
//   {"$r":n} the n-th object of the value again (shared references and cycles, by first-visit order)
//
// Other platform objects (Blob, File, ImageData, Error, ...), functions and symbols throw
// DataCloneError; native IndexedDB clones some of them, plateau does not store them (yet).

const TAGS = new Set(["$u", "$n", "$bi", "$d", "$re", "$bo", "$no", "$so", "$ab", "$ta", "$sa", "$m", "$set", "$r"]);

const VIEWS: Record<string, new (b: ArrayBuffer) => ArrayBufferView> = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  DataView,
};

export function cloneError(what: string): DOMException {
  return new DOMException(`${what} could not be cloned.`, "DataCloneError");
}

function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return btoa(s);
}

function fromBase64(s: string): ArrayBuffer {
  const bin = atob(s);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b.buffer;
}

function num(n: number): unknown {
  if (Number.isFinite(n) && !Object.is(n, -0)) return n;
  return { $n: Object.is(n, -0) ? "-0" : String(n) };
}

function unnum(v: unknown): number {
  if (typeof v === "number") return v;
  const s = (v as { $n: string }).$n;
  return s === "-0" ? -0 : Number(s);
}

class Encoder {
  tagged = false;
  ids = new Map<object, number>();

  tag(o: Record<string, unknown>): unknown {
    this.tagged = true;
    return o;
  }

  walk(v: unknown): unknown {
    switch (typeof v) {
      case "string":
      case "boolean":
        return v;
      case "number": {
        const out = num(v);
        if (out !== v) this.tagged = true;
        return out;
      }
      case "undefined":
        return this.tag({ $u: 0 });
      case "bigint":
        return this.tag({ $bi: v.toString() });
      case "object":
        break;
      default:
        throw cloneError(typeof v === "function" ? "A function" : `A ${typeof v}`);
    }
    if (v === null) return null;
    const seen = this.ids.get(v);
    if (seen !== undefined) return this.tag({ $r: seen });
    this.ids.set(v, this.ids.size);
    const kind = Object.prototype.toString.call(v).slice(8, -1);
    if (Array.isArray(v)) {
      const n = v.length;
      let dense = true;
      for (let i = 0; i < n; i++) {
        if (!Object.prototype.hasOwnProperty.call(v, i)) {
          dense = false;
          break;
        }
      }
      if (dense) {
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = this.walk(v[i]);
        return out;
      }
      const items: unknown[] = [];
      for (const k of Object.keys(v)) {
        const i = Number(k);
        if (Number.isInteger(i) && i >= 0 && String(i) === k) items.push([i, this.walk(v[i])]);
      }
      return this.tag({ $sa: [n, items] });
    }
    switch (kind) {
      case "Object":
        break;
      case "Date":
        return this.tag({ $d: num((v as Date).getTime()) });
      case "RegExp":
        return this.tag({ $re: [(v as RegExp).source, (v as RegExp).flags] });
      case "Boolean":
        return this.tag({ $bo: (v as unknown as boolean).valueOf() });
      case "Number":
        return this.tag({ $no: num((v as unknown as number).valueOf()) });
      case "String":
        return this.tag({ $so: (v as unknown as string).valueOf() });
      case "ArrayBuffer":
        return this.tag({ $ab: toBase64(new Uint8Array(v as ArrayBuffer)) });
      case "Map": {
        const items: unknown[] = [];
        for (const [k, x] of v as Map<unknown, unknown>) items.push([this.walk(k), this.walk(x)]);
        return this.tag({ $m: items });
      }
      case "Set": {
        const items: unknown[] = [];
        for (const x of v as Set<unknown>) items.push(this.walk(x));
        return this.tag({ $set: items });
      }
      default:
        if (ArrayBuffer.isView(v) && kind in VIEWS) {
          return this.tag({ $ta: [kind, toBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))] });
        }
        throw cloneError(`An object of type ${kind}`);
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) {
      const x = this.walk((v as Record<string, unknown>)[k]);
      if (k.charCodeAt(0) === 36) {
        this.tagged = true;
        out["$" + k] = x;
      } else out[k] = x;
    }
    return out;
  }
}

/** The stored form of `v`. Throws DataCloneError for a type plateau does not store. */
export function encodeValue(v: unknown): string {
  const e = new Encoder();
  const tree = e.walk(v);
  return (e.tagged ? "T" : "J") + JSON.stringify(tree);
}

/** A fresh copy of the value `encodeValue` stored. */
export function decodeValue(s: string): unknown {
  const tree = JSON.parse(s.slice(1));
  return s.charCodeAt(0) === 74 /* J */ ? tree : new Decoder().walk(tree);
}

/** `structuredClone` restricted to the types plateau stores. */
export function cloneValue(v: unknown): unknown {
  return decodeValue(encodeValue(v));
}

class Decoder {
  objects: unknown[] = [];

  walk(t: unknown): unknown {
    if (t === null || typeof t !== "object") return t;
    if (Array.isArray(t)) {
      const out: unknown[] = new Array(t.length);
      this.objects.push(out);
      for (let i = 0; i < t.length; i++) out[i] = this.walk(t[i]);
      return out;
    }
    const keys = Object.keys(t);
    const o = t as Record<string, unknown>;
    if (keys.length === 1 && TAGS.has(keys[0])) {
      const x = o[keys[0]];
      switch (keys[0]) {
        case "$u":
          return undefined;
        case "$n":
          return unnum(t);
        case "$bi":
          return BigInt(x as string);
        case "$r":
          return this.objects[x as number];
      }
      let out: unknown;
      const at = this.objects.length;
      this.objects.push(null);
      switch (keys[0]) {
        case "$d":
          out = new Date(unnum(x));
          break;
        case "$re":
          out = new RegExp((x as string[])[0], (x as string[])[1]);
          break;
        case "$bo":
          out = new Boolean(x as boolean);
          break;
        case "$no":
          out = new Number(unnum(x));
          break;
        case "$so":
          out = new String(x as string);
          break;
        case "$ab":
          out = fromBase64(x as string);
          break;
        case "$ta": {
          const [kind, b64] = x as [string, string];
          out = new VIEWS[kind](fromBase64(b64));
          break;
        }
        case "$sa": {
          const [n, items] = x as [number, [number, unknown][]];
          const arr: unknown[] = new Array(n);
          this.objects[at] = arr;
          for (const [i, v] of items) arr[i] = this.walk(v);
          return arr;
        }
        case "$m": {
          const m = new Map();
          this.objects[at] = m;
          for (const [k, v] of x as [unknown, unknown][]) {
            const kk = this.walk(k);
            m.set(kk, this.walk(v));
          }
          return m;
        }
        case "$set": {
          const s = new Set();
          this.objects[at] = s;
          for (const v of x as unknown[]) s.add(this.walk(v));
          return s;
        }
      }
      this.objects[at] = out;
      return out;
    }
    const out: Record<string, unknown> = {};
    this.objects.push(out);
    for (const k of keys) {
      const v = this.walk(o[k]);
      if (k.charCodeAt(0) === 36) out[k.slice(1)] = v;
      else out[k] = v;
    }
    return out;
  }
}
