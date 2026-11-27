import { type L2TipsEvent } from "@chicmoz-pkg/message-registry";
import { type HexString } from "@chicmoz-pkg/types";
import { deliver } from "@chicmoz/test-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BuiltBlock, buildChain, orderedEvent } from "./support/blocks.js";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";

const word = (n: number): HexString => `0x${n.toString(16).padStart(64, "0")}`;

// Until a tier moves past block 0 it names the genesis block, which the
// chain never stores.
describe("the tips of a young chain on a real database", () => {
  let api: ExplorerApiForTest;
  let store: (block: BuiltBlock) => Promise<void>;
  let storeTips: (tips: L2TipsEvent["tips"]) => Promise<void>;
  let degradedReason: () => Promise<string | undefined>;
  let openMismatchHeights: () => Promise<number[]>;
  let statusesOf: (heights: number[]) => Promise<string[]>;

  beforeAll(async () => {
    api = await startExplorerApiForTest();
    const { blockHandler } = await import(
      "../../src/events/received/on-block/index.js"
    );
    const { l2TipsHandler } = await import(
      "../../src/events/received/on-l2-tips.js"
    );
    const { getBlock } = await import(
      "../../src/svcs/database/controllers/l2block/get-block.js"
    );
    const tips = await import("../../src/svcs/database/controllers/l2/tips.js");
    store = (block) => deliver(blockHandler, orderedEvent(block));
    storeTips = (tipsOf) =>
      deliver(l2TipsHandler, {
        tips: tipsOf,
        observedAt: Date.now(),
        source: { rpcNodeName: "node", aztecNodeVersion: "test" },
      } satisfies L2TipsEvent);
    degradedReason = async () => (await tips.getTips())?.degradedReason;
    openMismatchHeights = async () =>
      (await tips.getRecentBoundaryMismatches())
        .filter((mismatch) => !mismatch.resolvedAt)
        .map((mismatch) => mismatch.height);
    statusesOf = (heights) =>
      Promise.all(
        heights.map(
          async (height) =>
            (await getBlock(BigInt(height)))?.nativeStatus ?? "absent",
        ),
      );
  });

  afterAll(async () => {
    await api?.close();
  });

  it("keeps the tips healthy while the proven and finalized tiers are at block 0", async () => {
    const [first, second, third] = await buildChain(1n, 3);
    await store(first);
    await store(second);
    const genesis = {
      block: { number: 0, hash: word(0x10) },
      checkpoint: { number: 0, hash: word(0x500) },
    };
    await storeTips({
      proposed: { number: 2, hash: second.hash },
      checkpointed: {
        block: { number: 1, hash: first.hash },
        checkpoint: { number: 1, hash: word(0x501) },
      },
      proven: genesis,
      finalized: genesis,
    });
    // A chain change validates the stored tips again.
    await store(third);

    expect(await degradedReason()).toBeUndefined();
    expect(await openMismatchHeights()).toEqual([]);
    expect(await statusesOf([1, 2])).toEqual(["checkpointed", "proposed"]);
  });
});
