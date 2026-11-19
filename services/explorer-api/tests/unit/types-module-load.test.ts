import { describe, expect, it } from "vitest";

// vitest's module runner, unlike Node, hands a module an uninitialized export
// when it imports through a cycle in the package index.
describe("@chicmoz-pkg/types under the test runner", () => {
  it("builds every exported object schema with all of its field schemas", async () => {
    const types = await import("@chicmoz-pkg/types");
    const undefinedFields = Object.entries(types).flatMap(([name, value]) => {
      const shape = (value as { shape?: unknown } | null)?.shape;
      if (typeof shape !== "object" || shape === null) {
        return [];
      }
      return Object.entries(shape)
        .filter(([, field]) => field === undefined)
        .map(([field]) => `${name}.${field}`);
    });

    expect(undefinedFields).toEqual([]);
  });
});
