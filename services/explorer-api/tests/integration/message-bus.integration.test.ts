import {
  type ChicmozMessageBusPayload,
  type ChicmozMessageBusTopic,
} from "@chicmoz-pkg/message-registry";
import { BSON } from "bson";
import { Kafka, logLevel, type Admin, type Producer } from "kafkajs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";
import { chainInfoEvent } from "./support/fixtures.js";

type EventType = "CHAIN_INFO_EVENT" | "L2_TIPS_EVENT" | "PENDING_TXS_EVENT";
type Marked = { marker: string };

const DEADLINE_MS = 30_000;

const until = async (done: () => boolean, what: string) => {
  const end = Date.now() + DEADLINE_MS;
  while (!done()) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

// explorer-api's own publish and subscribe wrappers on the harness broker.
// Each case has its own single-partition topic: subscriptions read from the
// beginning, so a shared topic would replay earlier cases into later ones.
describe("message bus on a real broker", () => {
  let api: ExplorerApiForTest;
  let raw: Producer;
  let admin: Admin;
  let topicFor: (eventType: EventType) => Promise<ChicmozMessageBusTopic>;
  let publish: (eventType: EventType, marker: string) => Promise<void>;
  let record: (eventType: EventType, fail?: (m: Marked, calls: string[]) => boolean) => Promise<string[]>;

  beforeAll(async () => {
    api = await startExplorerApiForTest();
    const { generateL2TopicName } = await import("@chicmoz-pkg/message-registry");
    const { publishMessage, startSubscribe } = await import(
      "../../src/svcs/message-bus/index.js"
    );
    const kafka = new Kafka({
      clientId: `${api.namespace}-raw`,
      brokers: [api.stack.env.KAFKA_CONNECTION],
      sasl: {
        mechanism: "plain",
        username: api.stack.env.KAFKA_SASL_USERNAME,
        password: api.stack.env.KAFKA_SASL_PASSWORD,
      },
      logLevel: logLevel.NOTHING,
    });
    raw = kafka.producer();
    await raw.connect();
    admin = kafka.admin();
    await admin.connect();

    topicFor = async (eventType) => {
      const topic = generateL2TopicName("SANDBOX", eventType);
      await admin.createTopics({ topics: [{ topic, numPartitions: 1 }], waitForLeaders: true });
      return topic;
    };
    publish = (eventType, marker) =>
      publishMessage(eventType, { ...chainInfoEvent, marker } as ChicmozMessageBusPayload);
    record = async (eventType, fail) => {
      const calls: string[] = [];
      await startSubscribe({
        groupId: `${api.namespace}-${eventType}`,
        topic: await topicFor(eventType),
        cb: async (event: unknown) => {
          const m = event as Marked;
          calls.push(m.marker);
          if (fail?.(m, calls)) {
            throw new Error(`handler failed on ${m.marker}`);
          }
          await Promise.resolve();
        },
      });
      return calls;
    };
  });

  afterAll(async () => {
    await admin?.disconnect();
    await raw?.disconnect();
    await api?.close();
  });

  it("redelivers a message whose handler threw, before the next one", async () => {
    const calls = await record(
      "CHAIN_INFO_EVENT",
      (m, seen) => m.marker === "M1" && seen.filter((c) => c === "M1").length === 1,
    );
    await publish("CHAIN_INFO_EVENT", "M1");
    await publish("CHAIN_INFO_EVENT", "M2");
    await until(() => calls.includes("M2"), "M2");
    expect(calls).toEqual(["M1", "M1", "M2"]);
  });

  it.each([
    { label: "bytes that are not BSON", eventType: "L2_TIPS_EVENT" as const, value: Buffer.from("not bson") },
    {
      label: "BSON without a data field",
      eventType: "PENDING_TXS_EVENT" as const,
      value: Buffer.from(BSON.serialize({ x: 1 })),
    },
  ])("skips $label and delivers the next message", async ({ eventType, value }) => {
    const calls = await record(eventType);
    await raw.send({ topic: await topicFor(eventType), messages: [{ value }] });
    await publish(eventType, "M3");
    await until(() => calls.includes("M3"), "M3");
    expect(calls).toEqual(["M3"]);
  });
});
