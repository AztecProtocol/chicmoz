import { getDb as db } from "@chicmoz-pkg/postgres-helper";
import { and, eq, notExists, sql } from "drizzle-orm";
import { type AnyPgColumn, type PgTable, alias } from "drizzle-orm/pg-core";

type L1LogTable<K extends string> = PgTable &
  Record<K | "isFinalized", AnyPgColumn>;

/**
 * Every row of an L1 log table except a pending copy whose finalized copy is
 * stored, so each log is listed once, from when it is first seen. `identity`
 * is the unique key without `isFinalized`; a row with a NULL in it has no copy
 * to match and is kept. One NOT EXISTS rather than `isFinalized OR NOT EXISTS`:
 * Postgres plans it as an anti-join, which can probe the unique index.
 */
export const oncePerL1Log = <K extends string>(
  table: L1LogTable<K>,
  identity: readonly K[],
) => {
  const finalizedCopy = alias(table, "finalized_copy") as unknown as L1LogTable<K>;
  return notExists(
    db()
      .select({ one: sql`1` })
      .from(finalizedCopy)
      .where(
        and(
          eq(table.isFinalized, false),
          ...identity.map((column) => eq(finalizedCopy[column], table[column])),
          eq(finalizedCopy.isFinalized, true),
        ),
      ),
  );
};
