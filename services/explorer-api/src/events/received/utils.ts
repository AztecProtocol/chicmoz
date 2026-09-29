import { type CatchupBlockEvent } from "@chicmoz-pkg/message-registry";
import { logger } from "../../logger.js";
import { type BlockEventSource } from "../../svcs/database/controllers/l2block/store-plan.js";

export type PartialDbError = {
  code: string;
  detail: string;
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

export const getBlockEventSource = (
  event: CatchupBlockEvent,
  isCatchup: boolean,
): BlockEventSource => ({
  live: !isCatchup,
  proven: event.statusHint === "proven",
});
