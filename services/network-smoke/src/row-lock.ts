import pg, { type QueryResultRow } from "pg";

export type PgAccess = {
  host: string;
  port: number;
  user: string;
  password: string;
};

/** A session's statement that waits on a lock: one another session holds, or one queued behind such a waiter. */
export type Waiter = {
  pid: number;
  database: string;
  waitEventType: string | null;
  query: string;
};

/**
 * The sessions `root` holds up, directly or behind another session it holds
 * up, from each waiting session's `pg_blocking_pids`. That names direct
 * blockers only: a write queued for a row lock that another waiter took
 * first names that waiter, not `root`.
 */
export const blockedBy = (
  root: number,
  waiting: { pid: number; blockers: number[] }[],
) => {
  const chain = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const { pid, blockers } of waiting) {
      if (!chain.has(pid) && blockers.some((b) => chain.has(b))) {
        chain.add(pid);
        grew = true;
      }
    }
  }
  chain.delete(root);
  return chain;
};

// A harness statement that stalls, a lock wait included, fails the step it
// serves instead of holding it until the test's timeout.
const session = (access: PgAccess, database: string) =>
  new pg.Client({ ...access, database, statement_timeout: 10_000 });

/** Rows of one query in its own session, which ends with it. */
export const queryRows = async <T extends QueryResultRow>(
  access: PgAccess,
  database: string,
  text: string,
  values: unknown[] = [],
): Promise<T[]> => {
  const client = session(access, database);
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
};

/**
 * Takes the row locks `lockQuery` (a `SELECT … FOR UPDATE`) takes, in a
 * session of the harness's own, and holds them until `release`. Another
 * session's write to a locked row then waits, mid-statement and, inside a
 * transaction, uncommitted. Throws if the query locks no row.
 */
export const lockRows = async (
  access: PgAccess,
  database: string,
  lockQuery: string,
  values: unknown[] = [],
) => {
  const client = session(access, database);
  // Inside a transaction, pg_stat_activity shows each session's query as it
  // was at the transaction's first read of it, so the waiters are read from
  // a session that holds none open.
  const watcher = session(access, database);
  let pid: number;
  try {
    await client.connect();
    await watcher.connect();
    pid = (
      await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0].pid;
    await client.query("BEGIN");
    const { rowCount } = await client.query(lockQuery, values);
    if (!rowCount) {
      throw new Error(`no row to lock: ${lockQuery}`);
    }
  } catch (e) {
    await Promise.allSettled([client.end(), watcher.end()]);
    throw e;
  }

  /** The sessions this one's locks hold up (`blockedBy`), whatever their database. */
  const waiters = async (): Promise<Waiter[]> => {
    const { rows } = await watcher.query<{
      pid: number;
      datname: string;
      wait_event_type: string | null;
      query: string;
      blockers: number[];
    }>(
      "SELECT pid, datname, wait_event_type, query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE wait_event_type = 'Lock'",
    );
    const chain = blockedBy(pid, rows);
    return rows
      .filter((r) => chain.has(r.pid))
      .map((r) => ({
        pid: r.pid,
        database: r.datname,
        waitEventType: r.wait_event_type,
        query: r.query,
      }));
  };

  let released = false;
  return {
    waiters,
    /**
     * Ends another session, so its open transaction rolls back and its
     * waiting statement never runs; resolves once that session is gone.
     */
    terminate: async (other: number) => {
      const { rows } = await watcher.query<{ ended: boolean }>(
        "SELECT pg_terminate_backend($1, 5000) AS ended",
        [other],
      );
      if (!rows[0]?.ended) {
        throw new Error(`session ${other} did not end`);
      }
    },
    /** Ends the lock's sessions; a second call does nothing. */
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      try {
        await client.query("ROLLBACK");
      } finally {
        await Promise.allSettled([client.end(), watcher.end()]);
      }
    },
  };
};

export type RowLock = Awaited<ReturnType<typeof lockRows>>;
