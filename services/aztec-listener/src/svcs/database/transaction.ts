import { AsyncLocalStorage } from "node:async_hooks";
import { getDb } from "@chicmoz-pkg/postgres-helper";

type Db = ReturnType<typeof getDb>;

const current = new AsyncLocalStorage<Db>();

/** The enclosing `inTransaction` call's transaction, or the pool outside one. */
export const db = (): Db => current.getStore() ?? getDb();

/**
 * Runs `fn` in one transaction. A call made inside another joins it, so every
 * write through `db()` commits or rolls back with the outermost call.
 */
export const inTransaction = <T>(fn: () => Promise<T>): Promise<T> =>
  current.getStore() !== undefined
    ? fn()
    : getDb().transaction((tx) => current.run(tx, fn));
