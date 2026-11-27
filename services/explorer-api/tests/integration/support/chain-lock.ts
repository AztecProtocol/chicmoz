/**
 * Probes of the network's chain lock on a test file's database. Call after
 * startExplorerApiForTest, like any explorer-api import.
 */
export const loadChainLockProbes = async () => {
  const { getDb } = await import("@chicmoz-pkg/postgres-helper");
  const { sql } = await import("drizzle-orm");
  const { withChainLock } = await import(
    "../../../src/svcs/database/controllers/chain-lock.js"
  );
  const db = getDb();

  /** Takes the chain lock and holds it until the returned release is awaited. */
  const holdChainLock = async () => {
    let release: () => void = () => undefined;
    let held: Promise<void> = Promise.resolve();
    await new Promise<void>((locked) => {
      held = withChainLock(() => {
        locked();
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      });
    });
    return async () => {
      release();
      await held;
    };
  };

  // Lock requests waiting in this file's database, where the chain lock is
  // the only advisory lock taken.
  const lockWaiters = async () => {
    const { rows } = await db.execute<{ waiting: number }>(
      sql`SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    );
    return rows[0]?.waiting ?? 0;
  };

  /** Resolves once `count` requests wait on the lock; throws after 5 s. */
  const untilLockWaiters = async (count: number, what: string) => {
    const deadline = Date.now() + 5_000;
    while ((await lockWaiters()) < count) {
      if (Date.now() > deadline) {
        throw new Error(`${what} never waited on the chain lock`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  return { holdChainLock, untilLockWaiters };
};
