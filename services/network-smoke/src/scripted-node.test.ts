import { BlockNumber } from "@aztec-labs/aztec.js/fields";
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node";
import { BlockHash } from "@aztec-labs/stdlib/block";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BlockId, scriptControl } from "./script-control.js";
import { type ScriptedNode, startScriptedNode } from "./scripted-node.js";

describe("scripted node", () => {
  let node: ScriptedNode;

  beforeAll(async () => {
    node = await startScriptedNode({
      rpcPort: 0,
      controlPort: 0,
      log: () => undefined,
    });
  }, 60_000);

  afterAll(() => node?.close());

  it("serves each state, through the SDK client, as a linked chain whose tips stay ordered", async () => {
    const client = createAztecNodeClient(node.rpcUrl);
    const control = scriptControl(node.controlUrl);
    const { states, pruneAt, dead, final, movedTx } = await control.status();
    const genesis = await client.getBlock(BlockNumber(0));
    expect(genesis, "block 0").toBeDefined();
    const { rollupVersion } = await client.getNodeInfo();
    expect(BigInt(rollupVersion), "rollup version").toBe(
      genesis!.header.globalVariables.version.toBigInt(),
    );

    let finalized = 0;
    let served: BlockId[] = [];
    for (let i = 0; i < states.length; i++) {
      if (i > 0) {
        expect((await control.step()).current).toBe(i);
      }
      const tips = await client.getChainTips();
      const heights = [
        tips.finalized.block.number,
        tips.proven.block.number,
        tips.checkpointed.block.number,
        tips.proposed.number,
      ];
      expect(heights, `${states[i]}: tiers`).toEqual(
        [...heights].sort((a, b) => a - b),
      );
      expect(
        tips.finalized.block.number,
        `${states[i]}: finalized`,
      ).toBeGreaterThanOrEqual(finalized);
      finalized = tips.finalized.block.number;

      const blocks =
        tips.proposed.number === 0
          ? []
          : await client.getBlocks(BlockNumber(1), tips.proposed.number, {
              includeTransactions: true,
            });
      expect(blocks.map((b) => b.number)).toEqual(
        Array.from({ length: tips.proposed.number }, (_, h) => h + 1),
      );
      let parent = genesis!;
      for (const block of blocks) {
        const at = `${states[i]}: block ${block.number}`;
        expect(block.header.lastArchive.root.toString(), `${at} links`).toBe(
          parent.archive.root.toString(),
        );
        expect(
          (await block.body.computeTxEffectsTreeRoot()).toString(),
          `${at} body`,
        ).toBe(block.header.txEffectsTreeRoot.toString());
        expect((await block.header.hash()).toString(), `${at} hash`).toBe(
          block.hash.toString(),
        );
        parent = block;
      }
      const byHeight = new Map(
        [genesis!, ...blocks].map((b) => [
          b.number as number,
          b.hash.toString(),
        ]),
      );
      for (const tip of [tips.checkpointed, tips.proven, tips.finalized]) {
        expect(
          tip.block.hash,
          `${states[i]}: tier at ${tip.block.number}`,
        ).toBe(byHeight.get(tip.block.number));
      }
      expect(tips.proposed.hash).toBe(byHeight.get(tips.proposed.number));

      if (i === pruneAt - 1) {
        expect(
          blocks
            .slice(6)
            .map((b) => ({ height: b.number, hash: b.hash.toString() })),
        ).toEqual(dead);
        expect(
          blocks[movedTx.deadHeight - 1].body.txEffects.map((tx) =>
            tx.txHash.toString(),
          ),
        ).toContain(movedTx.hash);
      }
      served = blocks.map((b) => ({
        height: b.number,
        hash: b.hash.toString(),
      }));
      if (i >= pruneAt) {
        for (const { hash } of dead) {
          expect(
            await client.getBlockData({ hash: BlockHash.fromString(hash) }),
          ).toBeUndefined();
        }
      }
    }
    expect(served).toEqual(final);
    const replacing = await client.getBlock(BlockNumber(movedTx.finalHeight), {
      includeTransactions: true,
    });
    expect(
      replacing!.body.txEffects.map((tx) => tx.txHash.toString()),
    ).toContain(movedTx.hash);
  }, 120_000);

  it("answers a method it does not implement with Method not found", async () => {
    const client = createAztecNodeClient(node.rpcUrl);
    await expect(client.getL1Constants()).rejects.toThrow(
      "Method not found: aztec_getL1Constants",
    );
  });
});
