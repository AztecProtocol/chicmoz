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

// One single-partition topic per case keeps send order and stops a later
// case's `fromBeginning` subscription replaying an earlier case.
describe("message bus on a real broker", () => {
  let api: ExplorerApiForTest;
  let raw: Producer;
  let admin: Admin;
  let topicFor: (eventType: EventType) => Promise<ChicmozMessageBusTopic>;
  let publish: (eventType: EventType, marker: string) => Promise<void>;
  let record: (
    eventType: EventType,
    fail?: (marker: string, calls: string[]) => boolean,
  ) => Promise<{ calls: string[]; topic: ChicmozMessageBusTopic }>;

  beforeAll(async () => {
    api = await startExplorerApiForTest();
    // The registry reads KAFKA_NAMESPACE at import.
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
      const topic = await topicFor(eventType);
      await startSubscribe({
        groupId: `${api.namespace}-${eventType}`,
        topic,
        cb: async (event: unknown) => {
          // A delivery without a marker is recorded too, so it fails the sequence check instead of throwing here.
          const marker = (event as Partial<Marked> | undefined)?.marker ?? "<no marker>";
          calls.push(marker);
          if (fail?.(marker, calls)) {
            throw new Error(`handler failed on ${marker}`);
          }
          await Promise.resolve();
        },
      });
      return { calls, topic };
    };
  });

  afterAll(async () => {
    const results = await Promise.allSettled([admin?.disconnect(), raw?.disconnect(), api?.close()]);
    const failed = results.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []));
    if (failed.length > 0) {
      throw new AggregateError(failed, "teardown failed");
    }
  });

  it("redelivers a message whose handler threw, before the next one", async () => {
    const { calls } = await record(
      "CHAIN_INFO_EVENT",
      (marker, seen) => marker === "M1" && seen.filter((c) => c === "M1").length === 1,
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
    const { calls, topic } = await record(eventType);
    await raw.send({ topic, messages: [{ value }] });
    await publish(eventType, "M3");
    await until(() => calls.includes("M3"), "M3");
    expect(calls).toEqual(["M3"]);
  });
});
