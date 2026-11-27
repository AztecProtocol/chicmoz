import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { AssignerProtocol, Kafka, logLevel } from "kafkajs";
import { z } from "zod";

export const brokerAccessSchema = z.object({
  brokers: z.string(),
  username: z.string(),
  password: z.string(),
  /** The block topic, under the run's namespace. */
  blockTopic: z.string(),
  /** The listener's tips topic, under the run's namespace. */
  tipsTopic: z.string(),
  /** Every consumer group of the explorer API starts with it. */
  apiGroupPrefix: z.string(),
});

export type BrokerAccess = z.infer<typeof brokerAccessSchema>;

/** A partition a group is assigned, and its end offset when it was read. */
type Mark = {
  group: string;
  topic: string;
  partition: number;
  low: number;
  end: number;
};

/** A consumer group, and each partition of the topics it has committed on or is assigned: the offset it committed there (-1 for none), and the partition's low and end offsets. */
export type GroupOffsets = {
  groupId: string;
  state: string;
  partitions: { committed: number; low: number; end: number }[];
};

/**
 * The groups that have not committed a record published before the read,
 * which their handler may still hold. Committed offsets outlive a group's
 * members, so a group whose member expired is judged as any other. One with
 * no partition to judge counts, unless it is stable or does not exist.
 */
export const lateGroups = (groups: GroupOffsets[]) =>
  groups
    .filter(({ state, partitions }) =>
      partitions.length === 0
        ? state !== "Stable" && state !== "Dead"
        : partitions.some(
            ({ committed, low, end }) =>
              (committed < 0 ? low : committed) < end,
          ),
    )
    .map((g) => g.groupId);

// The admin reads a crash stop makes give up after this, as the harness's
// SQL does: KafkaJS retries a request for far longer on its own.
const READ_TIMEOUT_MS = 10_000;

