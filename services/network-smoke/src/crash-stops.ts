import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { L2Block } from "@aztec-labs/stdlib/block";
import { BSON } from "bson";
import { z } from "zod";
import { type BrokerReads } from "./broker.js";
import {
  type PgAccess,
  type RowLock,
  type Waiter,
  lockRows,
  queryRows,
} from "./row-lock.js";
import { type BlockId } from "./script-control.js";
import { type serviceControl } from "./service-control.js";

type Services = ReturnType<typeof serviceControl>;

// A service that reaches its stop does so within a few of the listener's 1 s
// polls; a service that never does fails its scenario after this.
const STOP_WAIT_MS = 15_000;
// A restarted service's consumers join their groups only once the killed
// member's 30 s session has run out, and the listener polls only after that.
const RECOVERY_WAIT_MS = 120_000;

// What the listener's store and the API's post-commit step send for the row
// each scenario locks; Drizzle writes them as upserts.
const LISTENER_WRITE = /^insert into "l2_block_stream_hash"/i;
const API_WRITE = /^insert into "l2_rollup_version_observation"/i;

/** The waiting write a stop caught, as `pg_stat_activity` showed it. */
export type CaughtWrite = { database: string; statement: string };

/** Offsets `[from, to)` of one partition. */
export type OffsetRange = { partition: number; from: number; to: number };

/** The partitions whose end offset moved between two reads, with the offsets they moved over. */
const grown = (before: Map<number, number>, after: Map<number, number>) =>
  [...after.entries()]
    .filter(([partition, end]) => end !== before.get(partition))
    .map(
      ([partition, to]): OffsetRange => ({
        partition,
        from: before.get(partition) ?? 0,
        to,
      }),
    );

/** `read`'s first defined value, or undefined once `timeoutMs` passed without one. */
const poll = async <T>(
  read: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 100,
) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined || Date.now() >= deadline) {
      return value;
    }
    await sleep(intervalMs);
  }
};

const until = async <T>(
  read: () => Promise<T | undefined>,
  timeoutMs: number,
  what: string,
) => {
  const value = await poll(read, timeoutMs, 250);
  if (value === undefined) {
    throw new Error(`no ${what} within ${timeoutMs / 1000} s`);
  }
  return value;
};

/** The sessions of `database` whose `write` waits on `lock`. */
const writesWaiting = async (lock: RowLock, database: string, write: RegExp) =>
  (await lock.waiters()).filter(
    (w) =>
      w.database === database &&
      w.waitEventType === "Lock" &&
      write.test(w.query),
  );

const caughtWrite = ({ database, query }: Waiter): CaughtWrite => ({
  database,
  statement: query.split("(")[0].trim(),
});

const missedStop = async (
  lock: RowLock,
  writer: string,
  withinMs: number,
  more = {},
) =>
  `the lock held up no write of the ${writer} within ${withinMs / 1000} s (${JSON.stringify({ waiting: await lock.waiters(), ...more })})`;

/**
 * Kills `name` and ends every session of `database` that `lock` holds up:
 * a session waiting on a lock never sees its client go, and an autocommit
 * write queued there would commit once the lock is released.
 */
const killWaiting = async (
  lock: RowLock,
  database: string,
  services: Services,
  name: string,
) => {
  await services.kill(name);
  const ofService = async () =>
    (await lock.waiters()).filter((w) => w.database === database);
  for (const w of await ofService()) {
    await lock.terminate(w.pid);
  }
  const left = await ofService();
  if (left.length > 0) {
    throw new Error(
      `${name}'s sessions still wait on the lock after the kill: ${JSON.stringify(left)}`,
    );
  }
};

/** `killWaiting`, then releases `lock` and starts `name` again. Resolves with when it started. */
const crash = async (
  lock: RowLock,
  database: string,
  services: Services,
  name: string,
) => {
  await killWaiting(lock, database, services, name);
  await lock.release();
  const restartedAt = Date.now();
  await services.start(name);
  return restartedAt;
};

// The message bus's envelope: BSON of `{ data: <message> }`.
const blockRecordSchema = z.object({
  data: z.object({
    blockNumber: z.number(),
    block: z.string(),
    ordered: z.object({ tip: z.number() }).optional(),
  }),
});

