import type { L2BlockTag } from "@aztec-labs/stdlib/block";
import { generateAztecAddressColumn } from "@chicmoz-pkg/backend-utils";
import { HexString } from "@chicmoz-pkg/types";
import { sql } from "drizzle-orm";
import {
  bigint,
  integer,
  pgTable,
  primaryKey,
  varchar,
} from "drizzle-orm/pg-core";

export const generateTimestampColumn = (name: string) =>
  bigint(name, { mode: "number" });

export const heightsTable = pgTable("heights", {
  networkId: varchar("networkId").primaryKey().notNull(),
  processedProposedBlockHeight: integer(
    "processedProposedBlockHeight",
  ).notNull(),
  chainProposedBlockHeight: integer("chainProposedBlockHeight").notNull(),
  processedProvenBlockHeight: integer("processedProvenBlockHeight").notNull(),
  chainProvenBlockHeight: integer("chainProvenBlockHeight").notNull(),
});

export const txStateValues = [
  "pending",
  "suspected_dropped",
  "dropped",
  "proposed",
  "proven",
] as const;
export type TxState = (typeof txStateValues)[number];

export const txsTable = pgTable("txs_table", {
  txHash: varchar("tx_hash").notNull().$type<HexString>().primaryKey(),
  feePayer: generateAztecAddressColumn("fee_payer").notNull(),
  // The outermost initiator of the tx (msgSender of first non-revertible public call).
  // NULL for private-only txs.
  initiator: generateAztecAddressColumn("initiator").$type<string | undefined>(),
  // Comma-separated list of unique msgSender addresses from all public call requests,
  // excluding feePayer and initiator. NULL when there are no additional senders.
  additionalMsgSenders: varchar("additional_msg_senders").$type<string | undefined>(),
  birthTimestamp: generateTimestampColumn("birth_timestamp")
    .notNull()
    .default(sql`EXTRACT(EPOCH FROM NOW()) * 1000`),
  txState: varchar("tx_state").notNull().$type<TxState>(),
});

export const l2BlockStreamTipTable = pgTable(
  "l2_block_stream_tip",
  {
    rollupVersion: bigint("rollup_version", { mode: "number" }).notNull(),
    tag: varchar("tag").notNull().$type<L2BlockTag>(),
    blockNumber: integer("block_number").notNull(),
    checkpointNumber: integer("checkpoint_number"),
    checkpointHash: varchar("checkpoint_hash"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.rollupVersion, t.tag] }),
  }),
);

export const l2BlockStreamHashTable = pgTable(
  "l2_block_stream_hash",
  {
    rollupVersion: bigint("rollup_version", { mode: "number" }).notNull(),
    blockNumber: integer("block_number").notNull(),
    blockHash: varchar("block_hash").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.rollupVersion, t.blockNumber] }),
  }),
);
