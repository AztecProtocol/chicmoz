/**
 * Optional prefix for every Kafka topic and consumer group, read from
 * KAFKA_NAMESPACE. It keeps two deployments of the same L2 network apart on
 * one Kafka cluster, e.g. two Aztec major versions of testnet, which share
 * an L2_NETWORK_ID. Unset, names are unchanged.
 */
export const parseKafkaNamespace = (
  value: string | undefined,
): string | undefined => {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (!/^[a-z0-9]+$/i.test(value)) {
    throw new Error(
      `KAFKA_NAMESPACE must be alphanumeric, got "${value}"`,
    );
  }
  return value;
};

export const KAFKA_NAMESPACE = parseKafkaNamespace(
  process.env.KAFKA_NAMESPACE,
);

export type KafkaNamespaced<T extends string> = T | `${string}.${T}`;

export const withKafkaNamespace = <T extends string>(
  name: T,
  namespace: string | undefined = KAFKA_NAMESPACE,
): KafkaNamespaced<T> =>
  namespace === undefined ? name : `${namespace}.${name}`;
