import { getDb as db } from "@chicmoz-pkg/postgres-helper";
import { sql } from "drizzle-orm";
import { L2_NETWORK_ID } from "../../../environment.js";
import { type DbTx } from "./utils.js";

const LOCK_NAMESPACE = 1_815_307_112;

/**
 * Runs `fn` in one transaction that takes the network's chain lock before
 * any other: every write that depends on which blocks are canonical takes
 * it first, so those writers queue on it rather than deadlock over rows.
 * `lock_timeout` bounds every lock wait in the transaction, this one
 * included: a wait over 10 s throws.
 */
export const withChainLock = <T>(fn: (dbTx: DbTx) => Promise<T>): Promise<T> =>
  db().transaction(async (dbTx) => {
    await dbTx.execute(sql`SET LOCAL lock_timeout = '10s'`);
    await dbTx.execute(
      sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}::int4, hashtext(${L2_NETWORK_ID}))`,
    );
    return fn(dbTx);
  });
