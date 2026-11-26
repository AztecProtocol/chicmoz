import { eq, getTableColumns, sql } from "drizzle-orm";
import { L2_NETWORK_ID } from "../../environment.js";
import { heightsTable } from "./schema.js";
import { db } from "./transaction.js";

export async function storeProcessedProposedBlockHeight(height: number) {
  await db()
    .update(heightsTable)
    .set({ processedProposedBlockHeight: height })
    .where(eq(heightsTable.networkId, L2_NETWORK_ID));
}

export async function storeProcessedProvenBlockHeight(height: number) {
  await db()
    .update(heightsTable)
    .set({ processedProvenBlockHeight: height })
    .where(eq(heightsTable.networkId, L2_NETWORK_ID));
}

/** Moves the proven side work's cursor back to `height`; never forward. */
export async function lowerProcessedProvenBlockHeight(height: number) {
  await db()
    .update(heightsTable)
    .set({
      processedProvenBlockHeight: sql`LEAST(${heightsTable.processedProvenBlockHeight}, ${height})`,
    })
    .where(eq(heightsTable.networkId, L2_NETWORK_ID));
}

export async function ensureInitializedBlockHeights() {
  await db()
    .insert(heightsTable)
    .values({
      networkId: L2_NETWORK_ID,
      processedProposedBlockHeight: 0,
      chainProposedBlockHeight: 0,
      processedProvenBlockHeight: 0,
      chainProvenBlockHeight: 0,
    })
    .onConflictDoNothing();
}

export async function getBlockHeights() {
  const result = await db()
    .select(getTableColumns(heightsTable))
    .from(heightsTable)
    .where(eq(heightsTable.networkId, L2_NETWORK_ID))
    .limit(1);
  if (result.length === 0) {
    throw new Error("FATAL: block heights not initialized");
  }
  return result[0];
}
