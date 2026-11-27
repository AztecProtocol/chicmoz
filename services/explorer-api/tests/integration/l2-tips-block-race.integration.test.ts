import { type L2TipsEvent } from "@chicmoz-pkg/message-registry";
import { type HexString } from "@chicmoz-pkg/types";
import { deliver } from "@chicmoz/test-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BuiltBlock,
  buildBlock,
  buildChain,
  freshTxHash,
  orderedEvent,
} from "./support/blocks.js";
import { loadChainLockProbes } from "./support/chain-lock.js";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";

const word = (n: number): HexString => `0x${n.toString(16).padStart(64, "0")}`;

// Tips and blocks arrive on separate topics, so tips can name a proposed
// block before it is stored, or one a later change demotes. Finalized 1,
// proven 2, checkpointed 3.
describe("native block statuses when the tips and the chain disagree", () => {
  let api: ExplorerApiForTest;
  let chain: BuiltBlock[];
  let deliverBlock: (block: BuiltBlock) => Promise<void>;
  let deliverTips: (proposed: BuiltBlock) => Promise<void>;
  let statusesOf: (heights: number[]) => Promise<string[]>;
  let degradedReason: () => Promise<string | undefined>;
  let openMismatches: (height: number) => Promise<object[]>;
  let unknownInUiTable: () => Promise<number[]>;
  let holdChainLock: () => Promise<() => Promise<void>>;
  let untilLockWaiters: (count: number, what: string) => Promise<void>;
  let takeOffChain: (block: BuiltBlock) => Promise<void>;

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
    const { l2Block } = await import(
      "../../src/svcs/database/schema/l2block/index.js"
    );
    const { eq } = await import("drizzle-orm");

    chain = await buildChain(1n, 5);
    deliverBlock = (block) => deliver(blockHandler, orderedEvent(block));
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
    openMismatches = async (height) =>
      (await tips.getRecentBoundaryMismatches())
        .filter(
          (mismatch) => !mismatch.resolvedAt && mismatch.height === height,
        )
        .map(({ bucket, observedDbHash, occurrenceCount }) => ({
          bucket,
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
    ({ holdChainLock, untilLockWaiters } = await loadChainLockProbes());
    takeOffChain = async (block) => {
      await (await import("@chicmoz-pkg/postgres-helper"))
        .getDb()
        .update(l2Block)
        .set({ orphan_timestamp: Date.now(), orphan_hasOrphanedParent: false })
        .where(eq(l2Block.hash, block.hash));
    };

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
    expect(await openMismatches(5)).toEqual([
      { bucket: "proposed", observedDbHash: null, occurrenceCount: 1 },
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
    expect(await openMismatches(5)).toEqual([]);
  });

  it("keeps the tips degraded when the block stored at the proposed height has another hash", async () => {
    const named = await buildBlock(6n, [freshTxHash()], { parent: chain[4] });
    const stored = await buildBlock(6n, [freshTxHash()], { parent: chain[4] });
    await deliverTips(named);
    await deliverBlock(stored);

    expect(await degradedReason()).toBe(
      `proposed boundary block 6 hash mismatch: db=${stored.hash} tip=${named.hash}`,
    );
    expect(await statusesOf([1, 6])).toEqual(["unknown", "unknown"]);
    chain.push(stored);
  });

  it("degrades healthy tips when a change demotes the block they name, and closes the mismatch the reorg explains", async () => {
    const named = await buildBlock(7n, [freshTxHash()], { parent: chain[5] });
    await deliverBlock(named);
    await deliverTips(named);
    expect(await degradedReason()).toBeUndefined();

    const replacing = await buildBlock(7n, [freshTxHash()], {
      parent: chain[5],
    });
    await deliverBlock(replacing);

    expect(await degradedReason()).toBe(
      `proposed boundary block 7 hash mismatch: db=${replacing.hash} tip=${named.hash}`,
    );
    expect(await statusesOf([1, 7])).toEqual(["unknown", "unknown"]);
    expect(await openMismatches(7)).toEqual([]);
    chain.push(replacing);
  });

  it("validates tips on the chain they are written against, so a demotion while they wait leaves them degraded", async () => {
    const named = await buildBlock(8n, [freshTxHash()], { parent: chain[6] });
    await deliverBlock(named);
    const release = await holdChainLock();
    const stored = deliverTips(named);
    await untilLockWaiters(1, "the tips handler");
    await takeOffChain(named);
    await release();
    await stored;

    expect(await degradedReason()).toBe("proposed boundary block 8 is missing");
  });
});
