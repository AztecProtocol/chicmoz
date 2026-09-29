import { blockFromBuffer, parseBlock } from "@chicmoz-pkg/backend-utils";
import { type EventHandler } from "@chicmoz-pkg/message-bus";
import {
  generateL2TopicName,
  getConsumerGroupId,
  type NewBlockEvent,
} from "@chicmoz-pkg/message-registry";
import {
  chicmozChainInfoSchema,
  type ChicmozL2Block,
  type ChicmozL2TxEffect,
} from "@chicmoz-pkg/types";
import { SERVICE_NAME } from "../../../constants.js";
import { L2_NETWORK_ID } from "../../../environment.js";
import { logger } from "../../../logger.js";
import { observeRollupVersion } from "../../../svcs/database/controllers/l2/chain-info/rollup-version-cache.js";
import {
  deleteL2BlockByHash,
  deleteL2BlockByHeight,
  getTxEffectOwners,
  type TxEffectOwner,
} from "../../../svcs/database/controllers/l2block/delete.js";
import { unOrphanBlock } from "../../../svcs/database/controllers/l2block/orphan.js";
import { controllers } from "../../../svcs/database/index.js";
import { handleDuplicateBlockError, type PartialDbError } from "../utils.js";
import { storeContracts } from "./contracts.js";
import { detectReorg, handleReorg } from "./reorg-handler.js";
import { type L2Block } from "@aztec/aztec.js/block";