/** A block record, as a scenario compares two copies of one. */
const blockRecord = async (
  { offset, key, value }: { offset: number; key?: Buffer; value?: Buffer },
  sentBeforeKill: boolean,
) => {
  const document: unknown = BSON.deserialize(value ?? Buffer.alloc(0));
  const event = blockRecordSchema.parse(document).data;
  const block = L2Block.fromBuffer(Buffer.from(event.block, "hex"));
  return {
    offset,
    key: key?.toString(),
    height: event.blockNumber,
    tip: event.ordered?.tip,
    hash: (await block.hash()).toString().toLowerCase(),
    sentBeforeKill,
  };
};

export type ListenerStop = {
  /** Why nothing was crashed; absent once the listener was. */
  missed?: string;
  waiting?: CaughtWrite;
  /** What the batch had put on the topic, and what the listener's store held, at the stop; the kill needs both as expected. */
  atKill?: {
    sent: OffsetRange[];
    store: { proposed: number | null; hash: string | null };
  };
  /** The block records sent from the prune on, read once the restarted listener stored the batch. */
  records?: Awaited<ReturnType<typeof blockRecord>>[];
  /** From the restart to the restarted listener's store holding the batch. */
  recoveryMs?: number;
};

/**
 * Kills the listener between sending a batch and storing it. `arm` locks the
 * listener store's hash row at the first dead height, which the prune leaves
 * as it is and the replacing batch's store writes first; only that store
 * writes the row. `fire`, once the node has pruned, waits for that write to
 * wait on the lock, kills the listener, so the write's transaction never
 * commits, and starts it again.
 */
export const listenerStop = ({
  pg,
  database,
  broker,
  blockTopic,
  services,
}: {
  pg: PgAccess;
  database: string;
  broker: BrokerReads;
  blockTopic: string;
  services: Services;
}) => {
  const result: ListenerStop = {};
  let armed:
    | { lock: RowLock; before: Map<number, number>; first: BlockId }
    | undefined;
  const store = async (height: number) => {
    const [row] = await queryRows<{
      proposed: number | null;
      hash: string | null;
    }>(
      pg,
      database,
      `SELECT (SELECT block_number FROM l2_block_stream_tip WHERE tag = 'proposed') AS proposed,
              (SELECT block_hash FROM l2_block_stream_hash WHERE block_number = $1) AS hash`,
      [height],
    );
    return { proposed: row.proposed, hash: row.hash?.toLowerCase() ?? null };
  };
  return {
    result,
    /** Before the prune, once the store holds `dead`. */
    arm: async (dead: BlockId[]) => {
      const [first] = dead;
      try {
        await until(
          async () => {
            const held = await store(first.height);
            return held.proposed === dead.at(-1)?.height &&
              held.hash === first.hash.toLowerCase()
              ? held
              : undefined;
          },
          30_000,
          "listener store holding the dead blocks",
        );
      } catch (e) {
        result.missed = `the listener's block stream store: ${(e as Error).message}`;
        return;
      }
      const before = await broker.endOffsets(blockTopic);
      armed = {
        lock: await lockRows(
          pg,
          database,
          "SELECT 1 FROM l2_block_stream_hash WHERE block_number = $1 FOR UPDATE",
          [first.height],
        ),
        before,
        first,
      };
    },
    /** Once the node serves the prune, whose replacing batch starts with `replacing`. */
    fire: async (replacing: BlockId) => {
      if (armed === undefined) {
        return;
      }
      const { lock, before, first } = armed;
      try {
        const waiting = await poll(async () => {
          const [write] = await writesWaiting(lock, database, LISTENER_WRITE);
          return write;
        }, STOP_WAIT_MS);
        if (waiting === undefined) {
          result.missed = await missedStop(
            lock,
            "listener's store",
            STOP_WAIT_MS,
          );
          return;
        }
        result.waiting = caughtWrite(waiting);
        const atKill = await broker.endOffsets(blockTopic);
        result.atKill = {
          sent: grown(before, atKill),
          store: await store(first.height),
        };
        // The batch's one record is on the topic, and the store is still on
        // the prune's target, with the dead block at the height it writes.
        const expected = {
          sent: [1],
          store: { proposed: first.height - 1, hash: first.hash.toLowerCase() },
        };
        const seen = {
          sent: result.atKill.sent.map((r) => r.to - r.from),
          store: result.atKill.store,
        };
        if (!isDeepStrictEqual(seen, expected)) {
          result.missed = `the state at the stop is not ${JSON.stringify(expected)}`;
          return;
        }
        const restartedAt = await crash(
          lock,
          database,
          services,
          "aztec-listener",
        );
        await until(
          async () =>
            (await store(replacing.height)).hash ===
            replacing.hash.toLowerCase()
              ? true
              : undefined,
          RECOVERY_WAIT_MS,
          "replacing block in the restarted listener's store",
        );
        result.recoveryMs = Date.now() - restartedAt;
        const sentSince = grown(before, await broker.endOffsets(blockTopic));
        result.records = await Promise.all(
          (
            await Promise.all(
              sentSince.map(async (range) =>
                (
                  await broker.recordsOf(blockTopic, range.partition, range)
                ).map((record) => ({
                  record,
                  beforeKill:
                    record.offset < (atKill.get(range.partition) ?? 0),
                })),
              ),
            )
          )
            .flat()
            .map(({ record, beforeKill }) => blockRecord(record, beforeKill)),
        );
      } finally {
        await lock.release();
      }
    },
  };
};

