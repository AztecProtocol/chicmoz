import { blockFromBuffer, parseBlock } from "@chicmoz-pkg/backend-utils";
import { type EventHandler } from "@chicmoz-pkg/message-bus";
import {
  type CatchupBlockEvent,
  generateL2TopicName,
  getConsumerGroupId,
  type NewBlockEvent,
} from "@chicmoz-pkg/message-registry";
import { getDb as db } from "@chicmoz-pkg/postgres-helper";
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
  applyBlockStorePlan,
  getBlockStoreFacts,
  lockBlockStores,
} from "../../../svcs/database/controllers/l2block/block-store.js";
import {
  type BlockEventSource,
  planBlockStore,
} from "../../../svcs/database/controllers/l2block/store-plan.js";
import { controllers } from "../../../svcs/database/index.js";
import { getBlockEventSource } from "../utils.js";
import { storeContracts } from "./contracts.js";
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

// The live and catch-up consumers both run in this process. Each block's
// whole pipeline, store and hooks, runs one at a time, so a hook (contracts,
// gap bookkeeping) never interleaves with another block displacing the one
// it is for. Across processes, lockBlockStores serializes the store itself.
let blockPipelineQueue: Promise<unknown> = Promise.resolve();
const serializeBlockPipeline = <T>(run: () => Promise<T>): Promise<T> => {
  const result = blockPipelineQueue.then(run, run);
  blockPipelineQueue = result.catch(() => undefined);
  return result;
};

const onBlock = async (event: CatchupBlockEvent, isCatchup: boolean) => {
  const { block, blockNumber } = event;
  if (!block) {
    logger.error("🚫 Block is empty");
    return;
  }
  logger.info(`👓 Parsing block ${blockNumber}`);
  const b = blockFromBuffer(block);
  let parsedBlock: ChicmozL2Block;
  try {
    parsedBlock = await parseBlock(b);
  } catch (e) {
    logger.error(
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      `Failed to parse block ${blockNumber}: ${(e as Error)?.stack ?? e}`,
    );
    return;
  }

  const source = getBlockEventSource(event, isCatchup);
  await serializeBlockPipeline(async () => {
    const stored = await storeBlock(parsedBlock, source);
    if (!stored) {
      return;
    }
    await controllers.l2Block.markOpenGapsFulfilledByHeight(
      parsedBlock.height,
    );
    await observeRollupVersion({
      l2NetworkId: L2_NETWORK_ID,
      rollupVersion: chicmozChainInfoSchema.shape.rollupVersion.parse(
        parsedBlock.header.globalVariables.version,
      ),
      source: "block",
    });
    await storeContracts(b, parsedBlock.hash);
    await pendingTxsHook(parsedBlock.body.txEffects);
  });
};

/**
 * Stores the block in one transaction: lock, look at what it would collide
 * with, decide (planBlockStore), then orphan, delete and insert together, so
 * a failure rolls everything back and a skip writes nothing. Errors are
 * rethrown for the message bus to redeliver.
 *
 * @returns whether the block is stored and active afterwards.
 */
const storeBlock = async (
  parsedBlock: ChicmozL2Block,
  source: BlockEventSource,
): Promise<boolean> =>
  await db().transaction(async (dbTx) => {
    await lockBlockStores(dbTx);
    const facts = await getBlockStoreFacts(dbTx, parsedBlock);
    const plan = planBlockStore(
      {
        height: parsedBlock.height,
        rollupVersion: parsedBlock.header.globalVariables.version,
      },
      source,
      facts,
    );
    if (plan.action === "skip") {
      logger.warn(
        `Skipping block ${parsedBlock.height} (hash: ${parsedBlock.hash}): ${plan.reason}`,
      );
      return false;
    }
    logger.info(
      `🧢 Storing block ${parsedBlock.height} (hash: ${parsedBlock.hash}): ${plan.action}`,
    );
    await applyBlockStorePlan(dbTx, parsedBlock, plan, Date.now());
    return true;
  });

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
  cb: ((event: NewBlockEvent) => onBlock(event, false)) as (
    arg0: unknown,
  ) => Promise<void>,
};

export const catchupHandler: EventHandler = {
  groupId: getConsumerGroupId({
    serviceName: SERVICE_NAME,
    networkId: L2_NETWORK_ID,
    handlerName: "catchupHandler",
  }),
  topic: generateL2TopicName(L2_NETWORK_ID, "CATCHUP_BLOCK_EVENT"),
  cb: ((event: CatchupBlockEvent) => {
    logger.info(`Catchup block event`);
    return onBlock(event, true);
  }) as (arg0: unknown) => Promise<void>,
};
