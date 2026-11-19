import { BSON } from "bson";
import { toTagged } from "./format.js";
import { findLeaks, type Leak } from "./sanitize.js";

const binaryPaths = (value: unknown, path: string): string[] => {
  if (value instanceof BSON.Binary) {
    return [path];
  }
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => binaryPaths(v, `${path}[${i}]`));
  }
  return value !== null && typeof value === "object"
    ? Object.values(value).flatMap((v, i) => binaryPaths(v, `${path}.<key ${i}>`))
    : [];
};

/**
 * {@link findLeaks} over a frame's decoded BSON. Frame bytes stay exact, so
 * nothing in them is redacted, and a BSON binary value, which text scanning
 * cannot read, is refused outright, as are bytes that do not re-encode to
 * themselves (a duplicate key, for one, is dropped by decoding).
 */
export const frameLeaks = (
  bson: Uint8Array,
  path: string,
  identity: readonly string[] = [],
): Leak[] => {
  const decoded = BSON.deserialize(bson);
  const again = BSON.serialize(BSON.deserialize(bson, { promoteValues: false }));
  const exact = again.length === bson.length && again.every((b, i) => b === bson[i]);
  return [
    ...(exact ? [] : [{ path, reason: "frame bytes do not round-trip through BSON" }]),
    ...binaryPaths(decoded, path).map((p) => ({ path: p, reason: "binary value in a frame" })),
    ...findLeaks(toTagged(decoded), path, identity),
  ];
};
