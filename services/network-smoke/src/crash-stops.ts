import { setTimeout as sleep } from "node:timers/promises";
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

// What the listener's store sends for the row the scenario locks; Drizzle
// writes it as an upsert.
const LISTENER_WRITE = /^insert into "l2_block_stream_hash"/i;

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

const missedStop = async (lock: RowLock, writer: string) =>
  `no write of the ${writer} waited on the lock within ${STOP_WAIT_MS / 1000} s (waiting: ${JSON.stringify(await lock.waiters())})`;

/**
 * Kills `name`, ends its sessions that wait on `lock`, which would never see
 * their client go and would run their statements once it is released, then
 * releases it and starts `name` again. Resolves with when it started.
 */
const crash = async (
  lock: RowLock,
  database: string,
  services: Services,
  name: string,
) => {
  await services.kill(name);
  for (const w of await lock.waiters()) {
    if (w.database === database) {
      await lock.terminate(w.pid);
    }
  }
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
  /** What the batch had put on the topic, and what the listener's store held, at the kill. */
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
  let armed: { lock: RowLock; before: Map<number, number> } | undefined;
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
      };
    },
    /** Once the node serves the prune, whose replacing batch starts with `replacing`. */
    fire: async (replacing: BlockId) => {
      if (armed === undefined) {
        return;
      }
      const { lock, before } = armed;
      try {
        const waiting = await poll(async () => {
          const [write] = await writesWaiting(lock, database, LISTENER_WRITE);
          return write;
        }, STOP_WAIT_MS);
        if (waiting === undefined) {
          result.missed = await missedStop(lock, "listener's store");
          return;
        }
        result.waiting = caughtWrite(waiting);
        const atKill = await broker.endOffsets(blockTopic);
        result.atKill = {
          sent: grown(before, atKill),
          store: await store(replacing.height),
        };
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
