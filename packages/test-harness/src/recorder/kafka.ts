import { Kafka, type ISocketFactory } from "kafkajs";
import { connect } from "node:net";
import { type FixtureSource } from "../fixtures/format.js";
import { writeFixture } from "./write.js";

// RPC-node topics carry operator URLs and error stacks, so the tap never reads them.
export const TAPPABLE_EVENTS = ["PENDING_TXS_EVENT", "L2_TIPS_EVENT", "CHAIN_INFO_EVENT"];

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

// Broker metadata names every later destination (partition leaders, the group
// coordinator), so each socket is checked, not only the bootstrap address.
const loopbackOnly: ISocketFactory = ({ host, port, onConnect }) => {
  if (!LOOPBACK.has(host)) {
    throw new Error("the tap connects only to brokers on loopback (the recording stack)");
  }
  return connect({ host: host === "localhost" ? "127.0.0.1" : host, port }, onConnect);
};

export type KafkaTap = {
  source: FixtureSource;
  aztecVersion: string;
  /** `host:port` of the recording stack's broker; loopback only. */
  connection: string;
  namespace: string;
  network: string;
  eventTypes: string[];
  maxPerEvent: number;
  timeoutMs: number;
  log: (line: string) => void;
};

/**
 * Reads each event type's topic of one namespace from the beginning and
 * records up to `maxPerEvent` message values per type, byte for byte.
 */
export const tapFrames = async (t: KafkaTap): Promise<Record<string, number>> => {
  const refused = t.eventTypes.filter((e) => !TAPPABLE_EVENTS.includes(e));
  if (refused.length > 0) {
    throw new Error(`the tap records only ${TAPPABLE_EVENTS.join(", ")}`);
  }
  const kafka = new Kafka({
    clientId: "fixture-tap",
    brokers: [t.connection],
    socketFactory: loopbackOnly,
    sasl: {
      mechanism: "plain",
      username: process.env.KAFKA_SASL_USERNAME ?? "controller_user",
      password: process.env.KAFKA_SASL_PASSWORD ?? "test",
    },
  });
  const topics = new Map(
    t.eventTypes.map((e) => [`${t.namespace}.${t.network}__${e}`, e]),
  );
  const counts: Record<string, number> = Object.fromEntries(t.eventTypes.map((e) => [e, 0]));
  const consumer = kafka.consumer({ groupId: `fixture-tap-${Date.now()}` });
  try {
    await consumer.connect();
    await consumer.subscribe({ topics: [...topics.keys()], fromBeginning: true });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, t.timeoutMs);
      const fail = (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      };
      consumer
        .run({
          eachMessage: ({ topic, message }) => {
            const eventType = topics.get(topic);
            const seen = eventType ? (counts[eventType] ?? 0) : 0;
            if (!eventType || !message.value || seen >= t.maxPerEvent) {
              return Promise.resolve();
            }
            try {
              t.log(
                `wrote ${writeFixture({
                  source: t.source,
                  kind: "frame",
                  name: `${eventType.toLowerCase().replace(/_/g, "-")}-${seen + 1}`,
                  aztecVersion: t.aztecVersion,
                  origin: `kafka ${t.network}__${eventType} offset ${message.offset}`,
                  features: [],
                  data: { l2NetworkId: t.network, eventType, bson: message.value.toString("hex") },
                })}`,
              );
            } catch (e) {
              fail(e);
              return Promise.resolve();
            }
            counts[eventType] = seen + 1;
            if (Object.values(counts).every((n) => n >= t.maxPerEvent)) {
              clearTimeout(timer);
              resolve();
            }
            return Promise.resolve();
          },
        })
        .catch(fail);
    });
  } finally {
    await consumer.disconnect();
  }
  return counts;
};
