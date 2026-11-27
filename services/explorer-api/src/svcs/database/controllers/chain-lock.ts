import { getDb as db } from "@chicmoz-pkg/postgres-helper";
import { sql } from "drizzle-orm";
import { L2_NETWORK_ID } from "../../../environment.js";
import { type DbTx } from "./utils.js";

const LOCK_NAMESPACE = 1_815_307_112;

/**
 * Runs `fn` in one transaction that first takes the network's chain lock.
 * Every chain change takes it, and so does every write that depends on
 * which blocks are canonical: the dropped- and pending-tx handlers, the
 * start-up sweep and the tips. `lock_timeout` bounds every lock wait in the
 * transaction, this one included: a wait over 10 s throws, so the message is
 * redelivered.
 */
export const withChainLock = <T>(fn: (dbTx: DbTx) => Promise<T>): Promise<T> =>
  db().transaction(async (dbTx) => {
    await dbTx.execute(sql`SET LOCAL lock_timeout = '10s'`);
    await dbTx.execute(
      sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}::int4, hashtext(${L2_NETWORK_ID}))`,
    );
    return fn(dbTx);
  });
