import {
  ChicmozChainInfo,
  ChicmozL2Tips,
  ChicmozL2RpcNode,
  ChicmozL2RpcNodeError,
  chicmozL2RpcNodeErrorSchema,
  jsonStringify,
} from "@chicmoz-pkg/types";
import type {
  CatchupBlockEvent,
  L2BlockStatusHint,
  L2TipsEvent,
} from "@chicmoz-pkg/message-registry";
import { L2_NETWORK_ID } from "../../environment.js";
import { logger } from "../../logger.js";
import { txsController } from "../../svcs/database/index.js";
import {
  publishKeyedMessage,
  publishMessage,
  publishMessageSync,
} from "../../svcs/message-bus/index.js";
import { onL2RpcNodeAlive } from "./on-node-alive.js";
import { L2Block } from "@aztec-labs/stdlib/block";

const toSafeBlockNumber = (value: bigint): number => {
  const blockNumber = Number(value);

  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error(`Block number ${value.toString()} is not a safe integer`);
  }

  return blockNumber;
};

/**
 * Sends a block of the ordered stream, keyed by the network so the topic
 * keeps the send order. `proposedTip` is the proposed tip of the pass that
 * sends it.
 */
export const onOrderedBlock = async (block: L2Block, proposedTip: number) => {
  const height = BigInt(block.header.globalVariables.blockNumber.toString());
  const heightNumber = toSafeBlockNumber(height);
  logger.info(
    `🦊 publishing block ${height} (hash: ${(
      await block.hash()
    ).toString()}, proposed tip ${proposedTip})...`,
  );
  const blockBuffer = block.toBuffer() as Uint8Array;
  const blockStr = Buffer.from(blockBuffer).toString("hex");
  await publishKeyedMessage("NEW_BLOCK_EVENT", L2_NETWORK_ID, {
    block: blockStr,
    statusHint: "proposed",
    blockNumber: heightNumber,
    ordered: { proposedTip },
  });
  const potentiallyIncludedTxs = await txsController.getTxs([
    "pending",
    "suspected_dropped",
  ]);
  const blockTxHashes = block.body.txEffects.map((effect) =>
    effect.txHash.toString(),
  );

  for (const potentialTx of potentiallyIncludedTxs) {
    if (blockTxHashes.includes(potentialTx.txHash)) {
      await txsController.storeOrUpdate(potentialTx, "proposed");
      logger.info(
        `✅ Transaction ${potentialTx.txHash} found in block ${height}, updated to proposed`,
      );
    }
  }
};

export const onCatchupBlock = async (
  block: L2Block,
  statusHint: L2BlockStatusHint,
  metadata: Pick<
    CatchupBlockEvent,
    "requestId" | "catchupReason" | "finalized"
  > = {},
) => {
  const blockNumber = BigInt(
    block.header.globalVariables.blockNumber.toString(),
  );
  const blockNumberSafe = toSafeBlockNumber(blockNumber);
  const blockBuffer = block.toBuffer() as Uint8Array;
  const blockStr = Buffer.from(blockBuffer).toString("hex");
  await publishMessage("CATCHUP_BLOCK_EVENT", {
    block: blockStr,
    statusHint,
    blockNumber: blockNumberSafe,
    ...metadata,
  });
};

export const onL2Tips = async (
  tips: ChicmozL2Tips,
  source: L2TipsEvent["source"] = {},
) => {
  const event: L2TipsEvent = {
    tips,
    observedAt: Date.now(),
    source,
  };
  logger.info(`🔺 publishing L2_TIPS_EVENT ${jsonStringify(event)}`);
  await publishMessage("L2_TIPS_EVENT", event);
};

export const onChainInfo = async (chainInfo: ChicmozChainInfo) => {
  const event = { chainInfo };
  logger.info(`🔗 publishing CHAIN_INFO_EVENT ${jsonStringify(event)}`);
  await publishMessage("CHAIN_INFO_EVENT", event);
};

export const onL2RpcNodeInfo = async (rpcNode: ChicmozL2RpcNode) => {
  const event = { rpcNode };
  logger.info(`🔍 publishing L2_RPC_NODE_INFO_EVENT ${jsonStringify(event)}`);
  await publishMessage("L2_RPC_NODE_INFO_EVENT", event);
};

const isIpAddress = (str: string) => {
  // Check if string is a valid IPv4 address
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4Regex.test(str)) {
    const parts = str.split(".");
    return parts.every((part) => parseInt(part) >= 0 && parseInt(part) <= 255);
  }
};

export const replaceIpAddress = (url: string) => {
  if (!url || typeof url !== "string") {
    throw new Error("Invalid URL provided");
  }

  try {
    const host = url.split("//")[1].split(":")[0];

    if (isIpAddress(host)) {
      return "xxx.xxx.xxx.xxx"; // Hide IP address
    }

    // If it's a domain, extract just the domain name (remove subdomains)
    const domainParts = host.split(".");
    if (domainParts.length >= 2) {
      // Return the last two parts (domain.tld)
      return domainParts.slice(-2).join(".");
    }

    return host; // Return as-is if can't parse
  } catch (error) {
    return url;
  }
};
export const onL2RpcNodeError = (
  rpcNodeError: Omit<
    ChicmozL2RpcNodeError,
    "rpcUrl" | "count" | "createdAt" | "lastSeenAt"
  >,
  // explorer-api cannot store an error without its node's URL.
  rpcUrl: string,
) => {
  let event;
  try {
    event = {
      nodeError: chicmozL2RpcNodeErrorSchema.parse({
        ...rpcNodeError,
        rpcUrl: rpcUrl,
        count: 1,
        createdAt: new Date(),
        lastSeenAt: new Date(),
      }),
    };
  } catch (e) {
    logger.warn(`❌ onL2RpcNodeError on parse error: ${(e as Error).message}`);
    return;
  }
  logger.info(
    `❌ publishing L2_RPC_NODE_ERROR_EVENT ${rpcNodeError.rpcNodeName ? `(${rpcNodeError.rpcNodeName})` : ""}...`,
  );
  event.nodeError.cause = replaceIpAddress(event.nodeError.cause);
  event.nodeError.stack = replaceIpAddress(event.nodeError.stack);
  event.nodeError.message = replaceIpAddress(event.nodeError.message);
  publishMessageSync("L2_RPC_NODE_ERROR_EVENT", event);
};

export { onL2RpcNodeAlive };
