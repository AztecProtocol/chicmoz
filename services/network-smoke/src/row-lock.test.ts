import { describe, expect, it } from "vitest";
import { blockedBy } from "./row-lock.js";

describe("blockedBy", () => {
  it("follows waiters queued behind other waiters, and leaves sessions another lock holds up", () => {
    const harness = 1;
    expect(
      blockedBy(harness, [
        // Queued behind 20's tuple lock, listed before it.
        { pid: 30, blockers: [20] },
        { pid: 20, blockers: [harness] },
        { pid: 40, blockers: [99] },
        { pid: 99, blockers: [] },
      ]),
    ).toEqual(new Set([20, 30]));
  });
});
