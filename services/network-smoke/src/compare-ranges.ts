/** Heights `from` through `to`. */
export type HeightRange = { from: number; to: number };

/**
 * The heights each one-shot check of `scripts/compare-chain.ts` compares:
 * `sample` the API's top 40, `window` the node's finalized tip to its
 * proposed tip. The script imports nothing from this package, so this
 * restates it; a scenario checks it against the range each check prints.
 */
export const checkRanges = ({
  apiLatest,
  nodeFinalized,
  nodeProposed,
}: {
  apiLatest: number;
  nodeFinalized: number;
  nodeProposed: number;
}) => ({
  sample: { from: Math.max(1, apiLatest - 39), to: apiLatest },
  window: { from: Math.max(1, nodeFinalized), to: nodeProposed },
});

/** The lowest height in `range` where the API's canonical hash is not the node's, a missing one included. */
export const firstMismatch = (
  { from, to }: HeightRange,
  api: Map<number, string>,
  node: Map<number, string>,
) => {
  for (let height = from; height <= to; height++) {
    if (api.get(height) !== node.get(height)) {
      return height;
    }
  }
  return undefined;
};
