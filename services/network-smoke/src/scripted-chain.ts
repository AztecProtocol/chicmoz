import {
  BlockNumber,
  CheckpointNumber,
  IndexWithinCheckpoint,
  SlotNumber,
  TreeLeafIndex,
} from "@aztec-labs/foundation/branded-types";
import { Fr } from "@aztec-labs/foundation/curves/bn254";
import { Body, L2Block } from "@aztec-labs/stdlib/block";
import { CheckpointHeader } from "@aztec-labs/stdlib/rollup";
import { AppendOnlyTreeSnapshot } from "@aztec-labs/stdlib/trees";
import { BlockHeader, type TxEffect } from "@aztec-labs/stdlib/tx";
import { loadFixture } from "@chicmoz/test-harness";
import { type BlockId, type ScriptFacts } from "./script-control.js";

export type ScriptedBlock = {
  block: L2Block;
  hash: string;
  /** Each block is its own checkpoint, as on the local network. */
  checkpointHash: string;
};

/** What the node serves at one step: `chain[h]` is the block at height `h`; the last one is the proposed tip. */
export type NodeState = {
  label: string;
  chain: readonly ScriptedBlock[];
  checkpointed: number;
  proven: number;
  finalized: number;
};

export type Script = { states: NodeState[]; facts: ScriptFacts };

/** The node info a local network served; the blocks carry its chain id and rollup version. */
export const recordedNodeInfo = () =>
  loadFixture("local-network", "node-info", "node-info").data.result;

const recordedBlock = (name: string) =>
  loadFixture("local-network", "l2-block", name).data;

/** The only tx of a recorded local-network block, as the node served it. */
const recordedTx = (name: string): TxEffect => {
  const { hex } = recordedBlock(name);
  const [tx] = L2Block.fromBuffer(Buffer.from(hex, "hex")).body.txEffects;
  return tx;
};

type ChainConstants = { chainId: Fr; version: Fr; genesisTime: bigint };

const SLOT_SECONDS = 72n;

const makeBlock = async (
  parent: ScriptedBlock | undefined,
  height: number,
  slot: number,
  txs: TxEffect[],
  { chainId, version, genesisTime }: ChainConstants,
): Promise<ScriptedBlock> => {
  const body = new Body(txs);
  const header = BlockHeader.random({
    lastArchive: parent?.block.archive ?? AppendOnlyTreeSnapshot.empty(),
    txEffectsTreeRoot: await body.computeTxEffectsTreeRoot(),
    chainId,
    version,
    blockNumber: BlockNumber(height),
    slotNumber: SlotNumber(slot),
    timestamp: genesisTime + BigInt(slot) * SLOT_SECONDS,
  });
  // Only the links matter downstream: a child's hash covers its lastArchive,
  // and nothing recomputes a root from the archive tree, so a random root, as
  // L2Block.random draws, is enough.
  const archive = new AppendOnlyTreeSnapshot(
    Fr.random(),
    TreeLeafIndex(height + 1),
  );
  const block = new L2Block(
    archive,
    header,
    body,
    CheckpointNumber(height),
    IndexWithinCheckpoint(0),
  );
  const { globalVariables } = header;
  const checkpoint = CheckpointHeader.random({
    lastArchiveRoot: header.lastArchive.root,
    slotNumber: globalVariables.slotNumber,
    timestamp: globalVariables.timestamp,
    coinbase: globalVariables.coinbase,
    feeRecipient: globalVariables.feeRecipient,
    gasFees: globalVariables.gasFees,
    totalManaUsed: header.totalManaUsed,
  });
  return {
    block,
    hash: (await block.hash()).toString(),
    checkpointHash: checkpoint.hash().toString(),
  };
};

const idOf = ({ block, hash }: ScriptedBlock): BlockId => ({
  height: block.number,
  hash,
});

/**
 * Blocks 1–10 grow one per step and 1–6 become proven and finalized; then
 * the node prunes 7–10 and grows 7′–12′ on 6. The tips move as the local
 * network's did across an epoch prune: the shorter chain is never served
 * (the replacing block is already there), the checkpointed tip reaches 7′ one
 * step later, and the proven and finalized tips stay at the prune target.
 */
export const buildScript = async (): Promise<Script> => {
  const { l1ChainId, rollupVersion } = recordedNodeInfo();
  const constants: ChainConstants = {
    chainId: new Fr(l1ChainId),
    version: new Fr(rollupVersion),
    genesisTime: BigInt(Math.floor(Date.now() / 1000) - 7200),
  };
  const classTx = recordedTx("block-1");
  const deployTx = recordedTx("block-2");
  const [contractAddress] =
    recordedBlock("block-2").expected.contractInstanceAddresses;

  const grow = async (
    chain: ScriptedBlock[],
    to: number,
    slotOf: (height: number) => number,
    txsAt: Record<number, TxEffect[]>,
  ) => {
    for (let height = chain.length; height <= to; height++) {
      chain.push(
        await makeBlock(
          chain.at(-1),
          height,
          slotOf(height),
          txsAt[height] ?? [],
          constants,
        ),
      );
    }
    return chain;
  };
  const old = await grow([], 10, (h) => h, { 1: [classTx], 8: [deployTx] });
  // The node rebuilds from the pruned txs at once, a few slots after the dead chain.
  const replacing = await grow(old.slice(0, 7), 12, (h) => h + 7, {
    7: [deployTx],
  });

  const states: NodeState[] = [];
  const at = (
    label: string,
    chain: ScriptedBlock[],
    checkpointed: number,
    proven: number,
    finalized: number,
  ) => states.push({ label, chain, checkpointed, proven, finalized });

  at("genesis", old.slice(0, 1), 0, 0, 0);
  for (let h = 1; h <= 6; h++) {
    at(`add ${h}`, old.slice(0, h + 1), h, 0, 0);
  }
  at("prove 1–6", old.slice(0, 7), 6, 6, 0);
  at("finalize 1–6", old.slice(0, 7), 6, 6, 6);
  for (let h = 7; h <= 10; h++) {
    at(`add ${h}`, old.slice(0, h + 1), h, 6, 6);
  }
  const pruneAt = states.length;
  at("prune 7–10, propose 7′", replacing.slice(0, 8), 6, 6, 6);
  at("checkpoint 7′", replacing.slice(0, 8), 7, 6, 6);
  for (let h = 8; h <= 12; h++) {
    at(`add ${h}′`, replacing.slice(0, h + 1), h, 6, 6);
  }

  return {
    states,
    facts: {
      states: states.map((s) => s.label),
      pruneAt,
      dead: old.slice(7).map(idOf),
      final: replacing.slice(1).map(idOf),
      movedTx: {
        hash: deployTx.txHash.toString(),
        deadHeight: 8,
        finalHeight: 7,
      },
      contractAddress,
    },
  };
};
