import { type Logger } from "@chicmoz-pkg/logger-server";
import { BSON } from "bson";
import { type Consumer, type Producer } from "kafkajs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Heartbeat, MessageBus } from "./class.js";

const { producer, consumer } = vi.hoisted(() => ({
  producer: { connect: vi.fn(), send: vi.fn<Producer["send"]>() },
  consumer: {
    connect: vi.fn(),
    subscribe: vi.fn(),
    on: vi.fn(),
    run: vi.fn<Consumer["run"]>(),
  },
}));

vi.mock("kafkajs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("kafkajs")>()),
  Kafka: class {
    producer = () => producer;
    consumer = () => consumer;
  },
}));

const newMessageBus = () =>
  new MessageBus({
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger,
    clientId: "test",
    connection: "localhost:9092",
    saslConfig: { mechanism: "plain", username: "user", password: "pass" },
  });

describe("MessageBus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishKeyed sends every message with its key, in order; publish sends none", async () => {
    const mb = newMessageBus();

    await mb.publishKeyed("topic", "TESTNET", { n: 1 }, { n: 2 });
    await mb.publish("topic", { n: 3 });

    const sent = producer.send.mock.calls.map(([{ topic, messages }]) => ({
      topic,
      messages: messages.map(({ key, value }) => ({
        key,
        data: BSON.deserialize(value as Buffer).data as unknown,
      })),
    }));
    expect(sent).toEqual([
      {
        topic: "topic",
        messages: [
          { key: "TESTNET", data: { n: 1 } },
          { key: "TESTNET", data: { n: 2 } },
        ],
      },
      { topic: "topic", messages: [{ key: undefined, data: { n: 3 } }] },
    ]);
  });

  it("passes the handler KafkaJS's heartbeat for its message", async () => {
    const mb = newMessageBus();
    const handler = vi.fn(async (_event: object, heartbeat: Heartbeat) => {
      await heartbeat();
    });
    await mb.subscribe("group", "topic", handler);
    await mb.runConsumer("group");
    const eachMessage = consumer.run.mock.calls[0]?.[0]?.eachMessage;
    const heartbeat = vi.fn<Heartbeat>(() => Promise.resolve());

    await eachMessage!({
      topic: "topic",
      partition: 0,
      message: {
        key: null,
        value: Buffer.from(BSON.serialize({ data: { n: 1 } })),
        timestamp: "0",
        attributes: 0,
        offset: "0",
        headers: {},
      },
      heartbeat,
      pause: vi.fn(),
    });

    expect(handler).toHaveBeenCalledWith({ n: 1 }, heartbeat);
    // Once by the bus before the handler, once by the handler.
    expect(heartbeat).toHaveBeenCalledTimes(2);
  });
});
