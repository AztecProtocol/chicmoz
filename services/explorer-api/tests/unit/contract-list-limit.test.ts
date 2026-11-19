import { describe, expect, it } from "vitest";
import {
  getContractClassesSchema,
  getContractInstancesSchema,
} from "../../src/svcs/http-server/routes/paths_and_validation.js";

// The cap is a literal on purpose: raising it must fail this test.
describe.each([
  ["contract instances", getContractInstancesSchema],
  ["contract classes", getContractClassesSchema],
])("%s list limit", (_route, schema) => {
  const parseLimit = (limit: string) => schema.safeParse({ query: { limit } });

  it("accepts integers up to 100 and rejects 101, 0 and fractions", () => {
    expect(parseLimit("1").success).toBe(true);
    expect(parseLimit("100").success).toBe(true);
    expect(parseLimit("101").success).toBe(false);
    expect(parseLimit("0").success).toBe(false);
    expect(parseLimit("1.5").success).toBe(false);
  });

  // The class listing takes a different query path when limit is absent.
  it("leaves limit unset when the query omits it", () => {
    expect(schema.parse({ query: {} }).query.limit).toBeUndefined();
  });
});
