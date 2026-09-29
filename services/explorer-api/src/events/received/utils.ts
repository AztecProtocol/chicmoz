import { logger } from "../../logger.js";

export type PartialDbError = {
  code: string;
  detail: string;
};

/**
 * What storing a block should do after a duplicate-key error:
 * - "retry": the conflict was cleared; store the block again.
 * - "done": the block is already stored (un-orphaned if needed).
 * - "skip": the block is not stored; skip it and its hooks.
 */
export type DuplicateBlockOutcome = "retry" | "done" | "skip";

export const handleDuplicateBlockError = async (
  e: Error | PartialDbError,
  additionalInfo: string,
  deleteBlockCallback: () => Promise<void>,
  unOrphanCallback?: () => Promise<void>,
  // Resolves false when the conflict cannot be cleared and the block is skipped.
  resolveDuplicateTxHashCallback?: () => Promise<boolean>,
): Promise<DuplicateBlockOutcome> => {
  if ((e as PartialDbError).code === "23505") {
    const detail = (e as PartialDbError).detail;
    if (detail.includes("(hash)")) {
      // Block with exact same hash already exists.
      // If the existing block is orphaned, un-orphan it instead of skipping.
      if (unOrphanCallback) {
        logger.info(
          `DB duplicate hash for "${additionalInfo}": attempting to un-orphan existing block. [${detail}]`,
        );
        await unOrphanCallback();
      } else {
        logger.warn(
          `DB duplicate for "${additionalInfo}" skipping... [${detail}]`,
        );
      }
      return "done";
    } else if (detail.includes("(tx_hash)")) {
      // tx_hash duplicate: a transaction from this block already exists. Prefer
      // resolving the actual owning block over deleting the incoming height.
      if (resolveDuplicateTxHashCallback) {
        logger.warn(
          `DB duplicate tx_hash for "${additionalInfo}": resolving tx owner and retrying. [${detail}]`,
        );
        return (await resolveDuplicateTxHashCallback()) ? "retry" : "skip";
      }

      logger.warn(
        `DB duplicate tx_hash for "${additionalInfo}": deleting block at height and retrying. [${detail}]`,
      );
      await deleteBlockCallback();
      return "retry";
    } else if (detail.includes("(height)")) {
      // height duplicate: same as before.
      logger.warn(
        `DB duplicate for "${additionalInfo}": deleting block at height and retrying. [${detail}]`,
      );
      await deleteBlockCallback();
      return "retry";
    }
    // A key this handler does not know: the block was not stored, and
    // counting it as stored would run its hooks and fulfil its gap.
    logger.error(
      `DB duplicate on an unexpected key for "${additionalInfo}": not stored, skipping. [${detail}]`,
    );
    return "skip";
  }
  handleOtherError(e as Error, additionalInfo);
  return "skip";
};

export const handleDuplicateError = (
  e: Error | PartialDbError,
  additionalInfo: string,
) => {
  if ((e as PartialDbError).code === "23505") {
    logger.warn(`DB Duplicate: ${additionalInfo}`);
    return;
  }
  handleOtherError(e as Error, additionalInfo);
};

const handleOtherError = (e: Error, additionalInfo: string) => {
  if (e.stack) {
    logger.error(
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      `Failed to store ${additionalInfo}: ${e?.stack}`,
    );
    return;
  }
  logger.warn(JSON.stringify(e));
  logger.error(new Error(`Failed to store ${additionalInfo}`).stack);
};
