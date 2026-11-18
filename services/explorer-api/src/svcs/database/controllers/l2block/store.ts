import { getDb as db } from "@chicmoz-pkg/postgres-helper";
import { HexString, type ChicmozL2Block } from "@chicmoz-pkg/types";
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

export const store = async (block: ChicmozL2Block): Promise<void> => {
  return await db().transaction(async (dbTx) => {
    // Insert l2Block
    await dbTx.insert(l2Block).values({
      hash: block.hash,
      height: BigInt(block.header.globalVariables.blockNumber),
      version: block.header.globalVariables.version,
      orphan_timestamp: block.orphan?.timestamp ?? null,
      orphan_hasOrphanedParent: block.orphan?.hasOrphanedParent ?? false,
    });

    const headerId = randomUUID();
    // Insert header
    await dbTx.insert(header).values({
      id: headerId,
      blockHash: block.hash,
      totalFees: block.header.totalFees.toString(),
      totalManaUsed: block.header.totalManaUsed.toString(),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      spongeBlobHash: block.header.spongeBlobHash,
    });

    // Insert archive
    await dbTx.insert(archive).values({
      root: block.archive.root,
      nextAvailableLeafIndex: block.archive.nextAvailableLeafIndex,
      fk: block.hash,
    });

    const lastArchiveId = randomUUID();
    // Insert last archive
    await dbTx.insert(lastArchive).values({
      id: lastArchiveId,
      root: block.header.lastArchive.root,
      nextAvailableLeafIndex: block.header.lastArchive.nextAvailableLeafIndex,
      fk: headerId,
    });

    const stateId = randomUUID();
    // Insert state
    await dbTx.insert(state).values({
      id: stateId,
      headerId,
    });

    const l1ToL2MessageTreeId = randomUUID();
    // Insert l1ToL2MessageTree
    await dbTx.insert(l1ToL2MessageTree).values({
      id: l1ToL2MessageTreeId,
      root: block.header.state.l1ToL2MessageTree.root,
      nextAvailableLeafIndex:
        block.header.state.l1ToL2MessageTree.nextAvailableLeafIndex,
      fk: stateId,
    });

    const partialId = randomUUID();
    // Insert partial
    await dbTx.insert(partial).values({
      id: partialId,
      stateId,
    });

    const noteHashTreeId = randomUUID();
    // Insert partial state trees
    await dbTx.insert(noteHashTree).values({
      id: noteHashTreeId,
      root: block.header.state.partial.noteHashTree.root,
      nextAvailableLeafIndex:
        block.header.state.partial.noteHashTree.nextAvailableLeafIndex,
      fk: partialId,
    });

    const nullifierTreeId = randomUUID();
    await dbTx.insert(nullifierTree).values({
      id: nullifierTreeId,
      root: block.header.state.partial.nullifierTree.root,
      nextAvailableLeafIndex:
        block.header.state.partial.nullifierTree.nextAvailableLeafIndex,
      fk: partialId,
    });

    const publicDataTreeId = randomUUID();
    await dbTx.insert(publicDataTree).values({
      id: publicDataTreeId,
      root: block.header.state.partial.publicDataTree.root,
      nextAvailableLeafIndex:
        block.header.state.partial.publicDataTree.nextAvailableLeafIndex,
      fk: partialId,
    });

    const globalVariablesId = randomUUID();
    // Insert global variables
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

    const gasFeesId = randomUUID();
    // Insert gas fees
    await dbTx.insert(gasFees).values({
      id: gasFeesId,
      globalVariablesId,
      feePerDaGas: block.header.globalVariables.gasFees.feePerDaGas,
      feePerL2Gas: block.header.globalVariables.gasFees.feePerL2Gas,
    });

    const bodyId = randomUUID();
    // Insert body
    await dbTx.insert(body).values({
      id: bodyId,
      blockHash: block.hash,
    });

    // Insert txEffects and create junction entries
    for (const [i, txEff] of Object.entries(block.body.txEffects)) {
      if (isNaN(Number(i))) {
        throw new Error("Invalid txEffect index");
      }
      await dbTx.insert(txEffect).values({
        txHash: txEff.txHash,
        bodyId,
        index: Number(i),
        revertCode: txEff.revertCode.code,
        transactionFee: txEff.transactionFee,
        noteHashes: txEff.noteHashes as HexString[],
        nullifiers: txEff.nullifiers as HexString[],
        l2ToL1Msgs: txEff.l2ToL1Msgs as HexString[],
        privateLogs: txEff.privateLogs,
        publicLogs: txEff.publicLogs,
        contractClassLogs: txEff.contractClassLogs,
      });

      // Insert public data writes
      for (const [pdwIndex, pdw] of Object.entries(txEff.publicDataWrites)) {
        const publicDataWriteId = randomUUID();
        await dbTx.insert(publicDataWrite).values({
          id: publicDataWriteId,
          txEffectHash: txEff.txHash,
          index: Number(pdwIndex),
          leafSlot: pdw.leafSlot,
          value: pdw.value,
        });
      }
    }
  });
};
