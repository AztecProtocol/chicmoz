import pg, { type QueryResultRow } from "pg";

export type PgAccess = {
  host: string;
  port: number;
  user: string;
  password: string;
};

/** A session's statement that waits on a lock another session holds. */
export type Waiter = {
  pid: number;
  database: string;
  waitEventType: string | null;
  query: string;
};

/** Rows of one query in its own session, which ends with it. */
export const queryRows = async <T extends QueryResultRow>(
  access: PgAccess,
  database: string,
  text: string,
  values: unknown[] = [],
): Promise<T[]> => {
  const client = new pg.Client({ ...access, database });
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
  const client = new pg.Client({ ...access, database });
  await client.connect();
  let pid: number;
  try {
    pid = (
      await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0].pid;
    await client.query("BEGIN");
    const { rowCount } = await client.query(lockQuery, values);
    if (!rowCount) {
      throw new Error(`no row to lock: ${lockQuery}`);
    }
  } catch (e) {
    await client.end();
    throw e;
  }

  /** The sessions waiting on this one's locks, whatever their database. */
  const waiters = async (): Promise<Waiter[]> =>
    (
      await client.query<{
        pid: number;
        datname: string;
        wait_event_type: string | null;
        query: string;
      }>(
        "SELECT pid, datname, wait_event_type, query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
        [pid],
      )
    ).rows.map((r) => ({
      pid: r.pid,
      database: r.datname,
      waitEventType: r.wait_event_type,
      query: r.query,
    }));

  let released = false;
  return {
    waiters,
    /**
     * Ends another session, so its open transaction rolls back and its
     * waiting statement never runs; resolves once that session is gone.
     */
    terminate: async (other: number) => {
      const { rows } = await client.query<{ ended: boolean }>(
        "SELECT pg_terminate_backend($1, 5000) AS ended",
        [other],
      );
      if (!rows[0]?.ended) {
        throw new Error(`session ${other} did not end`);
      }
    },
    /** Ends the lock's session; a second call does nothing. */
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      try {
        await client.query("ROLLBACK");
      } finally {
        await client.end();
      }
    },
  };
};

export type RowLock = Awaited<ReturnType<typeof lockRows>>;