type Committed = Record<string, (number | undefined)[]>;

/** The block handler's upsert, held up by the lock, as a stop proved it (see `apiStop`). */
export type HeldUp = {
  waiting: CaughtWrite;
  /** The API's upserts the lock held up. */
  writesWaiting: number;
  /** The API's other groups that had not committed a record. */
  othersBehind: string[];
};

export type ApiStop = {
  /** Why nothing was crashed; absent once the API was. */
  missed?: string;
  held?: HeldUp;
  /**
   * At the stop: whether the replacing block and the dead blocks are
   * canonical in the API's database, what the batch put on the topic, and
   * the API groups' committed offsets on the partitions it went to. The kill
   * needs all three as expected.
   */
  atKill?: {
    canonical: { replacing?: boolean; dead: (boolean | undefined)[] };
    sent: OffsetRange[];
    committed: Committed;
  };
  /** Why the restarted API was not seen handling the record again; absent once it was. */
  replayMissed?: string;
  /** The restarted API's block handler held up at the same upsert, and the committed offsets then. */
  replay?: HeldUp & { committed: Committed };
  /** The same offsets once the lock was released and the restarted API committed past the batch. */
  afterRestart?: { committed: Committed };
  /** From the restart to that commit. */
  recoveryMs?: number;
};

/**
 * Kills the API after a block's chain change commits and before its offset
 * does. `arm`, once every API group has committed through the topic's end,
 * locks the API's rollup-version observation rows, which the block handler
 * upserts after the commit; the run's database holds its network's alone.
 * `fire`, once the node has pruned, waits for that upsert to be held up by
 * the lock, kills the API and starts it again with the lock still held, so
 * the restarted API's block handler stops at the same upsert while the
 * record is still uncommitted; then it releases the lock.
 */
