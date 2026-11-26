import { z } from "zod";

const blockIdSchema = z.object({ height: z.number().int(), hash: z.string() });

const pruneFactsSchema = z.object({
  /** Index of the first state without the dead blocks. */
  pruneAt: z.number().int(),
  /** States from `pruneAt` on that serve the shorter chain, whose tip is the prune target, before the replacing block. */
  shorterSteps: z.number().int(),
  /** Index of the state where the replacing chain has grown to its end. */
  endAt: z.number().int(),
  /** The pruned blocks, as the node served them before the prune. */
  dead: z.array(blockIdSchema),
  /** Every block the node serves at `endAt`. */
  final: z.array(blockIdSchema),
  /** In a dead block and again in the replacing chain. */
  movedTx: z.object({
    hash: z.string(),
    deadHeight: z.number().int(),
    finalHeight: z.number().int(),
  }),
});

/** What the explorer must end up serving, as the scripted node built it. */
export const scriptFactsSchema = z.object({
  states: z.array(z.string()),
  /** First a prune whose replacing block is there at once, then one that serves the shorter chain first. */
  prunes: z.tuple([pruneFactsSchema, pruneFactsSchema]),
  /** Deployed by the first prune's moved tx. */
  contractAddress: z.string(),
});

export type ScriptFacts = z.infer<typeof scriptFactsSchema>;
export type PruneFacts = z.infer<typeof pruneFactsSchema>;
export type BlockId = z.infer<typeof blockIdSchema>;

export const scriptStatusSchema = scriptFactsSchema.extend({
  current: z.number().int(),
  /** `getChainTips` and `getBlockNumber` calls served so far: the listener's polls. */
  tipReads: z.number().int(),
  /** Reads of the proposed tip answered in the current state. */
  stateReads: z.number().int(),
});

export type ScriptStatus = z.infer<typeof scriptStatusSchema>;

const stepSchema = z.object({ current: z.number().int(), label: z.string() });

/** The scripted node's control port: read the script, move to the next state. */
export const scriptControl = (controlUrl: string) => {
  const call = async (path: string, method: "GET" | "POST") => {
    const res = await fetch(new URL(path, controlUrl), {
      method,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as unknown;
  };
  return {
    status: async () => scriptStatusSchema.parse(await call("/script", "GET")),
    step: async () => stepSchema.parse(await call("/script/step", "POST")),
  };
};