const truncateString = (value: string) => {
  const startHash = value.substring(0, 100);
  const endHash = value.substring(value.length - 100, value.length);
  return `${startHash}...${endHash}`;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const hackyLogBlock = (b: L2Block) => {
  const blockString = JSON.stringify(b, null, 2);
  const logString = blockString
    .split(":")
    .map((v) => {
      if (v.length > 200 && v.includes(",")) {
        return truncateString(v);
      }

      return v;
    })
    .join(":");
  logger.error(`🚫 Block: ${logString}`);
  b.body.txEffects.forEach((txEffect) => {
    txEffect.privateLogs.forEach((log) => {
      log.toFields().forEach((field) => {
        logger.error(`🚫 TxEffect: ${field.toString()}`);
      });
    });
  });
};

const onBlock = async ({
  block,
  blockNumber,
}: NewBlockEvent) => {
  if (!block) {
    logger.error("🚫 Block is empty");
    return;
  }
  logger.info(`👓 Parsing block ${blockNumber}`);
  const b = blockFromBuffer(block);
  let parsedBlock;
  try {
    parsedBlock = await parseBlock(b);
  } catch (e) {
    logger.error(
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      `Failed to parse block ${blockNumber}: ${(e as Error)?.stack ?? e}`,
    );
    return;
  }

  const stored = await storeBlock(parsedBlock);
  if (!stored) {
    return;
  }
  await controllers.l2Block.markOpenGapsFulfilledByHeight(parsedBlock.height);
  await observeRollupVersion({
    l2NetworkId: L2_NETWORK_ID,
    rollupVersion: chicmozChainInfoSchema.shape.rollupVersion.parse(
      parsedBlock.header.globalVariables.version,
    ),
    source: "block",
  });
  await storeContracts(b, parsedBlock.hash);
  await pendingTxsHook(parsedBlock.body.txEffects);
};

/**
 * @returns false when the block was skipped (see
 * pruneConflictingOrphanedTxOwners); true when it is stored.
 */
const storeBlock = async (
  parsedBlock: ChicmozL2Block,
  haveRetried = false,
): Promise<boolean> => {
  logger.info(
    `🧢 Storing block ${parsedBlock.height} (hash: ${parsedBlock.hash})`,
  );

  const reorgDetected = await detectReorg(parsedBlock);

  // Decided before handleReorg writes anything, so a skip changes nothing.
  const blockingOwners = await findBlockingTxOwners(parsedBlock, reorgDetected);
  if (blockingOwners.length > 0) {
    logSkippedTxConflict(parsedBlock, blockingOwners);
    return false;
  }

  if (reorgDetected) {
    await handleReorg(parsedBlock);
  }

  // Set orphan fields to null/false for the new block
  parsedBlock.orphan = undefined;

  // Store the new block
  try {
    await controllers.l2Block.store(parsedBlock);
    return true;
  } catch (e) {
    if (haveRetried) {
      throw new Error(
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        `Failed to store block ${parsedBlock.height} after retry: ${e}`,
      );
    }
    // Only duplicates are resolved below. Anything else propagates, so the
    // message bus redelivers the block instead of it being lost.
    if ((e as PartialDbError).code !== "23505") {
      throw e;
    }

    // If we still get an error, we'll try the old approach as fallback
    const outcome = await handleDuplicateBlockError(
      e as Error,
      `block ${parsedBlock.height}`,
      async () => {
        logger.warn(
          `Deleting block ${parsedBlock.height} (hash: ${parsedBlock.hash})`,
        );
        await deleteL2BlockByHeight(parsedBlock.height);
      },
      async () => {
        // The block hash already exists but is orphaned — un-orphan it
        // since the node is serving it as the canonical block.
        await unOrphanBlock(parsedBlock.hash);
      },
      async () => pruneConflictingOrphanedTxOwners(parsedBlock),
    );

    if (outcome === "retry") {
      return storeBlock(parsedBlock, true);
    }
    return outcome === "done";
  }
};

const ownerSummary = (owners: TxEffectOwner[]) =>
  owners
    .map(
      (owner) =>
        `${owner.txHash} in active block ${owner.blockHeight} (${owner.blockHash})`,
    )
    .join(", ");

const logSkippedTxConflict = (
  parsedBlock: ChicmozL2Block,
  activeOwners: TxEffectOwner[],
) => {
  logger.error(
    `SKIPPED_BLOCK_TX_CONFLICT height=${parsedBlock.height} hash=${parsedBlock.hash} owners=${ownerSummary(activeOwners)}`,
  );
};

/**
 * Active blocks holding the block's txs that its own reorg would leave
 * active. handleReorg orphans the active block at the block's height and
 * the blocks above it; an active holder elsewhere (below the height, on
 * another rollup version, or anywhere when there is no reorg) means the
 * block is skipped, as deciding which of the two is canonical is out of
 * scope here.
 */
const findBlockingTxOwners = async (
  parsedBlock: ChicmozL2Block,
  reorgDetected: boolean,
) => {
  const owners = await getTxEffectOwners(
    parsedBlock.body.txEffects.map((txEffect) => txEffect.txHash),
  );
  const rollupVersion = parsedBlock.header.globalVariables.version;
  return owners.filter(
    (owner) =>
      !owner.isOrphaned &&
      owner.blockHash !== parsedBlock.hash &&
      !(
        reorgDetected &&
        owner.rollupVersion === rollupVersion &&
        owner.blockHeight >= parsedBlock.height
      ),
  );
};

/**
 * Frees the block's txs from orphaned blocks still holding them, so the
 * retry can store it (the multi-block reorg case).
 *
 * @returns false when an ACTIVE block holds one of its txs. The block is
 * then skipped (the message is acked, not redelivered forever as before,
 * which wedged mainnet for ~23h) and logged as SKIPPED_BLOCK_TX_CONFLICT;
 * its height stays empty until something stores it.
 */
const pruneConflictingOrphanedTxOwners = async (
  parsedBlock: ChicmozL2Block,
): Promise<boolean> => {
  const incomingTxHashes = parsedBlock.body.txEffects.map(
    (txEffect) => txEffect.txHash,
  );
  const owners = await getTxEffectOwners(incomingTxHashes);

  if (owners.length === 0) {
    logger.error(
      `Duplicate tx_hash while storing block ${parsedBlock.height}, but no existing tx owner was found`,
    );
    throw new Error(
      `Duplicate tx_hash while storing block ${parsedBlock.height}, but no existing tx owner was found`,
    );
  }

  // Normally caught up front by findBlockingTxOwners; checked again in case
  // a holder became active in between.
  const activeOwners = owners.filter((owner) => !owner.isOrphaned);
  if (activeOwners.length > 0) {
    logSkippedTxConflict(parsedBlock, activeOwners);
    return false;
  }

  const orphanedOwnerHashes = [...new Set(owners.map((owner) => owner.blockHash))];
  logger.warn(
    `Pruning ${orphanedOwnerHashes.length} orphaned tx owner block(s) before retrying block ${parsedBlock.height}: ${orphanedOwnerHashes.join(", ")}`,
  );

  for (const blockHash of orphanedOwnerHashes) {
    await deleteL2BlockByHash(blockHash);
  }
  return true;
};

const pendingTxsHook = async (txEffects: ChicmozL2TxEffect[]) => {
  await controllers.l2Tx.removePendingAndDroppedTx(txEffects);
};

export const blockHandler: EventHandler = {
  groupId: getConsumerGroupId({
    serviceName: SERVICE_NAME,
    networkId: L2_NETWORK_ID,
    handlerName: "blockHandler",
  }),
  topic: generateL2TopicName(L2_NETWORK_ID, "NEW_BLOCK_EVENT"),
  cb: onBlock as (arg0: unknown) => Promise<void>,
};

export const catchupHandler: EventHandler = {
  groupId: getConsumerGroupId({
    serviceName: SERVICE_NAME,
    networkId: L2_NETWORK_ID,
    handlerName: "catchupHandler",
  }),
  topic: generateL2TopicName(L2_NETWORK_ID, "CATCHUP_BLOCK_EVENT"),
  cb: ((event: NewBlockEvent) => {
    logger.info(`Catchup block event`);
    return onBlock(event);
  }) as (arg0: unknown) => Promise<void>,
};
