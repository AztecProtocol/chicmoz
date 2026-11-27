import { getEntry, setEntry } from "@chicmoz-pkg/redis-helper";
import { randomUUID } from "node:crypto";
import { logger } from "../../logger.js";

const CHAIN_REVISION = "chainRevision";
const NO_REVISION = "none";
// Longer than any entry it keys lives: a revision that expired back to
// NO_REVISION would serve the entries cached under it before the last bump.
const CHAIN_REVISION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** The last part of a chain read's cache key: a chain change retires it. */
export const getChainRevision = async (): Promise<string> =>
  (await getEntry([CHAIN_REVISION])).value ?? NO_REVISION;

/**
 * Retires every chain read cached so far. A random value, not a counter: the
 * cache client has no atomic increment, and the keys only need a value never
 * used before. A failed bump is logged, and those reads live out their TTL.
 */
export const bumpChainRevision = async (): Promise<void> => {
  const stored = await setEntry(
    [CHAIN_REVISION],
    randomUUID(),
    CHAIN_REVISION_TTL_SECONDS,
  );
  if (!stored) {
    logger.warn(
      "Could not bump the chain revision: cached chain reads live out their TTL",
    );
  }
};
