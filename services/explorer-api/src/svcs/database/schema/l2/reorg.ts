import { HexString, L2NetworkId } from "@chicmoz-pkg/types";
import {
  bigint,
  index,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { generateBoundedIntegerColumn, l2NetworkIdDbEnum } from "../utils.js";

/**
 * One row per ordered block that demoted canonical blocks: what the explorer
 * had as canonical and removed, not the node's prune depth. `revived_at` is
 * the only later write, set once every listed block is canonical again.
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
    rootHeight: bigint("root_height", { mode: "bigint" }).notNull(),
    rootHash: varchar("root_hash").notNull().$type<HexString>(),
    removedCount: integer("removed_count").notNull(),
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
