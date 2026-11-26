import { z } from "zod";

const blockIdSchema = z.object({ height: z.number().int(), hash: z.string() });

/** What the explorer must end up serving, as the scripted node built it. */
export const scriptFactsSchema = z.object({
  states: z.array(z.string()),
  /** Index of the first state that serves the replacing chain. */
  pruneAt: z.number().int(),
  /** Blocks 7–10 as the node served them before the prune. */
  dead: z.array(blockIdSchema),
  /** Blocks 1–12′ of the last state. */
  final: z.array(blockIdSchema),
  /** In a dead block and again in the replacing chain; it deploys `contractAddress`. */
  movedTx: z.object({
    hash: z.string(),
    deadHeight: z.number().int(),
    finalHeight: z.number().int(),
  }),
  contractAddress: z.string(),
});

export type ScriptFacts = z.infer<typeof scriptFactsSchema>;
export type BlockId = z.infer<typeof blockIdSchema>;

export const scriptStatusSchema = scriptFactsSchema.extend({
  current: z.number().int(),
  /** `getChainTips` and `getBlockNumber` calls served so far: the listener's polls. */
  tipReads: z.number().int(),
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