export const apiStop = ({
  pg,
  database,
  apiGroupPrefix,
  broker,
  blockTopic,
  services,
}: {
  pg: PgAccess;
  database: string;
  apiGroupPrefix: string;
  broker: BrokerReads;
  blockTopic: string;
  services: Services;
}) => {
  const result: ApiStop = {};
  let armed: { lock: RowLock; before: Map<number, number> } | undefined;
  const canonical = async (hash: string) => {
    const [row] = await queryRows<{ canonical: boolean }>(
      pg,
      database,
      `SELECT orphan_timestamp IS NULL AS canonical FROM "l2Block" WHERE lower(hash) = lower($1)`,
      [hash],
    );
    return row?.canonical;
  };
  const committedOn = async (partitions: number[]): Promise<Committed> =>
    Object.fromEntries(
      [...(await broker.apiCommitted(blockTopic)).entries()].map(
        ([group, offsets]) => [
          group.slice(apiGroupPrefix.length),
          partitions.map((p) => offsets.get(p)),
        ],
      ),
    );
  /**
   * The API's chain-info and node-info handlers upsert the row too, each
   * holding a record its group cannot commit while the row is locked, and a
   * group handles one record at a time: more upserts held up, on the lock or
   * queued behind one another, than other groups behind means one is the
   * block handler's. Waiters are read before the groups, so none of them is
   * missed.
   */
  const blockHandlerHeldUp = async (
    lock: RowLock,
    timeoutMs: number,
  ): Promise<{ held?: HeldUp; othersBehind: string[] }> => {
    let othersBehind: string[] = [];
    const writes = await poll(async () => {
      const held = await writesWaiting(lock, database, API_WRITE);
      if (held.length === 0) {
        return undefined;
      }
      othersBehind = await broker.apiGroupsBehind(blockTopic);
      return held.length > othersBehind.length ? held : undefined;
    }, timeoutMs);
    return {
      held: writes && {
        waiting: caughtWrite(writes[0]),
        writesWaiting: writes.length,
        othersBehind,
      },
      othersBehind,
    };
  };
  return {
    result,
    /** Before the prune. */
    arm: async () => {
      await broker.apiConsumedThrough(30_000);
      const before = await broker.endOffsets(blockTopic);
      armed = {
        lock: await lockRows(
          pg,
          database,
          "SELECT 1 FROM l2_rollup_version_observation FOR UPDATE",
        ),
        before,
      };
    },
    /** Once the node serves the prune, whose replacing block is `replacing`. */
    fire: async (replacing: BlockId, dead: BlockId[]) => {
      if (armed === undefined) {
        return;
      }
      const { lock, before } = armed;
      try {
        const stopped = await blockHandlerHeldUp(lock, STOP_WAIT_MS);
        if (stopped.held === undefined) {
          result.missed = await missedStop(
            lock,
            "API's block handler",
            STOP_WAIT_MS,
            { othersBehind: stopped.othersBehind },
          );
          return;
        }
        result.held = stopped.held;
        const sent = grown(before, await broker.endOffsets(blockTopic));
        const partitions = sent.map((r) => r.partition);
        result.atKill = {
          canonical: {
            replacing: await canonical(replacing.hash),
            dead: await Promise.all(dead.map((b) => canonical(b.hash))),
          },
          sent,
          committed: await committedOn(partitions),
        };
        // The batch's one record is on the topic, its chain change is
        // committed, and every API group on that partition is still before it.
        const [range] = sent;
        const groups = Object.values(result.atKill.committed);
        if (
          sent.length !== 1 ||
          range.to - range.from !== 1 ||
          !isDeepStrictEqual(result.atKill.canonical, {
            replacing: true,
            dead: dead.map(() => false),
          }) ||
          groups.length === 0 ||
          !groups.every((offsets) => isDeepStrictEqual(offsets, [range.from]))
        ) {
          result.missed =
            "the state at the stop is not one record sent, committed in the database and not by any group";
          return;
        }
        await killWaiting(lock, database, services, "explorer-api");
        const restartedAt = Date.now();
        await services.start("explorer-api");
        const replayed = await blockHandlerHeldUp(lock, RECOVERY_WAIT_MS);
        if (replayed.held === undefined) {
          result.replayMissed = await missedStop(
            lock,
            "restarted API's block handler",
            RECOVERY_WAIT_MS,
            { othersBehind: replayed.othersBehind },
          );
          return;
        }
        result.replay = {
          ...replayed.held,
          committed: await committedOn(partitions),
        };
        await lock.release();
        result.afterRestart = {
          committed: await until(
            async () => {
              const committed = await committedOn(partitions);
              const groups = Object.values(committed);
              return groups.length > 0 &&
                groups.every((offsets) =>
                  offsets.every((o, i) => o !== undefined && o >= sent[i].to),
                )
                ? committed
                : undefined;
            },
            RECOVERY_WAIT_MS,
            "commit by the restarted API past the batch",
          ),
        };
        result.recoveryMs = Date.now() - restartedAt;
      } finally {
        await lock.release();
      }
    },
  };
};
