import { blockFromBuffer, parseBlock } from "@chicmoz-pkg/backend-utils";
import { type EventHandler, type Heartbeat } from "@chicmoz-pkg/message-bus";
import {
  generateL2TopicName,
  getConsumerGroupId,
  type CatchupBlockEvent,
  type NewBlockEvent,
} from "@chicmoz-pkg/message-registry";
import { chicmozChainInfoSchema } from "@chicmoz-pkg/types";
import { z } from "zod";
import { SERVICE_NAME } from "../../../constants.js";
import { L2_NETWORK_ID } from "../../../environment.js";
import { logger } from "../../../logger.js";
import { observeRollupVersion } from "../../../svcs/database/controllers/l2/chain-info/rollup-version-cache.js";
import {
  applyCatchupBlock,
  applyOrderedBlock,
  type ChainOutcome,
  type IncomingBlock,
} from "../../../svcs/database/controllers/l2block/canonical.js";
import { controllers } from "../../../svcs/database/index.js";
import { parseBlockContracts } from "./contracts.js";

const orderedSchema = z.object({ tip: z.number().int().nonnegative() });

const decode = async ({
  block,
  blockNumber,
}: NewBlockEvent | CatchupBlockEvent): Promise<IncomingBlock | undefined> => {
  if (!block) {
    logger.error("🚫 Block is empty");
    return undefined;
  }
  logger.info(`👓 Parsing block ${blockNumber}`);
  const b = blockFromBuffer(block);
  let parsed;
  try {
    parsed = await parseBlock(b);
  } catch (e) {
    logger.error(
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      `Failed to parse block ${blockNumber}: ${(e as Error)?.stack ?? e}`,
    );
    return undefined;
  }
  return { block: parsed, contracts: await parseBlockContracts(b, parsed.hash) };
};

const afterCommit = async (
  { block }: IncomingBlock,
  { canonical }: ChainOutcome,
) => {
  if (!canonical) {
    return;
  }
  await controllers.l2Block.markOpenGapsFulfilledByHeight(block.height);
  await observeRollupVersion({
    l2NetworkId: L2_NETWORK_ID,
    rollupVersion: chicmozChainInfoSchema.shape.rollupVersion.parse(
      block.header.globalVariables.version,
    ),
    source: "block",
  });
};

// Only the hash-following listener marks its blocks ordered. An unordered
// block carries no chain authority, and storing it could build runs of
// unlinked blocks that a later walk would have to cross.
const onBlock = async (event: NewBlockEvent, heartbeat: Heartbeat) => {
  if (event.ordered === undefined) {
    logger.warn(`Ignoring block ${event.blockNumber}: not from the ordered stream`);
    return;
  }
  const ordered = orderedSchema.safeParse(event.ordered);
  if (!ordered.success) {
    logger.error(
      `Ignoring block ${event.blockNumber}: invalid ordered field ${JSON.stringify(event.ordered)}`,
    );
    return;
  }
  const incoming = await decode(event);
  if (!incoming) {
    return;
  }
  await afterCommit(
    incoming,
    await applyOrderedBlock(incoming, ordered.data.tip, heartbeat),
  );
};

const onCatchupBlock = async (
  event: CatchupBlockEvent,
  heartbeat: Heartbeat,
) => {
  const incoming = await decode(event);
  if (!incoming) {
    return;
  }
  await afterCommit(
    incoming,
    await applyCatchupBlock(incoming, event.final === true, heartbeat),
  );
};

export const blockHandler: EventHandler = {
  groupId: getConsumerGroupId({
    serviceName: SERVICE_NAME,
    networkId: L2_NETWORK_ID,
    handlerName: "blockHandler",
  }),
  topic: generateL2TopicName(L2_NETWORK_ID, "NEW_BLOCK_EVENT"),
  cb: onBlock as (arg0: unknown, heartbeat: Heartbeat) => Promise<void>,
};

export const catchupHandler: EventHandler = {
  groupId: getConsumerGroupId({
    serviceName: SERVICE_NAME,
    networkId: L2_NETWORK_ID,
    handlerName: "catchupHandler",
  }),
  topic: generateL2TopicName(L2_NETWORK_ID, "CATCHUP_BLOCK_EVENT"),
  cb: onCatchupBlock as (arg0: unknown, heartbeat: Heartbeat) => Promise<void>,
};
