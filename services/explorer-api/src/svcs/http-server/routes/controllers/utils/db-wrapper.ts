import { CacheKeys, getEntry, setEntry } from "@chicmoz-pkg/redis-helper";
import { NODE_ENV, NodeEnv, jsonStringify } from "@chicmoz-pkg/types";
import {
  CACHE_LATEST_TTL_SECONDS,
  CACHE_TTL_SECONDS,
} from "../../../../../environment.js";
import { logger } from "../../../../../logger.js";
import { getChainRevision } from "../../../../cache/chain-revision.js";
import { dbParseErrorCallback } from "../../../../database/controllers/utils.js";
import { controllers as db } from "../../../../database/index.js";

const LATEST_HEIGHT = "latestHeight";

/**
 * Keys for a read whose answer depends on which blocks are canonical. Take
 * them before reading the data: a read that sees a bumped revision then sees
 * the commit the bump follows.
 */
export const onChainKeys = async (keys: CacheKeys): Promise<CacheKeys> => [
  ...keys,
  await getChainRevision(),
];

const latestHeightAt = async (revision: string) => {
  const keys = [LATEST_HEIGHT, revision];
  const cacheRes = await getEntry(keys);
  const cachedVal = cacheRes.value;
  const isCached = cachedVal !== null && cachedVal !== undefined;
  if (isCached) {
    return cachedVal;
  }

  const dbVal = await db.l2Block.getLatestHeight().catch(dbParseErrorCallback);
  if (dbVal) {
    await setEntry(keys, dbVal.toString(), CACHE_LATEST_TTL_SECONDS);
    return dbVal;
  }
  throw new Error("CACHE_ERROR: latest height not found");
};

export const getLatestHeight = async () =>
  latestHeightAt(await getChainRevision());

export const getLatest = async (
  keys: CacheKeys,
  dbFn: () => Promise<unknown>,
): Promise<string> => {
  const revision = await getChainRevision();
  const latestHeight = await latestHeightAt(revision);
  if (!latestHeight) {
    throw new Error("CACHE_ERROR: latest height not found");
  }
  // NOTE: we add one second to the TTL to ensure that stale cache is not stored
  return get(
    [...keys, latestHeight, revision],
    dbFn,
    CACHE_LATEST_TTL_SECONDS + 1,
  );
};

export const get = async (
  keys: CacheKeys,
  dbFn: () => Promise<unknown>,
  ttl = CACHE_TTL_SECONDS,
): Promise<string> => {
  const res = await getEntry(keys);
  const cachedVal = res.value;
  const isCached = cachedVal !== null && cachedVal !== undefined;
  if (isCached) {
    if (NODE_ENV === NodeEnv.DEV) {
      logger.info(`CACHE_HIT: ${res.keysStr}`);
    }
    return cachedVal;
  }

  const dbRes = await dbFn().catch(dbParseErrorCallback);
  if (dbRes !== null && dbRes !== undefined) {
    const dbResString = jsonStringify(dbRes);
    await setEntry(keys, dbResString, ttl);
    return dbResString;
  }
  throw new Error(`CACHE_ERROR: ${keys.toString()} not found`);
};

/** `get` for a read whose answer depends on which blocks are canonical. */
export const getOnChain = async (
  keys: CacheKeys,
  dbFn: () => Promise<unknown>,
): Promise<string> => get(await onChainKeys(keys), dbFn);
