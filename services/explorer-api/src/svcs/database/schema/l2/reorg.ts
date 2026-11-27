import { HexString, L2NetworkId } from "@chicmoz-pkg/types";
import {
  bigint,
  index,
  pgTable,
  primaryKey,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { generateBoundedIntegerColumn, l2NetworkIdDbEnum } from "../utils.js";

/** The stream the block whose application wrote a reorg record came on. */
export type ReorgCauseKind = "ordered" | "catchup";

/**
 * One row per applied block, ordered or catch-up, that demoted canonical
 * blocks: what the explorer had as canonical and removed, not the node's
 * prune depth. `cause_hash` is that block's hash. `revived_at` is the only
 * later write, set once every listed block is canonical again.
 */
export const l2ReorgTable = pgTable(
  "l2_reorg",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    l2NetworkId: l2NetworkIdDbEnum("l2_network_id")
      .notNull()
      .$type<L2NetworkId>(),
    rollupVersion: generateBoundedIntegerColumn("rollup_version").notNull(),
    causeHash: varchar("cause_hash").notNull().$type<HexString>(),
    causeKind: varchar("cause_kind").notNull().$type<ReorgCauseKind>(),
    observedAt: timestamp("observed_at").notNull(),
    revivedAt: timestamp("revived_at"),
  },
  (t) => ({
    networkObservedIdx: index("l2_reorg_network_observed_idx").on(
      t.l2NetworkId,
      t.observedAt.desc(),
    ),
  }),
);

export const l2ReorgBlockTable = pgTable(
  "l2_reorg_block",
  {
    reorgId: bigint("reorg_id", { mode: "number" })
      .notNull()
      .references(() => l2ReorgTable.id, { onDelete: "cascade" }),
    height: bigint("height", { mode: "bigint" }).notNull(),
    hash: varchar("hash").notNull().$type<HexString>(),
  },
  (t) => ({
    pk: primaryKey({
      name: "l2_reorg_block_pkey",
      columns: [t.reorgId, t.hash],
    }),
    hashIdx: index("l2_reorg_block_hash_idx").on(t.hash),
  }),
);
