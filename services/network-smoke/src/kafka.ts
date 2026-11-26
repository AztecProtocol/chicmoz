import { type Stack } from "@chicmoz/test-harness";

const TOPICS = "/opt/kafka/bin/kafka-topics.sh";
// The broker's own listener and client config inside the harness container.
const CLIENT = [
  "--bootstrap-server",
  "localhost:9092",
  "--command-config",
  "/etc/kafka/secrets/client.properties",
];

/**
 * Creates `topic` with `partitions` partitions. It must run before any
 * client touches the topic: the broker auto-creates topics with one.
 */
export const createTopic = async (
  stack: Stack,
  topic: string,
  partitions: number,
) => {
  await stack.exec("kafka", [
    TOPICS,
    ...CLIENT,
    "--create",
    "--topic",
    topic,
    "--partitions",
    String(partitions),
    "--replication-factor",
    "1",
  ]);
  const described = await stack.exec("kafka", [
    TOPICS,
    ...CLIENT,
    "--describe",
    "--topic",
    topic,
  ]);
  const count = /PartitionCount:\s*(\d+)/.exec(described)?.[1];
  if (Number(count) !== partitions) {
    throw new Error(
      `topic ${topic} has ${count ?? "no"} partitions, not ${partitions}`,
    );
  }
};
