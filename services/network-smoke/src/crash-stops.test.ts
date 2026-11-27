import { describe, expect, it } from "vitest";
import { apiStateAtStop } from "./crash-stops.js";

describe("the API's state at its stop", () => {
  const atStop = {
    canonical: { replacing: true, dead: [false, false] },
    sent: [{ partition: 1, from: 32, to: 33 }],
    committed: { blockHandler: [32] },
  };

  it("is the kill's only while the block group itself, and no other, is before the record", () => {
    expect(apiStateAtStop(atStop, 2), "the block group before it").toBe(true);
    expect(
      apiStateAtStop({ ...atStop, committed: { renamedHandler: [32] } }, 2),
      "another group in its place",
    ).toBe(false);
    expect(
      apiStateAtStop(
        { ...atStop, committed: { blockHandler: [32], otherHandler: [32] } },
        2,
      ),
      "a second group on the partition",
    ).toBe(false);
    expect(
      apiStateAtStop({ ...atStop, committed: { blockHandler: [33] } }, 2),
      "the block group past it",
    ).toBe(false);
  });
});
