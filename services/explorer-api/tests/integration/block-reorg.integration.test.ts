import { type HexString } from "@chicmoz-pkg/types";
import { deliver } from "@chicmoz/test-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BuiltBlock, buildBlock, freshTxHash } from "./support/blocks.js";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";

// A tx hash is a primary key across the database, and a reorg orphans every
// active block of its rollup version above its height, so the cases use
// disjoint txs and ascending, disjoint heights, in file order.
describe("block conflicts on a real database", () => {
  let api: ExplorerApiForTest;
  let store: (b: BuiltBlock) => Promise<void>;
  let canonicalHash: (height: bigint) => Promise<HexString | undefined>;
  let orphanOf: (
    hash: HexString,
  ) => Promise<{ hasOrphanedParent: boolean } | "active" | "absent">;
  let owners: (txHash: HexString) => Promise<{ blockHash: HexString; isOrphaned: boolean }[]>;

  beforeAll(async () => {
    api = await startExplorerApiForTest();
    const { blockHandler } = await import(
      "../../src/events/received/on-block/index.js"
    );
    // Controllers, not routes: route reads are cached for a minute.
    const { getBlock } = await import(
      "../../src/svcs/database/controllers/l2block/get-block.js"
    );
    const { getTxEffectOwners } = await import(
      "../../src/svcs/database/controllers/l2block/delete.js"
    );
    store = (b) =>
      deliver(blockHandler, {
        block: b.hex,
        blockNumber: Number(b.height),
        statusHint: "proposed",
      });
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
    owners = async (txHash) =>
      (await getTxEffectOwners([txHash])).map((o) => ({
        blockHash: o.blockHash,
        isOrphaned: o.isOrphaned,
      }));
  });

  afterAll(async () => {
    await api?.close();
  });

  it("skips a block whose tx an active block below holds, and keeps the block at its height", async () => {
    const t = freshTxHash();
    const below = await buildBlock(100n, [t]);
    const current = await buildBlock(101n, [freshTxHash()]);
    const incoming = await buildBlock(101n, [t]);
    expect(incoming.hash).not.toBe(current.hash);
    await store(below);
    await store(current);

    await expect(store(incoming)).resolves.toBeUndefined();
    expect(await canonicalHash(101n)).toBe(current.hash);
    expect(await orphanOf(incoming.hash)).toBe("absent");
    expect(await owners(t)).toEqual([{ blockHash: below.hash, isOrphaned: false }]);

    await expect(store(incoming)).resolves.toBeUndefined();
    expect(await canonicalHash(101n)).toBe(current.hash);
  });

  it("stores a reorg block that reuses the replaced block's tx, deleting the replaced block", async () => {
    const t = freshTxHash();
    const replaced = await buildBlock(200n, [t]);
    const incoming = await buildBlock(200n, [t]);
    expect(incoming.hash).not.toBe(replaced.hash);
    await store(replaced);
    expect(await owners(t)).toEqual([{ blockHash: replaced.hash, isOrphaned: false }]);

    await expect(store(incoming)).resolves.toBeUndefined();
    expect(await canonicalHash(200n)).toBe(incoming.hash);
    expect(await orphanOf(replaced.hash)).toBe("absent");
    expect(await owners(t)).toEqual([{ blockHash: incoming.hash, isOrphaned: false }]);
  });

  it("resolves a two-block reorg, then the redelivery of its second block", async () => {
    const t2 = freshTxHash();
    const old300 = await buildBlock(300n, [freshTxHash()]);
    const old301 = await buildBlock(301n, [t2]);
    const new300 = await buildBlock(300n, [freshTxHash()]);
    const new301 = await buildBlock(301n, [t2]);
    expect(new300.hash).not.toBe(old300.hash);
    expect(new301.hash).not.toBe(old301.hash);
    await store(old300);
    await store(old301);

    await expect(store(new300)).resolves.toBeUndefined();
    expect(await canonicalHash(300n)).toBe(new300.hash);
    expect(await canonicalHash(301n)).toBeUndefined();
    expect(await orphanOf(old300.hash)).toEqual({ hasOrphanedParent: false });
    expect(await orphanOf(old301.hash)).toEqual({ hasOrphanedParent: true });
    expect(await owners(t2)).toEqual([{ blockHash: old301.hash, isOrphaned: true }]);

    await expect(store(new301)).resolves.toBeUndefined();
    const settled = async () => {
      expect(await canonicalHash(300n)).toBe(new300.hash);
      expect(await canonicalHash(301n)).toBe(new301.hash);
      expect(await orphanOf(old301.hash)).toBe("absent");
      expect(await orphanOf(old300.hash)).toEqual({ hasOrphanedParent: false });
      expect(await owners(t2)).toEqual([{ blockHash: new301.hash, isOrphaned: false }]);
    };
    await settled();

    await expect(store(new301)).resolves.toBeUndefined();
    await settled();
  });
});
