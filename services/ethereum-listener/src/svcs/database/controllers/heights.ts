import { getDb as db } from "@chicmoz-pkg/postgres-helper";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { logger } from "../../../logger.js";
import { getEarliestRollupBlockNumber } from "../../../network-client/client/index.js";
import { heightsTable } from "../schema.js";

export type PartialDbError = {
  code: string;
  detail: string;
};

export const inMemoryHeightTracker = async ({
  contractAddress,
  contractName,
  eventName,
  isFinalized,
  latestHeight,
}: {
  contractAddress: string;
  contractName: string;
  eventName: string;
  isFinalized: boolean;
  latestHeight: bigint;
}) => {
  const { latestPendingHeight, latestFinalizedHeight } = await getHeights({
    contractName,
    contractAddress,
    eventName,
    latestHeight,
  });
  let overrideStoreHeight: bigint | undefined;
  const setOverrideStoreHeight = (height: bigint) => {
    overrideStoreHeight = height;
  };

  const lastProcessedHeight = isFinalized
    ? latestFinalizedHeight
    : latestPendingHeight;

  const genesisBlock = await getEarliestRollupBlockNumber();
  let memoryHeight =
    lastProcessedHeight < genesisBlock ? genesisBlock : lastProcessedHeight;
  const lastProcessedHeightClamped =
    lastProcessedHeight < genesisBlock ? genesisBlock : lastProcessedHeight;
  const finalizedString = isFinalized ? "✅" : "💤";
  logger.info(
    `START ${lastProcessedHeightClamped} ${finalizedString} ${contractName} ${eventName}`,
  );
  const updateMemory = (newHeight: bigint) => {
    if (newHeight > memoryHeight) {
      memoryHeight = newHeight;
    }
  };
  const getMemoryHeight = () => memoryHeight;

  const updateDb = async () => {
    logger.info(
      `END   ${memoryHeight} ${finalizedString} ${contractName} ${eventName}`,
    );
    await setHeight({
      contractName,
      contractAddress,
      eventName,
      height: overrideStoreHeight ?? memoryHeight,
      isFinalized,
    });
  };
  const resumeFrom =
    lastProcessedHeight < genesisBlock
      ? genesisBlock
      : lastProcessedHeight + 1n;
  return {
    updateHeight: updateMemory,
    storeHeight: updateDb,
    // Blocks up to latestHeight, the finalized block, are the finalized
    // poller's: a live watcher's first eth_getLogs spans from its start to the
    // tip, which endpoints that cap the range refuse on every poll.
    fromBlock:
      !isFinalized && resumeFrom <= latestHeight
        ? latestHeight + 1n
        : resumeFrom,
    getMemoryHeight,
    setOverrideStoreHeight,
  };
};

export const setHeight = async ({
  contractName,
  contractAddress,
  eventName,
  height,
  isFinalized,
}: {
  contractName: string;
  contractAddress: string;
  eventName: string;
  height: bigint;
  isFinalized: boolean;
}) => {
  const now = new Date();
  const insertValues = isFinalized
    ? {
        latestFinalizedHeight: height,
        finalizedHeightLastUpdated: now,
      }
    : {
        latestPendingHeight: height,
        pendingHeightLastUpdated: now,
      };
  const updateValues = isFinalized
    ? {
        latestFinalizedHeight: sql<bigint>`greatest(${heightsTable.latestFinalizedHeight}, ${height})`,
        finalizedHeightLastUpdated: now,
      }
    : {
        latestPendingHeight: sql<bigint>`greatest(${heightsTable.latestPendingHeight}, ${height})`,
        pendingHeightLastUpdated: now,
      };

  await db()
    .insert(heightsTable)
    .values({
      contractName,
      contractAddress,
      eventName,
      ...insertValues,
    })
    .onConflictDoUpdate({
      target: [
        heightsTable.contractName,
        heightsTable.contractAddress,
        heightsTable.eventName,
      ],
      set: updateValues,
    });
};

export const getHeights = async ({
  contractName,
  contractAddress,
  eventName,
  latestHeight: _latestHeight,
}: {
  contractName: string;
  contractAddress: string;
  eventName: string;
  latestHeight: bigint;
}) => {
  const res = await db()
    .select(getTableColumns(heightsTable))
    .from(heightsTable)
    .where(
      and(
        eq(heightsTable.contractName, contractName),
        eq(heightsTable.contractAddress, contractAddress),
        eq(heightsTable.eventName, eventName),
      ),
    )
    .limit(1);
  if (!res.length) {
    const earliestBlockNumber = await getEarliestRollupBlockNumber();
    return {
      // The finalized poller backfills a new event from genesis.
      latestPendingHeight: earliestBlockNumber,
      latestFinalizedHeight: earliestBlockNumber,
    };
  }

  return res[0];
};
