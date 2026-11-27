import { describe, expect, it } from "vitest";
import { bounded, lateGroups } from "./broker.js";

describe("a broker read", () => {
  it("gives up once its time runs out", async () => {
    await expect(
      bounded("a read", () => new Promise<never>(() => undefined), 20),
    ).rejects.toThrow("a read: no answer from the broker within 0.02 s");
  });
});

describe("judging consumer groups", () => {
  it("counts a group with a record it has not committed, whatever its state, and no group without one", () => {
    expect(
      lateGroups([
        // Its member expired while its handler held offset 5.
        {
          groupId: "expired-holding",
          state: "Empty",
          partitions: [{ committed: 5, low: 0, end: 6 }],
        },
        {
          groupId: "expired-idle",
          state: "Empty",
          partitions: [{ committed: 6, low: 0, end: 6 }],
        },
        {
          groupId: "rejoining-idle",
          state: "PreparingRebalance",
          partitions: [{ committed: 6, low: 0, end: 6 }],
        },
        {
          groupId: "stable-holding",
          state: "Stable",
          partitions: [{ committed: -1, low: 2, end: 3 }],
        },
        { groupId: "unknown", state: "Empty", partitions: [] },
        { groupId: "absent", state: "Dead", partitions: [] },
        { groupId: "stable-idle", state: "Stable", partitions: [] },
      ]),
    ).toEqual(["expired-holding", "stable-holding", "unknown"]);
  });
});
