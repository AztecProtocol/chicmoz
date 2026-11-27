import { describe, expect, it } from "vitest";
import { checkRanges, firstMismatch } from "./compare-ranges.js";

/** Hashes at heights 1 to `to`, with another block at `diverged`. */
const chain = (to: number, diverged?: number) =>
  new Map(
    Array.from({ length: to }, (_, i) => [
      i + 1,
      i + 1 === diverged ? "0xdead" : `0x${i + 1}`,
    ]),
  );

describe("compare-chain's first mismatch, by check", () => {
  it("finds a head the API lags behind only in the range that reaches it", () => {
    // The API stalled at 10; the node is at 11, finalized at 6.
    const ranges = checkRanges({
      apiLatest: 10,
      nodeFinalized: 6,
      nodeProposed: 11,
    });
    expect(ranges).toEqual({
      sample: { from: 1, to: 10 },
      window: { from: 6, to: 11 },
    });
    expect(firstMismatch(ranges.sample, chain(10), chain(11))).toBeUndefined();
    expect(firstMismatch(ranges.window, chain(10), chain(11))).toBe(11);
  });

  it("finds a block the API kept, inside both ranges, at its height", () => {
    const ranges = checkRanges({
      apiLatest: 12,
      nodeFinalized: 6,
      nodeProposed: 12,
    });
    expect(firstMismatch(ranges.sample, chain(12, 7), chain(12))).toBe(7);
    expect(firstMismatch(ranges.window, chain(12, 7), chain(12))).toBe(7);
  });
});
