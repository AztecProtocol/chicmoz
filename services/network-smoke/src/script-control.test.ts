import { describe, expect, it } from "vitest";
import {
  type StateBlockRead,
  type StateTipRead,
  prefixHandled,
} from "./script-control.js";

describe("the hold on a shorter chain, tip 12", () => {
  it("ends on a read above the tip and a tip read a poll interval after it, never on tip reads alone", () => {
    const tip = (at: number): StateTipRead => ({ method: "getChainTips", at });
    const block = (height: number, at: number): StateBlockRead => ({
      method: "getBlockData",
      height,
      at,
    });
    const handled = (
      stateTipReads: StateTipRead[],
      stateBlockReads: StateBlockRead[],
    ) => prefixHandled({ stateTipReads, stateBlockReads }, 12, 1_000);

    expect(
      handled([tip(0), tip(1_000), tip(2_000)], []),
      "election probes alone",
    ).toBe(false);
    expect(
      handled([tip(0), tip(5)], [block(16, 1), block(13, 4)]),
      "a walk whose pass has not ended",
    ).toBe(false);
    expect(
      handled([tip(0), tip(1_001)], [block(12, 1), block(6, 2)]),
      "reads at or below the tip",
    ).toBe(false);
    expect(
      handled([tip(0), tip(1_001)], [block(16, 1), block(13, 4)]),
      "a walk, then the next pass",
    ).toBe(true);
  });
});
