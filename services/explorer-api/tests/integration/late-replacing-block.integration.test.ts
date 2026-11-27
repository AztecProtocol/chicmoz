import { type L2TipsEvent } from "@chicmoz-pkg/message-registry";
import { type HexString } from "@chicmoz-pkg/types";
import { deliver } from "@chicmoz/test-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BuiltBlock,
  buildBlock,
  buildChain,
  catchupEvent,
  freshTxHash,
  orderedEvent,
} from "./support/blocks.js";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";

const word = (n: number): HexString => `0x${n.toString(16).padStart(64, "0")}`;

// A block at a height the chain replaced can stay stored while the replacing
// chain's next blocks are stored above it. Every canonical block of the
// version above an ordered block's tip is demoted, so the cases use
// ascending, disjoint heights, in file order.
describe("a replaced block that stays stored on a real database", () => {
  let api: ExplorerApiForTest;
  let store: (b: BuiltBlock) => Promise<void>;
  let storeLate: (b: BuiltBlock) => Promise<void>;
  let canonicalHash: (height: bigint) => Promise<HexString | undefined>;
  let orphanOf: (
    hash: HexString,
  ) => Promise<{ hasOrphanedParent: boolean } | "active" | "absent">;
  let isDropped: (txHash: HexString) => Promise<boolean>;
  let storeTips: (
    tips: Pick<L2TipsEvent["tips"], "proposed"> & {
      finalized: BuiltBlock;
      proven: BuiltBlock;
      checkpointed: BuiltBlock;
    },
  ) => Promise<void>;
  let repairRequestCovers: (height: number) => Promise<boolean>;
  let lastSeenAgo: (height: number, ms: number) => Promise<void>;
  let mismatchOpenAt: (height: number) => Promise<boolean>;

  beforeAll(async () => {
    api = await startExplorerApiForTest();
    const { blockHandler, catchupHandler } = await import(
      "../../src/events/received/on-block/index.js"
    );
    const { l2TipsHandler } = await import(
      "../../src/events/received/on-l2-tips.js"
    );
    const { getBlock } = await import(
      "../../src/svcs/database/controllers/l2block/get-block.js"
    );
    const { getDroppedTxByHash } = await import(
      "../../src/svcs/database/controllers/dropped-tx/get-tx.js"
    );
    const { buildTipBoundaryRepairRequest } = await import(
      "../../src/svcs/database/controllers/l2block/missing-ranges.js"
    );
    store = (b) => deliver(blockHandler, orderedEvent(b));
    storeLate = (b) => deliver(catchupHandler, catchupEvent(b));
    canonicalHash = async (height) => (await getBlock(height))?.hash;
    orphanOf = async (hash) => {
      const block = await getBlock(hash);
      if (!block) {
        return "absent";
      }
      return block.orphan
        ? { hasOrphanedParent: block.orphan.hasOrphanedParent }
        : "active";
    };
    isDropped = async (txHash) => (await getDroppedTxByHash(txHash)) !== null;
    const at = (block: BuiltBlock) => ({
      block: { number: Number(block.height), hash: block.hash },
      checkpoint: {
        number: Number(block.height),
        hash: word(Number(block.height)),
      },
    });
    storeTips = ({ proposed, finalized, proven, checkpointed }) =>
      deliver(l2TipsHandler, {
        tips: {
          proposed,
          checkpointed: at(checkpointed),
          proven: at(proven),
          finalized: at(finalized),
        },
        observedAt: Date.now(),
        source: { rpcNodeName: "node", aztecNodeVersion: "test" },
      } satisfies L2TipsEvent);
    repairRequestCovers = async (height) => {
      const planned = await buildTipBoundaryRepairRequest();
      return (
        planned?.request.ranges.some(
          (range) => range.from <= height && height <= range.to,
        ) ?? false
      );
    };
    const { getDb } = await import("@chicmoz-pkg/postgres-helper");
    const { and, eq, isNull } = await import("drizzle-orm");
    const { l2TipBoundaryMismatchTable: mismatch } = await import(
      "../../src/svcs/database/schema/l2/tips.js"
    );
    lastSeenAgo = async (height, ms) => {
      await getDb()
        .update(mismatch)
        .set({ lastSeenAt: new Date(Date.now() - ms) })
        .where(eq(mismatch.height, height));
    };
    mismatchOpenAt = async (height) =>
      (
        await getDb()
          .select({ id: mismatch.id })
          .from(mismatch)
          .where(and(eq(mismatch.height, height), isNull(mismatch.resolvedAt)))
      ).length > 0;
  });

  afterAll(async () => {
    await api?.close();
  });

  it("keeps the replacing chain's stored blocks active when its block at the replaced height arrives after them", async () => {
    const replaced = await buildBlock(100n, [freshTxHash()]);
    const replacing = await buildBlock(100n, [freshTxHash()]);
    const child = await buildBlock(101n, [freshTxHash()], {
      parent: replacing,
    });
    const grandchild = await buildBlock(102n, [freshTxHash()], {
      parent: child,
    });
    await store(replaced);
    await store(child);
    await store(grandchild);

    await storeLate(replacing);

    expect(await orphanOf(replaced.hash)).toEqual({ hasOrphanedParent: false });
    expect(
      await Promise.all([100n, 101n, 102n].map((h) => canonicalHash(h))),
    ).toEqual([replacing.hash, child.hash, grandchild.hash]);
  });

  it("stops listing a block's txs as dropped once that block is canonical again", async () => {
    const t = freshTxHash();
    const first = await buildBlock(200n, [t]);
    const second = await buildBlock(200n, [freshTxHash()]);
    await store(first);
    await store(second);
    expect(await isDropped(t)).toBe(true);

    await store(first);

    expect(await canonicalHash(200n)).toBe(first.hash);
    expect(await isDropped(t)).toBe(false);
  });

  it.fails(
    "still requests a replaced height after the next tips validate at other heights",
    async () => {
      const chain: BuiltBlock[] = [];
      for (let height = 400n; height <= 403n; height++) {
        chain.push(
          await buildBlock(height, [freshTxHash()], { parent: chain.at(-1) }),
        );
      }
      const [finalized, proven, checkpointed, replaced] = chain;
      for (const block of chain) {
        await store(block);
      }
      const replacing = await buildBlock(403n, [freshTxHash()], {
        parent: checkpointed,
      });
      const next = await buildBlock(404n, [freshTxHash()], {
        parent: replacing,
      });
      const tipsAt = (proposed: BuiltBlock) =>
        storeTips({
          proposed: { number: Number(proposed.height), hash: proposed.hash },
          finalized,
          proven,
          checkpointed,
        });

      await tipsAt(replacing);
      expect(await repairRequestCovers(403)).toBe(true);

      await store(next);
      await tipsAt(next);

      expect(await canonicalHash(403n)).toBe(replaced.hash);
      expect(await repairRequestCovers(403)).toBe(true);
    },
  );

  it("resolves a tip mismatch nothing fixed only a day after it was last seen", async () => {
    const chain = await buildChain(500n, 4);
    const [finalized, proven, checkpointed, stored] = chain;
    for (const block of chain) {
      await store(block);
    }
    const named = await buildBlock(503n, [freshTxHash()], {
      parent: checkpointed,
    });
    const tipsAt = (proposed: BuiltBlock) =>
      storeTips({
        proposed: { number: Number(proposed.height), hash: proposed.hash },
        finalized,
        proven,
        checkpointed,
      });
    await tipsAt(named);
    await tipsAt(stored);
    expect(await mismatchOpenAt(503)).toBe(true);

    await lastSeenAgo(503, 25 * 60 * 60 * 1000);
    await tipsAt(stored);

    expect(await mismatchOpenAt(503)).toBe(false);
  });
});
