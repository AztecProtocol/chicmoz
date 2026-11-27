import { type HexString } from "@chicmoz-pkg/types";
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
  rawArtifact,
  readClassRow,
  readDeploymentArguments,
  seedStoredArtifact,
} from "./support/contracts.js";
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

  it("skips a block whose tx its canonical parent holds, and keeps the block at its height", async () => {
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

  it("moves the contract class and instance a replacing chain registers again to it, keeping what was verified for them, but never from a canonical block", async () => {
    const { controllers } = await import("../../src/svcs/database/index.js");
    const chainAt400 = async (
      [classTx, deployTx]: HexString[],
      version?: number,
    ) => {
      const publishing = await buildBlock(400n, [classTx], {
        version,
        effect: "publishesClass",
      });
      const deploying = await buildBlock(401n, [deployTx], {
        version,
        parent: publishing,
        effect: "deploysInstance",
      });
      return { publishing, deploying };
    };
    const txs = [freshTxHash(), freshTxHash()];
    const replaced = await chainAt400(txs);
    await store(replaced.publishing);
    await store(replaced.deploying);
    const [contractClassId] = await reads.classesOf(replaced.publishing.hash);
    const [address] = await reads.instancesOf(replaced.deploying.hash);
    expect([contractClassId, address]).not.toContain(undefined);
    await seedStoredArtifact(
      { contractClassId, version: 1 },
      rawArtifact("escrow_contract-Escrow"),
    );
    const salt = freshTxHash();
    await controllers.l2Contract.storeContractInstanceVerifiedDeploymentArguments(
      {
        address,
        salt,
        deployer: `0x${"00".repeat(32)}`,
        publicKeysString: "0x00",
        constructorArgs: [],
      },
    );

    const replacing = await chainAt400(txs);
    await store(replacing.publishing);
    await store(replacing.deploying);
    const owned = async () => [
      await reads.classesOf(replacing.publishing.hash),
      await reads.instancesOf(replacing.deploying.hash),
    ];
    expect(await owned()).toEqual([[contractClassId], [address]]);
    expect(await readClassRow({ contractClassId, version: 1 })).toMatchObject({
      artifactContractName: "Escrow",
    });
    expect(await readDeploymentArguments(address)).toMatchObject({ salt });

    const other = await chainAt400([freshTxHash(), freshTxHash()], 2);
    await store(other.publishing);
    await store(other.deploying);
    expect(await reads.stateOf(other.deploying.hash)).toBe("canonical");
    expect(await owned()).toEqual([[contractClassId], [address]]);
  });

  it("moves a contract update emitted again from a block off the chain with the new block's values, but never from another canonical block", async () => {
    const { controllers } = await import("../../src/svcs/database/index.js");
    const address = `0x${"0a".repeat(32)}` as const;
    const updateIn = (block: BuiltBlock, timestampOfChange: number) =>
      controllers.l2Contract.storeContractInstanceUpdated({
        address,
        prevContractClassId: `0x${"01".repeat(32)}`,
        newContractClassId: `0x${"02".repeat(32)}`,
        timestampOfChange,
        blockHash: block.hash,
      });
    const replaced = await buildBlock(500n, [freshTxHash()]);
    const replacing = await buildBlock(500n, [freshTxHash()]);
    const child = await buildBlock(501n, [freshTxHash()], {
      parent: replacing,
    });
    await store(replaced);
    await updateIn(replaced, 1_000);
    await store(replacing);

    expect(await updateIn(replacing, 2_000)).toBe(true);
    // Its own block, delivered again, writes it again.
    expect(await updateIn(replacing, 2_000)).toBe(true);
    await store(child);
    expect(await updateIn(child, 3_000)).toBe(false);
    expect(await reads.updateOf(address)).toEqual({
      blockHash: replacing.hash,
      timestampOfChange: 2_000,
    });
  });
});