/** `read`'s answer, or a throw naming `what` once `ms` pass without one. */
export const bounded = async <T>(
  what: string,
  read: () => Promise<T>,
  ms = READ_TIMEOUT_MS,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${what}: no answer from the broker within ${ms / 1000} s`,
              ),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Offsets and consumer groups on the run's broker, read through the admin API, and a partition's records (`recordsOf`), read by a consumer of a group of its own. */
export const brokerReads = ({
  brokers,
  username,
  password,
  apiGroupPrefix,
}: BrokerAccess) => {
  const kafka = new Kafka({
    clientId: "network-smoke",
    brokers: brokers.split(","),
    sasl: { mechanism: "plain", username, password },
    logLevel: logLevel.NOTHING,
  });
  const admin = kafka.admin();
  let connected: Promise<void> | undefined;
  const ready = () => (connected ??= admin.connect());

  const ends = async (topic: string) =>
    (await admin.fetchTopicOffsets(topic)).map((p) => ({
      partition: p.partition,
      low: Number(p.low),
      high: Number(p.high),
    }));

  /** The end offset, now, of each partition the API's groups are assigned; `unsettled` names groups without a stable assignment. */
  const apiMarks = async () => {
    await ready();
    const ids = (await admin.listGroups()).groups
      .map((g) => g.groupId)
      .filter((id) => id.startsWith(apiGroupPrefix));
    const unsettled =
      ids.length === 0 ? [`no group starts with ${apiGroupPrefix}`] : [];
    const marks: Mark[] = [];
    const { groups } = await admin.describeGroups(ids);
    for (const group of groups) {
      if (group.state !== "Stable" || group.members.length === 0) {
        unsettled.push(`${group.groupId} (${group.state})`);
        continue;
      }
      const topics = new Set(
        group.members.flatMap((m) =>
          Object.keys(
            AssignerProtocol.MemberAssignment.decode(m.memberAssignment)
              ?.assignment ?? {},
          ),
        ),
      );
      for (const topic of topics) {
        for (const { partition, low, high } of await ends(topic)) {
          marks.push({
            group: group.groupId,
            topic,
            partition,
            low,
            end: high,
          });
        }
      }
    }
    return { marks, unsettled };
  };

  /** The marks a group has not committed through, with the offset it has. */
  const behind = async (marks: Mark[]) => {
    const late: (Mark & { committed: number })[] = [];
    const pairs = new Set(marks.map((m) => `${m.group}\n${m.topic}`));
    for (const pair of pairs) {
      const [groupId, topic] = pair.split("\n");
      const [committed] = await admin.fetchOffsets({
        groupId,
        topics: [topic],
      });
      for (const m of marks.filter(
        (m) => m.group === groupId && m.topic === topic,
      )) {
        const offset = Number(
          committed?.partitions.find((p) => p.partition === m.partition)
            ?.offset ?? -1,
        );
        const at = offset < 0 ? m.low : offset;
        if (at < m.end) {
          late.push({ ...m, committed: at });
        }
      }
    }
    return late;
  };

  return {
    /** Each partition of `topic`'s end offset: the offset its next record gets (`bounded`). */
    endOffsets: (topic: string) =>
      bounded(`the end offsets of ${topic}`, async () => {
        await ready();
        return new Map((await ends(topic)).map((p) => [p.partition, p.high]));
      }),
    /**
     * The offsets the API's groups have committed on `topic`, per group and
     * partition: the next record each would consume (`bounded`). Committed
     * offsets outlive the group's members, so this reads a crashed
     * consumer's too.
     */
    apiCommitted: (topic: string) =>
      bounded(`the API's offsets on ${topic}`, async () => {
        await ready();
        const ids = (await admin.listGroups()).groups
          .map((g) => g.groupId)
          .filter((id) => id.startsWith(apiGroupPrefix));
        const committed = new Map<string, Map<number, number>>();
        for (const groupId of ids) {
          const [offsets] = await admin.fetchOffsets({
            groupId,
            topics: [topic],
          });
          const held = (offsets?.partitions ?? [])
            .map((p) => [p.partition, Number(p.offset)] as const)
            .filter(([, offset]) => offset >= 0);
          if (held.length > 0) {
            committed.set(groupId, new Map(held));
          }
        }
        return committed;
      }),
    /** The late ones (`lateGroups`) of `groupIds`, whatever their state (`bounded`). */
    groupsBehind: (groupIds: string[]) =>
      bounded("the groups behind", async () => {
        await ready();
        const { groups } = await admin.describeGroups(groupIds);
        const judged: GroupOffsets[] = [];
        for (const { groupId, state, members } of groups) {
          // Without a topic list: every topic the group has committed on.
          const committed = await admin.fetchOffsets({ groupId });
          const topics = new Set([
            ...committed.map((t) => t.topic),
            ...members.flatMap((m) =>
              Object.keys(
                AssignerProtocol.MemberAssignment.decode(m.memberAssignment)
                  ?.assignment ?? {},
              ),
            ),
          ]);
          const partitions: GroupOffsets["partitions"] = [];
          for (const topic of topics) {
            const own = committed.find((t) => t.topic === topic)?.partitions;
            for (const { partition, low, high } of await ends(topic)) {
              partitions.push({
                committed: Number(
                  own?.find((p) => p.partition === partition)?.offset ?? -1,
                ),
                low,
                end: high,
              });
            }
          }
          judged.push({ groupId, state, partitions });
        }
        return lateGroups(judged);
      }),
    /**
     * The records of one partition of `topic` from offset `from` up to `to`,
     * read by a consumer of a group of its own; throws if they are not all
     * there within `timeoutMs`.
     */
    recordsOf: async (
      topic: string,
      partition: number,
      { from, to }: { from: number; to: number },
      timeoutMs = 30_000,
    ) => {
      const consumer = kafka.consumer({
        groupId: `network-smoke-reader-${randomUUID()}`,
      });
      const found = new Map<number, { key?: Buffer; value?: Buffer }>();
      let all: () => void = () => undefined;
      const complete = new Promise<void>((resolve) => (all = resolve));
      try {
        await consumer.connect();
        await consumer.subscribe({ topic, fromBeginning: true });
        await consumer.run({
          eachMessage: ({ partition: p, message }) => {
            const offset = Number(message.offset);
            if (p === partition && offset >= from && offset < to) {
              found.set(offset, {
                key: message.key ?? undefined,
                value: message.value ?? undefined,
              });
              if (found.size === to - from) {
                all();
              }
            }
            return Promise.resolve();
          },
        });
        if (to > from) {
          const timedOut = sleep(timeoutMs).then(() => "timed out" as const);
          if ((await Promise.race([complete, timedOut])) === "timed out") {
            throw new Error(
              `${topic} partition ${partition}: ${found.size} of the ${to - from} records from offset ${from} in ${timeoutMs / 1000} s`,
            );
          }
        }
      } finally {
        await consumer.disconnect();
      }
      return [...found.entries()]
        .sort(([a], [b]) => a - b)
        .map(([offset, record]) => ({ offset, ...record }));
    },
    /** How many records each partition of `topic` holds. */
    recordsPerPartition: async (topic: string) => {
      await ready();
      return (await ends(topic)).map(({ partition, low, high }) => ({
        partition,
        records: high - low,
      }));
    },
    /**
     * How many records of `topic` carry a timestamp in [from, to), by the
     * clock of the host whose producers stamped them. A record counts once it
     * has landed, whenever that is.
     */
    publishedBetween: async (topic: string, from: number, to: number) => {
      await ready();
      // Per partition, the first offset stamped at or after `at`.
      const before = async (at: number) =>
        (await admin.fetchTopicOffsetsByTimestamp(topic, at)).reduce(
          (sum, { offset }) => sum + Number(offset),
          0,
        );
      return (await before(to)) - (await before(from));
    },
    /**
     * Takes the end offsets of the API's assigned partitions once, then waits
     * until its groups have committed through them; throws with what is
     * still behind after `timeoutMs`. Records published after the call
     * (tips, node liveness) do not hold it up.
     */
    apiConsumedThrough: async (timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      let taken = await apiMarks();
      while (taken.unsettled.length > 0 && Date.now() < deadline) {
        await sleep(500);
        taken = await apiMarks();
      }
      if (taken.unsettled.length > 0) {
        throw new Error(
          `the API's consumer groups have no stable assignment: ${taken.unsettled.join(", ")}`,
        );
      }
      let late = await behind(taken.marks);
      while (late.length > 0 && Date.now() < deadline) {
        await sleep(500);
        late = await behind(taken.marks);
      }
      if (late.length > 0) {
        throw new Error(
          `the API did not commit through these offsets within ${timeoutMs / 1000} s: ${JSON.stringify(late)}`,
        );
      }
    },
    close: async () => {
      if (connected) {
        await admin.disconnect();
      }
    },
  };
};

export type BrokerReads = ReturnType<typeof brokerReads>;
