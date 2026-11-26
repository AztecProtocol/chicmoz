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

export type Lag = {
  /** Groups that are not stable with members, so their assignment is unknown. */
  unsettled: string[];
  /** Partitions whose newest record a group has not committed past. */
  behind: { group: string; topic: string; partition: number; lag: number }[];
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

  /** Committed lag of the groups whose ids start with `prefix`, on the partitions their members hold. */
  const lag = async (prefix: string): Promise<Lag> => {
    await ready();
    const ids = (await admin.listGroups()).groups
      .map((g) => g.groupId)
      .filter((id) => id.startsWith(prefix));
    const lag: Lag = {
      unsettled: ids.length === 0 ? [`no group starts with ${prefix}`] : [],
      behind: [],
    };
    const { groups } = await admin.describeGroups(ids);
    for (const group of groups) {
      if (group.state !== "Stable" || group.members.length === 0) {
        lag.unsettled.push(`${group.groupId} (${group.state})`);
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
        const [committed] = await admin.fetchOffsets({
          groupId: group.groupId,
          topics: [topic],
        });
        for (const { partition, low, high } of await ends(topic)) {
          const offset = Number(
            committed?.partitions.find((p) => p.partition === partition)
              ?.offset ?? -1,
          );
          const behind = high - (offset < 0 ? low : offset);
          if (behind > 0) {
            lag.behind.push({
              group: group.groupId,
              topic,
              partition,
              lag: behind,
            });
          }
        }
      }
    }
    return lag;
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
    lag,
    /** The API's groups are stable and committed past every record on their topics. */
    apiConsumed: async () => {
      const { unsettled, behind } = await lag(apiGroupPrefix);
      return unsettled.length === 0 && behind.length === 0;
    },
    close: async () => {
      if (connected) {
        await admin.disconnect();
      }
    },
  };
};

export type BrokerReads = ReturnType<typeof brokerReads>;
