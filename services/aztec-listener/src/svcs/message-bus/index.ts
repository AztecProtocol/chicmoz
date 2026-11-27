import {
  EventHandler,
  generateSvc,
  publishKeyedMessage as pubKeyed,
  publishMessage as pub,
  startSubscribe as sub,
} from "@chicmoz-pkg/message-bus";
import {
  L2_MESSAGES,
  generateL2TopicName,
} from "@chicmoz-pkg/message-registry";
import {
  INSTANCE_NAME,
  type MicroserviceBaseSvc,
} from "@chicmoz-pkg/microservice-base";
import { L2_NETWORK_ID } from "../../environment.js";
import { logger } from "../../logger.js";

export const publishMessage = async <K extends keyof L2_MESSAGES>(
  eventType: K,
  message: L2_MESSAGES[K],
) => {
  const topic = generateL2TopicName(L2_NETWORK_ID, eventType);
  logger.info(`Publishing message to topic ${topic}`);
  await pub(topic, message);
};

/**
 * Publishes under `key`. One key maps to one partition, so messages keep
 * their order only while each send is awaited before the next.
 */
export const publishKeyedMessage = async <K extends keyof L2_MESSAGES>(
  eventType: K,
  key: string,
  message: L2_MESSAGES[K],
) => {
  const topic = generateL2TopicName(L2_NETWORK_ID, eventType);
  logger.info(`Publishing message to topic ${topic} with key ${key}`);
  await pubKeyed(topic, key, message);
};

export const publishMessageSync = (
  ...args: Parameters<typeof publishMessage>
) => {
  publishMessage(...args).catch((e) => logger.error((e as Error).message));
};

export const startSubscribe = async (eventHandler: EventHandler) => {
  await sub(eventHandler, logger);
};

export const messageBusService: MicroserviceBaseSvc = generateSvc(
  INSTANCE_NAME,
  logger,
);
