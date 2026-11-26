// TODO: revise file name and perhaps also set-up?
import { Logger } from "@chicmoz-pkg/logger-server";
import autoBind from "auto-bind";
import { BSON } from "bson";
import kafkaJS, {
  Consumer,
  type EachMessagePayload,
  Kafka,
  KafkaConfig,
  Message,
  Producer,
  SASLOptions,
} from "kafkajs";

export { SASLOptions } from "kafkajs";

export interface MBOptions {
  logger: Logger;
  clientId: string;
  connection: string;
  saslConfig: SASLOptions;
  ssl?: boolean;
}

// KafkaJS sends at most one heartbeat per interval (3 s by default), so a
// handler can call this freely. It throws when the group rebalances; let that
// propagate so the message is redelivered.
export type Heartbeat = EachMessagePayload["heartbeat"];

type TopicCallback = (event: object, heartbeat: Heartbeat) => Promise<void>;

export type MBConsumer = {
  consumer: Consumer;
  topicCallbacks: Record<string, TopicCallback>;
};

export class MessageBus {
  #client: Kafka;
  #producer: Producer | undefined;
  #producerConnectingPromise: Promise<void> | undefined;
  #consumers: Record<string, MBConsumer | undefined>;
  #shutdown = false;
  logger: Logger;

  constructor(options: MBOptions) {
    this.logger = options.logger;
    const kafkaConfig: KafkaConfig = {
      clientId: options.clientId,
      brokers: options.connection.split(","),
      sasl: options.saslConfig,
      logCreator: () => {
        return ({ log, label }) => {
          const { message, error, stack, retryCount } = log;
          if (stack) {
            this.logger.error(`Kafka: ${stack}`);
          } else if (error) {
            this.logger.error(`Kafka: ${error} (message: ${message})`);
          } else if (retryCount) {
            this.logger.warn(`Kafka: ${message} (retrying ${retryCount}...)`);
          } else {
            this.logger.info(`Kafka[${label}]: ${message}`);
          }
        };
      },
    };
    if (options.ssl) {
      kafkaConfig.ssl = true;
    }

    this.#client = new Kafka(kafkaConfig);
    this.#consumers = {};

    autoBind(this);
  }

  private shouldCrash(error: Error): boolean {
    if (this.isCoordinatorOrRebalanceError(error)) {
      return false;
    }

    const isNonRetriableError =
      error instanceof kafkaJS.KafkaJSNonRetriableError;
    const isNumberOfRetriesExceeded =
      error instanceof kafkaJS.KafkaJSNumberOfRetriesExceeded;
    const isCoordinatorError =
      error instanceof kafkaJS.KafkaJSGroupCoordinatorNotFound;

    return (
      isNonRetriableError && !isNumberOfRetriesExceeded && !isCoordinatorError
    );
  }

  private isCoordinatorOrRebalanceError(error: Error): boolean {
    const kafkaErrorMetadata = error as Error & {
      code?: number | string;
      type?: string;
    };
    const kafkaErrorText = [
      error.name,
      error.message,
      kafkaErrorMetadata.type,
      kafkaErrorMetadata.code?.toString(),
    ]
      .filter((value): value is string => value !== undefined)
      .join(" ")
      .toLowerCase();

    return [
      "not the correct coordinator",
      "not_coordinator_for_group",
      "coordinator not available",
      "coordinator_not_available",
      "group coordinator",
      "group is rebalancing",
      "rebalance",
      "rebalance_in_progress",
      "rebalancing",
      "illegal generation",
      "illegal_generation",
      "unknown member id",
      "unknown_member_id",
    ].some((transientConsumerError) =>
      kafkaErrorText.includes(transientConsumerError),
    );
  }

  private async ensureProducerConnected() {
    if (!this.#producerConnectingPromise) {
      this.#producer = this.#client.producer();
      this.#producerConnectingPromise = this.#producer.connect();
    }
    await this.#producerConnectingPromise;
  }

