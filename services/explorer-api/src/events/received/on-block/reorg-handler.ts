import { ChicmozL2Block } from "@chicmoz-pkg/types";
import { logger } from "../../../logger.js";
import { getBlock } from "../../../svcs/database/controllers/l2block/get-block.js";
import { handleReorgOrphaning } from "../../../svcs/database/controllers/l2block/orphan.js";

/**
 * Detects if there's a re-org at the given block height
 */
export const detectReorg = async (
  parsedBlock: ChicmozL2Block,
): Promise<boolean> => {
  // Check if a block with the same height but different hash already exists
  const existingBlock = await getBlock(parsedBlock.height, {
    rollupVersion: parsedBlock.header.globalVariables.version,
  });
  return !!(existingBlock && existingBlock.hash !== parsedBlock.hash);
};

/**
 * Handles a re-org by marking the existing block and higher blocks of the
 * parsed block's rollup version as orphaned and storing their transactions
 * as dropped
 */
export const handleReorg = async (
  parsedBlock: ChicmozL2Block,
): Promise<void> => {
  const rollupVersion = parsedBlock.header.globalVariables.version;
  const existingBlock = await getBlock(parsedBlock.height, { rollupVersion });

  if (!existingBlock) {
    return;
  }

  logger.warn(
    `Re-org detected at height ${parsedBlock.height}. Existing hash: ${existingBlock.hash}, new hash: ${parsedBlock.hash}`,
  );

  // Handle the orphaning in a database transaction
  const totalOrphaned = await handleReorgOrphaning(
    existingBlock.hash,
    parsedBlock.height,
    rollupVersion,
  );
  logger.warn(
    `Completed re-org handling at height ${parsedBlock.height}. Total orphaned blocks: ${totalOrphaned}`,
  );
};
