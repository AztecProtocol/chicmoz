import {
  type ChicmozL2Block,
  type ChicmozL2TxEffect,
  type HexString,
} from "@chicmoz-pkg/types";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  archive,
  body,
  gasFees,
  globalVariables,
  header,
  l1ToL2MessageTree,
  l2Block,
  lastArchive,
  noteHashTree,
  nullifierTree,
  partial,
  publicDataTree,
  publicDataWrite,
  state,
  txEffect,
} from "../../../database/schema/l2block/index.js";
import { type DbTx } from "../utils.js";

/**
 * Inserts every row of a block except its tx effects, off the chain since
 * `orphanTimestamp`: the caller decides its status and attaches its effects.
 * Returns the body id.
 */
export const store = async (
  dbTx: DbTx,
  block: ChicmozL2Block,
  orphanTimestamp: number,
): Promise<string> => {
  await dbTx.insert(l2Block).values({
    hash: block.hash,
    height: BigInt(block.header.globalVariables.blockNumber),
    version: block.header.globalVariables.version,
    orphan_timestamp: orphanTimestamp,
    orphan_hasOrphanedParent: false,
  });

  const headerId = randomUUID();
  await dbTx.insert(header).values({
    id: headerId,
    blockHash: block.hash,
    totalFees: block.header.totalFees.toString(),
    totalManaUsed: block.header.totalManaUsed.toString(),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    spongeBlobHash: block.header.spongeBlobHash,
  });

  await dbTx.insert(archive).values({
    root: block.archive.root,
    nextAvailableLeafIndex: block.archive.nextAvailableLeafIndex,
    fk: block.hash,
  });

  await dbTx.insert(lastArchive).values({
    id: randomUUID(),
    root: block.header.lastArchive.root,
    nextAvailableLeafIndex: block.header.lastArchive.nextAvailableLeafIndex,
    fk: headerId,
  });

  const stateId = randomUUID();
  await dbTx.insert(state).values({
    id: stateId,
    headerId,
  });

  await dbTx.insert(l1ToL2MessageTree).values({
    id: randomUUID(),
    root: block.header.state.l1ToL2MessageTree.root,
    nextAvailableLeafIndex:
      block.header.state.l1ToL2MessageTree.nextAvailableLeafIndex,
    fk: stateId,
  });

  const partialId = randomUUID();
  await dbTx.insert(partial).values({
    id: partialId,
    stateId,
  });

  await dbTx.insert(noteHashTree).values({
    id: randomUUID(),
    root: block.header.state.partial.noteHashTree.root,
    nextAvailableLeafIndex:
      block.header.state.partial.noteHashTree.nextAvailableLeafIndex,
    fk: partialId,
  });

  await dbTx.insert(nullifierTree).values({
    id: randomUUID(),
    root: block.header.state.partial.nullifierTree.root,
    nextAvailableLeafIndex:
      block.header.state.partial.nullifierTree.nextAvailableLeafIndex,
    fk: partialId,
  });

  await dbTx.insert(publicDataTree).values({
    id: randomUUID(),
    root: block.header.state.partial.publicDataTree.root,
    nextAvailableLeafIndex:
      block.header.state.partial.publicDataTree.nextAvailableLeafIndex,
    fk: partialId,
  });

  const globalVariablesId = randomUUID();
  await dbTx.insert(globalVariables).values({
    id: globalVariablesId,
    headerId,
    chainId: block.header.globalVariables.chainId,
    version: block.header.globalVariables.version,
    blockNumber: block.header.globalVariables.blockNumber,
    slotNumber: block.header.globalVariables.slotNumber,
    timestamp: block.header.globalVariables.timestamp,
    coinbase: block.header.globalVariables.coinbase,
    feeRecipient: block.header.globalVariables.feeRecipient,
  });

  await dbTx.insert(gasFees).values({
    id: randomUUID(),
    globalVariablesId,
    feePerDaGas: block.header.globalVariables.gasFees.feePerDaGas,
    feePerL2Gas: block.header.globalVariables.gasFees.feePerL2Gas,
  });

  const bodyId = randomUUID();
  await dbTx.insert(body).values({
    id: bodyId,
    blockHash: block.hash,
  });
  return bodyId;
};

/**
 * Writes a tx effect into a body: inserted when no block holds it, otherwise
 * moved from its holder. A moved effect keeps its birth time and the fields
 * copied from its pending tx.
 */
export const writeTxEffect = async (
  dbTx: DbTx,
  {
    bodyId,
    index,
    effect,
    held,
  }: {
    bodyId: string;
    index: number;
    effect: ChicmozL2TxEffect;
    held: boolean;
  },
): Promise<void> => {
  const content = {
    bodyId,
    index,
    revertCode: effect.revertCode.code,
    transactionFee: effect.transactionFee,
    noteHashes: effect.noteHashes as HexString[],
    nullifiers: effect.nullifiers as HexString[],
    l2ToL1Msgs: effect.l2ToL1Msgs as HexString[],
    privateLogs: effect.privateLogs,
    publicLogs: effect.publicLogs,
    contractClassLogs: effect.contractClassLogs,
  };
  if (held) {
    await dbTx
      .update(txEffect)
      .set(content)
      .where(eq(txEffect.txHash, effect.txHash));
    await dbTx
      .delete(publicDataWrite)
      .where(eq(publicDataWrite.txEffectHash, effect.txHash));
  } else {
    await dbTx.insert(txEffect).values({ txHash: effect.txHash, ...content });
  }
  for (const [pdwIndex, pdw] of effect.publicDataWrites.entries()) {
    await dbTx.insert(publicDataWrite).values({
      id: randomUUID(),
      txEffectHash: effect.txHash,
      index: pdwIndex,
      leafSlot: pdw.leafSlot,
      value: pdw.value,
    });
  }
};