  private async connectConsumer(groupId: string) {
    this.#consumers[groupId] = {
      consumer: this.#client.consumer({ groupId }),
      topicCallbacks: {},
    };
    await this.#consumers[groupId]!.consumer.connect();
  }

  async publish<T>(topic: string, ...messages: T[]) {
    await this.produce(topic, messages);
  }

  // KafkaJS hashes the key over the topic's partition count, so messages with
  // one key stay on one partition, in order, only while that count holds and
  // each call is awaited before the next.
  async publishKeyed<T>(topic: string, key: string, ...messages: T[]) {
    await this.produce(topic, messages, key);
  }

  private async produce<T>(topic: string, messages: T[], key?: string) {
    if (this.#shutdown) {
      throw new Error("MessageBus is already shutdown");
    }

    await this.ensureProducerConnected();

    const kafkaMessages: Message[] = messages.map((m) => ({
      key,
      value: Buffer.from(BSON.serialize({ data: m })),
    }));

    await this.#producer!.send({ topic, messages: kafkaMessages });
  }

  async subscribe<T>(
    groupId: string,
    topic: string,
    cb:
      | ((event: T, heartbeat: Heartbeat) => Promise<void>)
      | ((event: T, heartbeat: Heartbeat) => void),
  ) {
    this.logger.info(`Kafka (sub): connecting to consumer group ${groupId}`);
    if (!this.#consumers[groupId]) {
      await this.connectConsumer(groupId);
    }

    this.logger.info(`Kafka (sub): subscribing to topic ${topic}`);
    await this.#consumers[groupId]!.consumer.subscribe({
      topic,
      fromBeginning: true,
    });
    this.#consumers[groupId]!.topicCallbacks = {
      ...this.#consumers[groupId]?.topicCallbacks,
      [topic]: cb as unknown as TopicCallback,
    };
  }

  private nonRetriableWrapper(groupId: string) {
    // TODO: we should do this without promise
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.#consumers[groupId]!.consumer.on("consumer.crash", async (payload) => {
      if (this.shouldCrash(payload.payload.error)) {
        this.logger.error(
          `FATAL: not recoverable error: ${JSON.stringify(
            payload.payload.error,
          )}`,
        );
        process.exitCode = 1;
        process.kill(process.pid, "SIGTERM");
        return;
      }

      const currentTopics = this.#consumers[groupId]!.topicCallbacks;
      try {
        await this.#consumers[groupId]!.consumer.disconnect();
      } finally {
        // TODO: we should do this without promise
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        setTimeout(async () => {
          await this.connectConsumer(groupId);
          await Promise.all(
            Object.keys(currentTopics).map(async (topicName) => {
              await this.subscribe(
                groupId,
                topicName,
                currentTopics[topicName],
              );
            }),
          );
          await this.runConsumer(groupId);
        }, 5000);
      }
    });
  }

  async runConsumer(groupId: string) {
    if (!this.#consumers[groupId]) {
      throw new Error(`No consumer exists with groupId: ${groupId}`);
    }

    this.nonRetriableWrapper(groupId);

    await this.#consumers[groupId]!.consumer.run({
      // TODO: https://kafka.js.org/docs/consuming; probably need to look into manually committing instead in future
      eachMessage: async ({ topic, message, heartbeat }) => {
        // Yield the event loop between messages so that other consumers sharing
        // this Node.js process get a chance to fetch and process their messages.
        // Without this, a consumer with a large backlog (e.g. catchup) can
        // starve other consumers (e.g. tip-of-chain block handler) by
        // monopolizing the event loop with back-to-back await chains.
        await new Promise((resolve) => setTimeout(resolve, 0));

        const messageValue = message.value!;
        const valueAsUint8Array =
          messageValue instanceof Buffer
            ? new Uint8Array(messageValue)
            : typeof messageValue === "string"
              ? new TextEncoder().encode(messageValue)
              : new Uint8Array(0);
        // A message that cannot be deserialized is a poison pill: retrying
        // it can never succeed, so log it and move on rather than
        // crash-looping the whole partition.
        let data: object;
        try {
          const deserializedObj = BSON.deserialize(valueAsUint8Array);
          if (typeof deserializedObj?.data !== "object") {
            throw new Error(
              `Deserialized message does not contain a valid data object`,
            );
          }
          data = deserializedObj.data as object;
        } catch (e) {
          this.logger.error(
            `Skipping undeserializable message on topic ${topic}: ${
              e instanceof Error ? e.stack : String(e)
            }`,
          );
          return;
        }
        const cb = this.#consumers[groupId]?.topicCallbacks[topic];
        if (cb) {
          // The broker evicts a member silent past the session timeout (KafkaJS
          // default 30 s), and its partitions resume from their last commit. A
          // handler that can run that long calls the heartbeat it is passed.
          await heartbeat();
          try {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
            await cb(data, heartbeat);
          } catch (e) {
            // Rethrow so kafkajs does NOT resolve this offset. Swallowing
            // here acknowledged messages whose handler (typically a database
            // write) had failed, silently losing the event; rethrowing makes
            // kafkajs redeliver it, giving at-least-once semantics. Handlers
            // are id-keyed upserts, so redelivery is safe.
            if (e instanceof Error) {
              this.logger.error(
                `Provided callback for topic ${topic} failed (message will be redelivered): ${e.stack}`,
              );
            } else {
              this.logger.warn(
                // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
                `Provided callback for topic ${topic} failed with non-Error (message will be redelivered): ${e}`,
              );
            }
            throw e;
          }
        }
      },
    });
  }

  async disconnect() {
    this.#shutdown = true;
    await this.#producer?.disconnect();
    for (const consumer of Object.values(this.#consumers)) {
      await consumer?.consumer.disconnect();
    }
  }
}
