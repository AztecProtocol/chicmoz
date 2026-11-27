import { setTimeout as sleep } from "node:timers/promises";
import { AssignerProtocol, Kafka, logLevel } from "kafkajs";
import { z } from "zod";

export const brokerAccessSchema = z.object({
  brokers: z.string(),
  username: z.string(),
  password: z.string(),
  /** The block topic, under the run's namespace. */
  blockTopic: z.string(),
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

/** Offsets and consumer groups on the run's broker, read through the admin API only. */
export const brokerReads = ({
  brokers,
  username,
  password,
  apiGroupPrefix,
}: BrokerAccess) => {
  const admin = new Kafka({
    clientId: "network-smoke",
    brokers: brokers.split(","),
    sasl: { mechanism: "plain", username, password },
    logLevel: logLevel.NOTHING,
  }).admin();
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
    /** How many records each partition of `topic` holds. */
    recordsPerPartition: async (topic: string) => {
      await ready();
      return (await ends(topic)).map(({ partition, low, high }) => ({
        partition,
        records: high - low,
      }));
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
