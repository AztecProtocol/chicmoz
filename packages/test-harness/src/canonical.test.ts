import { Long } from "bson";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canonical, canonicalParse } from "./canonical.js";

describe("canonical", () => {
  it("tags every value JSON cannot hold and keeps a present undefined key apart from an absent one", () => {
    const value = {
      z: 1n,
      a: undefined,
      d: new Date("2026-01-01T00:00:00.000Z"),
      b: Buffer.from([0xab]),
      u: new Uint8Array([1]),
      l: Long.fromString("9007199254740993"),
      n: [Infinity, NaN, -0, null],
      record: { _bsontype: "Long", __isLong__: true, low: 1 },
      createdAt: "2026-11-19T00:00:00Z",
      ...(JSON.parse('{"__proto__": 1}') as object),
    };

    expect(
      JSON.stringify(canonical(value, { dbTimeKeys: ["createdAt"] })),
    ).toBe(
      '{"__proto__":1,"a":{"$undefined":true},"b":{"$hex":"ab"},' +
        '"createdAt":{"$dbtime":"string"},"d":{"$date":"2026-01-01T00:00:00.000Z"},' +
        '"l":{"$long":"9007199254740993"},' +
        '"n":[{"$number":"Infinity"},{"$number":"NaN"},{"$number":"-0"},null],' +
        '"record":{"__isLong__":true,"_bsontype":"Long","low":1},' +
        '"u":{"$hex":"01"},"z":{"$bigint":"1"}}',
    );
    expect(canonical({})).not.toEqual(canonical({ a: undefined }));
  });

  it("refuses values it cannot represent losslessly", () => {
    expect(() => canonical({ m: new Map() })).toThrow(/Map at \/m/);
    expect(() => canonical({ $bigint: "1" })).toThrow(/collides/);
    expect(() =>
      canonical(Object.assign(new Array<number>(2), { 1: 2 })),
    ).toThrow(/sparse/);
    expect(() => canonical(Long.fromNumber(1, true))).toThrow(/unsigned/);
    expect(() => canonical(Object.assign([1], { extra: undefined }))).toThrow(
      /extra keys/,
    );
    expect(() =>
      canonical(Object.assign(new Array<number>(1), { extra: 42 })),
    ).toThrow(/sparse array or extra keys/);
    expect(() =>
      canonical(Object.defineProperty([], "hidden", { value: 1 })),
    ).toThrow(/extra keys/);
    expect(() =>
      canonical(Object.defineProperty({}, "hidden", { value: 1 })),
    ).toThrow(/non-enumerable/);
    expect(() => canonical({ [Symbol("s")]: 1 })).toThrow(/symbol/);
    for (const t of ["not a time", "0", "2026-02-30T00:00:00Z", 1e100]) {
      expect(() => canonical({ t }, { dbTimeKeys: ["t"] })).toThrow(
        /not a valid time/,
      );
    }
  });

  it("reduces a failed parse to the sorted first path segments of its issues", () => {
    const schema = z.object({ a: z.string(), b: z.object({ c: z.number() }) });

    expect(canonicalParse(schema, { a: 1, b: { c: "x" } })).toEqual({
      $fails: ["a", "b"],
    });
    expect(canonicalParse(z.string(), 1)).toEqual({ $fails: [""] });
    expect(canonicalParse(schema, { a: "x", b: { c: 1 } })).toEqual({
      a: "x",
      b: { c: 1 },
    });
  });
});
