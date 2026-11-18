import { describe, expect, test } from "bun:test";
import { cloneValue, decodeValue, encodeValue } from "../src/value";

describe("value encoding", () => {
  test("plain JSON data is stored as is", () => {
    const v = { id: 1, title: "x", labels: [1, 2], nested: { ok: true, none: null }, s: "\ud800 lone" };
    const e = encodeValue(v);
    expect(e[0]).toBe("J");
    expect(decodeValue(e)).toEqual(v);
  });

  test("every supported type round-trips", () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [1, , 3];
    const v = {
      u: undefined,
      nan: NaN,
      inf: [Infinity, -Infinity],
      negZero: -0,
      big: 12345678901234567890n,
      date: new Date(1700000000000),
      badDate: new Date(NaN),
      re: /a+b/gi,
      wrapped: [new Boolean(false), new Number(-0), new String("s")],
      buf: new Uint8Array([0, 1, 255]).buffer,
      view: new Uint16Array([1, 65535]),
      f64: new Float64Array([1.5, NaN]),
      dv: new DataView(new Uint8Array([9, 8, 7]).buffer, 1, 2),
      sparse,
      map: new Map<unknown, unknown>([[1, "a"], [{ k: 1 }, [2]]]),
      set: new Set([1, "1", undefined]),
      $dollar: { $u: 1, $$x: 2 },
      str: "ok",
    };
    const e = encodeValue(v);
    expect(e[0]).toBe("T");
    const back = decodeValue(e) as typeof v;
    expect(back.u).toBeUndefined();
    expect("u" in back).toBe(true);
    expect(back.nan).toBeNaN();
    expect(back.inf).toEqual([Infinity, -Infinity]);
    expect(Object.is(back.negZero, -0)).toBe(true);
    expect(back.big).toBe(v.big);
    expect(back.date).toEqual(v.date);
    expect(back.badDate.getTime()).toBeNaN();
    expect(back.re.source).toBe("a+b");
    expect(back.re.flags).toBe("gi");
    expect(back.wrapped[0]).toBeInstanceOf(Boolean);
    expect(Object.is(back.wrapped[1].valueOf(), -0)).toBe(true);
    expect(back.wrapped[2].valueOf()).toBe("s");
    expect(new Uint8Array(back.buf)).toEqual(new Uint8Array([0, 1, 255]));
    expect(back.view).toBeInstanceOf(Uint16Array);
    expect([...back.view]).toEqual([1, 65535]);
    expect(back.f64[1]).toBeNaN();
    expect(back.dv).toBeInstanceOf(DataView);
    expect(back.dv.getUint8(0)).toBe(8);
    expect(back.sparse.length).toBe(3);
    expect(1 in back.sparse).toBe(false);
    expect(back.map.get(1)).toBe("a");
    expect([...back.map.keys()][1]).toEqual({ k: 1 });
    expect([...back.set]).toEqual([1, "1", undefined]);
    expect(back.$dollar).toEqual({ $u: 1, $$x: 2 });
    expect(back.str).toBe("ok");
  });

  test("shared references and cycles keep their shape", () => {
    const shared = { n: 1 };
    const v: Record<string, unknown> = { a: shared, b: [shared, shared], d: new Date(0) };
    v.self = v;
    v.d2 = v.d;
    const m = new Map<string, unknown>();
    m.set("m", m);
    v.m = m;
    const back = cloneValue(v) as Record<string, any>;
    expect(back.a).toBe(back.b[0]);
    expect(back.b[1]).toBe(back.a);
    expect(back.self).toBe(back);
    expect(back.d2).toBe(back.d);
    expect(back.m.get("m")).toBe(back.m);
  });

  test("the copy is taken at the call", () => {
    const v = { a: [1] };
    const e = encodeValue(v);
    v.a.push(2);
    expect(decodeValue(e)).toEqual({ a: [1] });
  });

  test("unsupported types throw DataCloneError", () => {
    for (const bad of [() => 1, Symbol("s"), { f() {} }, [new WeakMap()], new Error("x"), { p: Promise.resolve() }]) {
      let err: unknown;
      try {
        encodeValue(bad);
      } catch (e) {
        err = e;
      }
      expect((err as DOMException)?.name).toBe("DataCloneError");
    }
  });
});
