export type CacheKeys = (string | number | bigint | undefined)[];

/**
 * The deployment namespace, from KAFKA_NAMESPACE. Two deployments of the
 * same L2 network (e.g. two Aztec major versions of testnet) share an
 * L2_NETWORK_ID and, on one host, a Redis; without the namespace they read
 * and write each other's cached responses. Unset, keys are unchanged.
 */
export const parseCacheNamespace = (
  value: string | undefined,
): string | undefined => {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (!/^[a-z0-9]+$/i.test(value)) {
    throw new Error(`KAFKA_NAMESPACE must be alphanumeric, got "${value}"`);
  }
  return value;
};

export const buildCacheKey = (
  keys: CacheKeys,
  networkId: string,
  namespace: string | undefined,
): string =>
  [...(namespace === undefined ? [] : [namespace]), networkId, ...keys].join(
    "-",
  );
