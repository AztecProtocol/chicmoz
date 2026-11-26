import { type Logger } from "@chicmoz-pkg/logger-server";
import { BSON } from "bson";
import { type Consumer, type Producer } from "kafkajs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Heartbeat, MessageBus } from "./class.js";

const { producer, consumer } = vi.hoisted(() => ({
  producer: {
    connect: vi.fn<Producer["connect"]>(() => Promise.resolve()),
    send: vi.fn<Producer["send"]>(),
  },
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

  it("publishKeyed sends one batch with the key on every message; publish sets none", async () => {
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

  it("reconnects the producer on the next publish after a failed connect", async () => {
    const mb = newMessageBus();
    const down = new Error("broker down");
    producer.connect.mockRejectedValueOnce(down);

    await expect(mb.publish("topic", { n: 1 })).rejects.toBe(down);
    await mb.publish("topic", { n: 2 });

    expect(producer.connect).toHaveBeenCalledTimes(2);
    expect(producer.send).toHaveBeenCalledTimes(1);
  });

  it("passes the handler its message's heartbeat and fails the message when it rejects", async () => {
    const mb = newMessageBus();
    const rebalancing = new Error("The group is rebalancing");
    let handling = false;
    const heartbeat = vi.fn<Heartbeat>(() =>
      handling ? Promise.reject(rebalancing) : Promise.resolve(),
    );
    const handler = vi.fn(async (_event: object, hb: Heartbeat) => {
      handling = true;
      await hb();
    });
    await mb.subscribe("group", "topic", handler);
    await mb.runConsumer("group");
    const eachMessage = consumer.run.mock.calls[0]?.[0]?.eachMessage;

    await expect(
      eachMessage!({
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
      }),
    ).rejects.toBe(rebalancing);
    expect(handler).toHaveBeenCalledWith({ n: 1 }, heartbeat);
  });
});
