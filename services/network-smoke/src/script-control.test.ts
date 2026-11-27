import { describe, expect, it } from "vitest";
import { type StateRead, prefixHandled } from "./script-control.js";

describe("the hold on a shorter chain, tip 12", () => {
  it("ends at the next pass's walk, never on tip reads alone or on the walking pass's own reread", () => {
    const tips: StateRead = { method: "getChainTips", at: 0 };
    const block = (height: number): StateRead => ({
      method: "getBlock",
      height,
      at: 0,
    });
    const walk = [block(16), block(15), block(14), block(13)];
    const handled = (reads: StateRead[]) => prefixHandled(reads, 12);

    expect(handled([tips, tips, tips, tips]), "election probes alone").toBe(
      false,
    );
    expect(
      handled([tips, tips, ...walk, tips]),
      "a walk and its pass's reread of the tips",
    ).toBe(false);
    expect(
      handled([tips, block(12), block(6), tips, block(12)]),
      "reads at or below the tip",
    ).toBe(false);
    expect(
      handled([tips, tips, ...walk, tips, tips, tips, block(16)]),
      "a walk, its pass's reread, then the next pass's walk",
    ).toBe(true);
  });
});
