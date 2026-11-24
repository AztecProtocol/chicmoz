import { type L2TipsEvent } from "@chicmoz-pkg/message-registry";
import { type HexString } from "@chicmoz-pkg/types";
import { deliver } from "@chicmoz/test-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BuiltBlock, buildBlock, freshTxHash } from "./support/blocks.js";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";

const word = (n: number): HexString => `0x${n.toString(16).padStart(64, "0")}`;

// Tips and blocks arrive on separate topics, so tips can name a proposed
// block before it is stored. Finalized 1, proven 2, checkpointed 3.
describe("native block statuses when the tips name a block not stored yet", () => {
  let api: ExplorerApiForTest;
  let chain: BuiltBlock[];
  let deliverBlock: (block: BuiltBlock) => Promise<void>;
  let deliverTips: (proposed: BuiltBlock) => Promise<void>;
  let statusesOf: (heights: number[]) => Promise<string[]>;
  let degradedReason: () => Promise<string | undefined>;
  let openMismatches: () => Promise<object[]>;
  let unknownInUiTable: () => Promise<number[]>;

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
    const { getBlocksForUiTable } = await import(
      "../../src/svcs/database/controllers/ui/tables.js"
    );
    const tips = await import("../../src/svcs/database/controllers/l2/tips.js");

    chain = [];
    for (let height = 1n; height <= 5n; height++) {
      chain.push(await buildBlock(height, [freshTxHash()]));
    }
    deliverBlock = (block) =>
      deliver(blockHandler, {
        block: block.hex,
        blockNumber: Number(block.height),
        statusHint: "proposed",
      });
    const at = (block: BuiltBlock, checkpoint: number) => ({
      block: { number: Number(block.height), hash: block.hash },
      checkpoint: { number: checkpoint, hash: word(0x500 + checkpoint) },
    });
    deliverTips = (proposed) =>
      deliver(l2TipsHandler, {
        tips: {
          proposed: { number: Number(proposed.height), hash: proposed.hash },
          checkpointed: at(chain[2], 3),
          proven: at(chain[1], 2),
          finalized: at(chain[0], 1),
        },
        observedAt: Date.now(),
        source: { rpcNodeName: "node", aztecNodeVersion: "test" },
      } satisfies L2TipsEvent);
    statusesOf = (heights) =>
      Promise.all(
        heights.map(
          async (height) =>
            (await getBlock(BigInt(height)))?.nativeStatus ?? "absent",
        ),
      );
    degradedReason = async () => (await tips.getTips())?.degradedReason;
    openMismatches = async () =>
      (await tips.getRecentBoundaryMismatches())
        .filter((mismatch) => !mismatch.resolvedAt)
        .map(({ bucket, height, observedDbHash, occurrenceCount }) => ({
          bucket,
          height,
          observedDbHash,
          occurrenceCount,
        }));
    unknownInUiTable = async () =>
      (
        await getBlocksForUiTable({
          from: undefined,
          to: undefined,
          status: "unknown",
        })
      ).map((block) => Number(block.height));

    for (const block of chain.slice(0, 3)) {
      await deliverBlock(block);
    }
  });

  afterAll(async () => {
    await api?.close();
  });

  // The cases build on each other, in order.
  it("keeps the statuses up to the checkpointed tip while the proposed block is on its way", async () => {
    await deliverTips(chain[4]);
    await deliverBlock(chain[3]);

    expect(await degradedReason()).toBe("proposed boundary block 5 is missing");
    expect(await statusesOf([1, 2, 3, 4])).toEqual([
      "finalized",
      "proven",
      "checkpointed",
      "unknown",
    ]);
    expect(await unknownInUiTable()).toEqual([4]);
    // Storing block 4 validated again without counting another occurrence.
    expect(await openMismatches()).toEqual([
      { bucket: "proposed", height: 5, observedDbHash: null, occurrenceCount: 1 },
    ]);
  });

  it("counts the tips as valid once the block they name is stored", async () => {
    await deliverBlock(chain[4]);

    expect(await degradedReason()).toBeUndefined();
    expect(await statusesOf([1, 4, 5])).toEqual([
      "finalized",
      "proposed",
      "proposed",
    ]);
    expect(await unknownInUiTable()).toEqual([]);
    expect(await openMismatches()).toEqual([]);
  });

  it("keeps the tips degraded when the block stored at the proposed height has another hash", async () => {
    const named = await buildBlock(6n, [freshTxHash()]);
    const stored = await buildBlock(6n, [freshTxHash()]);
    await deliverTips(named);
    await deliverBlock(stored);

    expect(await degradedReason()).toBe(
      `proposed boundary block 6 hash mismatch: db=${stored.hash} tip=${named.hash}`,
    );
    expect(await statusesOf([1, 6])).toEqual(["unknown", "unknown"]);
  });
});
