import { z } from "zod";
import { hexStringSchema } from "../general.js";

export const chicmozReorgSchema = z
  .object({
    orphanedBlockHash: hexStringSchema.describe(
      "The lowest of the record's blocks that are still orphaned.",
    ),
    height: z.coerce.bigint().nonnegative(),
    timestamp: z.coerce.date(),
    nbrOfOrphanedBlocks: z
      .number()
      .int()
      .nonnegative()
      .describe("How many of the record's blocks are still orphaned."),
  })
  .describe(
    "One chain change that orphaned canonical blocks. Its count and lowest block cover only the blocks still orphaned, and the record disappears once all its blocks are back on the chain.",
  );

export type ChicmozReorg = z.infer<typeof chicmozReorgSchema>;
