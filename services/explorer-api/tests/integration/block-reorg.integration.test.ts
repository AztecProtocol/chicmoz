import { deliver } from "@chicmoz/test-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BuiltBlock,
  buildBlock,
  freshTxHash,
  orderedEvent,
} from "./support/blocks.js";
import { loadChainReads } from "./support/chain.js";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";

// A tx hash is a primary key across the database, and an ordered block
// demotes every canonical block of its rollup version above its tip, so the
// cases use disjoint txs and ascending, disjoint heights, in file order.
describe("block conflicts on a real database", () => {
  let api: ExplorerApiForTest;
  let store: (b: BuiltBlock) => Promise<void>;
  let reads: Awaited<ReturnType<typeof loadChainReads>>;

  beforeAll(async () => {
    api = await startExplorerApiForTest();
    const { blockHandler } = await import(
      "../../src/events/received/on-block/index.js"
    );
    reads = await loadChainReads();
    store = (b) => deliver(blockHandler, orderedEvent(b));
  });

  afterAll(async () => {
    await api?.close();
  });

  it("skips a block whose tx a canonical block below holds, and keeps the block at its height", async () => {
    const t = freshTxHash();
    const below = await buildBlock(100n, [t]);
    const current = await buildBlock(101n, [freshTxHash()], { parent: below });
    const incoming = await buildBlock(101n, [t], { parent: below });
    await store(below);
    await store(current);

    await expect(store(incoming)).resolves.toBeUndefined();
    expect(await reads.stateOf(current.hash)).toBe("canonical");
    expect(await reads.stateOf(incoming.hash)).toBe("absent");
    expect(await reads.ownerOf(t)).toBe(below.hash);
  });

  it("moves a tx the replacing block includes again, and keeps the replaced block", async () => {
    const t = freshTxHash();
    const replaced = await buildBlock(200n, [t]);
    const incoming = await buildBlock(200n, [t]);
    await store(replaced);

    await store(incoming);
    expect(await reads.stateOf(incoming.hash)).toBe("canonical");
    expect(await reads.stateOf(replaced.hash)).toEqual({
      hasOrphanedParent: false,
    });
    expect(await reads.ownerOf(t)).toBe(incoming.hash);
    expect(await reads.isDropped(t)).toBe(false);
  });

  it("records a two-block reorg once, then resolves the redelivery of its second block", async () => {
    const t2 = freshTxHash();
    const old300 = await buildBlock(300n, [freshTxHash()]);
    const old301 = await buildBlock(301n, [t2], { parent: old300 });
    const new300 = await buildBlock(300n, [freshTxHash()]);
    const new301 = await buildBlock(301n, [t2], { parent: new300 });
    await store(old300);
    await store(old301);

    await store(new300);
    expect(await reads.stateOf(new300.hash)).toBe("canonical");
    expect(await reads.stateOf(old300.hash)).toEqual({
      hasOrphanedParent: false,
    });
    expect(await reads.stateOf(old301.hash)).toEqual({
      hasOrphanedParent: true,
    });
    expect(await reads.ownerOf(t2)).toBe(old301.hash);

    await store(new301);
    const settled = async () => {
      expect(await reads.stateOf(new301.hash)).toBe("canonical");
      expect(await reads.stateOf(old301.hash)).toEqual({
        hasOrphanedParent: true,
      });
      expect(await reads.ownerOf(t2)).toBe(new301.hash);
      expect(await reads.listed([old300, old301])).toEqual([
        { orphanedBlockHash: old300.hash, height: 300n, nbrOfOrphanedBlocks: 2 },
      ]);
    };
    await settled();

    await store(new301);
    await settled();
  });
});
