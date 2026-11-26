import { inspect } from "node:util";
import { type Logger as SdkLogger } from "@aztec-labs/foundation/log";
import { logger } from "../../../../logger.js";

// The stream's data carries bigints and field elements, which JSON rejects.
const line = (msg: string, ...data: unknown[]) =>
  [msg, ...data.filter((d) => d !== undefined).map((d) => inspect(d))].join(
    " ",
  );

/**
 * The SDK block stream's logger, routed to the listener's. The stream reports
 * a handler's failure only here, so it must not go to the SDK's own output.
 */
export const streamLogger: SdkLogger = {
  silent: () => undefined,
  fatal: (msg: string, err?: unknown, data?: unknown) =>
    logger.error(line(msg, err, data)),
  error: (msg: string, err?: unknown, data?: unknown) =>
    logger.error(line(msg, err, data)),
  warn: (msg, data) => logger.warn(line(msg, data)),
  info: (msg, data) => logger.info(line(msg, data)),
  verbose: (msg, data) => logger.debug(line(msg, data)),
  debug: (msg, data) => logger.debug(line(msg, data)),
  // Every pass traces its tips and each hash it compares.
  trace: () => undefined,
  level: "debug",
  isLevelEnabled: (level) => level !== "trace" && level !== "silent",
  module: "block-stream",
  createChild: () => streamLogger,
  getBindings: () => ({}),
};
