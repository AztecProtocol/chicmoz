import { Kafka, logLevel } from "kafkajs";
import { z } from "zod";

export const brokerAccessSchema = z.object({
  brokers: z.string(),
  username: z.string(),
  password: z.string(),
  /** The block topic, under the run's namespace. */
  blockTopic: z.string(),
});

export type BrokerAccess = z.infer<typeof brokerAccessSchema>;

/** Offsets on the run's broker, read through the admin API only. */
export const brokerReads = ({ brokers, username, password }: BrokerAccess) => {
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

  return {
    /** How many records each partition of `topic` holds. */
    recordsPerPartition: async (topic: string) => {
      await ready();
      return (await ends(topic)).map(({ partition, low, high }) => ({
        partition,
        records: high - low,
      }));
    },
    close: async () => {
      if (connected) {
        await admin.disconnect();
      }
    },
  };
};

export type BrokerReads = ReturnType<typeof brokerReads>;
