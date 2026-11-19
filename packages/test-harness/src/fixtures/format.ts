import { z } from "zod";
import { REDACTED_ENR } from "./sanitize.js";

export const FIXTURE_FORMAT = 1;

export const FIXTURE_SOURCES = ["local-network", "testnet"] as const;
export type FixtureSource = (typeof FIXTURE_SOURCES)[number];

const hexString = z.string().regex(/^0x[0-9a-f]*$/i);

const l2BlockData = z
  .object({
    /** `L2Block.toBuffer()` as hex, exactly what aztec-listener publishes in `NEW_BLOCK_EVENT.block`. */
    hex: z.string().regex(/^[0-9a-f]+$/),
    /** Values read from the node's JSON response, not decoded from `hex`. */
    expected: z
      .object({
        height: z.number().int().positive(),
        hash: hexString,
        archiveRoot: hexString,
        checkpointNumber: z.number().int().nonnegative(),
        indexWithinCheckpoint: z.number().int().nonnegative(),
        txHashes: z.array(hexString),
        counts: z
          .object({
            txEffects: z.number().int().nonnegative(),
            noteHashes: z.number().int().nonnegative(),
            nullifiers: z.number().int().nonnegative(),
            l2ToL1Msgs: z.number().int().nonnegative(),
            publicDataWrites: z.number().int().nonnegative(),
            publicLogs: z.number().int().nonnegative(),
            privateLogs: z.number().int().nonnegative(),
            contractClassLogs: z.number().int().nonnegative(),
          })
          .strict(),
        contractClassIds: z.array(hexString),
        contractInstanceAddresses: z.array(hexString),
      })
      .strict(),
  })
  .strict();

const checkpointData = z
  .object({
    number: z.number().int().positive(),
    archiveRoot: hexString,
    startBlock: z.number().int().positive(),
    blockCount: z.number().int().positive(),
    l1: z
      .object({
        blockNumber: z.bigint(),
        blockHash: hexString,
        timestamp: z.bigint(),
      })
      .strict()
      .optional(),
  })
  .strict();

const L1_CONTRACTS = [
  "rollupAddress",
  "registryAddress",
  "inboxAddress",
  "outboxAddress",
  "feeJuiceAddress",
  "feeJuicePortalAddress",
  "coinIssuerAddress",
  "rewardDistributorAddress",
  "governanceProposerAddress",
  "governanceAddress",
  "stakingAssetAddress",
  "feeAssetHandlerAddress",
  "gseAddress",
  "stakingAssetHandlerAddress",
  "zkPassportVerifierAddress",
  "dateGatedRelayerAddress",
] as const;
const PROTOCOL_CONTRACTS = ["classRegistry", "feeJuice", "instanceRegistry", "multiCallEntrypoint"] as const;
const addressMap = (keys: readonly string[]) =>
  z.object(Object.fromEntries(keys.map((k) => [k, hexString.optional()]))).strict();

// Raw JSON-RPC results, projected onto known fields so a new field cannot slip into a public file unreviewed.
const nodeInfoData = z
  .object({
    result: z
      .object({
        nodeVersion: z.string(),
        l1ChainId: z.number().int(),
        rollupVersion: z.number().int(),
        enr: z.literal(REDACTED_ENR).optional(),
        l1ContractAddresses: addressMap(L1_CONTRACTS),
        protocolContractAddresses: addressMap(PROTOCOL_CONTRACTS),
        realProofs: z.boolean(),
        txsLimits: z
          .object({
            gas: z
              .object({ daGas: z.number().int(), l2Gas: z.number().int() })
              .strict(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const tipBlock = z.object({ number: z.number().int(), hash: hexString }).strict();
const checkpointTip = z.object({ block: tipBlock, checkpoint: tipBlock }).strict();
const l2TipsData = z
  .object({
    result: z
      .object({
        proposed: tipBlock,
        proposedCheckpoint: checkpointTip.optional(),
        checkpointed: checkpointTip,
        proven: checkpointTip,
        finalized: checkpointTip,
      })
      .strict(),
  })
  .strict();

const frameData = z
  .object({
    /** With `eventType`, rebuilds the topic under any namespace: `<ns>.<l2NetworkId>__<eventType>`. */
    l2NetworkId: z.string().regex(/^[A-Z0-9_]+$/),
    /** A key of `L2_MESSAGES` in `@chicmoz-pkg/message-registry`. */
    eventType: z.string().regex(/^[A-Z0-9_]+$/),
    /** The Kafka message value as published: `BSON.serialize({ data })`, hex. */
    bson: z.string().regex(/^[0-9a-f]+$/),
  })
  .strict();

const l1LogData = z
  .object({
    /** A key of ethereum-listener's `AztecContracts`. */
    contract: z.string(),
    eventName: z.string(),
    /** One element of viem `getContractEvents` output; `eventName` and `args` decoded from `topics` and `data`. */
    log: z
      .object({
        address: hexString,
        blockHash: hexString,
        blockNumber: z.bigint(),
        data: hexString,
        logIndex: z.number().int().nonnegative(),
        removed: z.boolean(),
        topics: z.array(hexString),
        transactionHash: hexString,
        transactionIndex: z.number().int().nonnegative(),
        eventName: z.string(),
        args: z.record(z.string(), z.unknown()),
      })
      .strict(),
    blockTimestamp: z.bigint(),
    /** `from` of the log's transaction; the deposit callback reads it. */
    transactionFrom: hexString.optional(),
  })
  .strict()
  .refine((d) => d.log.eventName === d.eventName, "log.eventName differs from eventName");

const apiBodyData = z
  .object({
    route: z.string().startsWith("/"),
    path: z.string().startsWith("/"),
    status: z.number().int(),
    /** File in `services/explorer-ui-v2/src/api/` whose schemas parse this body. */
    uiModule: z.string(),
    body: z.unknown(),
  })
  .strict();

export const FIXTURE_DATA_SCHEMAS = {
  "l2-block": l2BlockData,
  checkpoint: checkpointData,
  "node-info": nodeInfoData,
  "l2-tips": l2TipsData,
  frame: frameData,
  "l1-log": l1LogData,
  "api-body": apiBodyData,
} as const;

export type FixtureKind = keyof typeof FIXTURE_DATA_SCHEMAS;
export const FIXTURE_KINDS = Object.keys(FIXTURE_DATA_SCHEMAS) as FixtureKind[];

export type FixtureData = {
  [K in FixtureKind]: z.infer<(typeof FIXTURE_DATA_SCHEMAS)[K]>;
};

const fixtureFeatureSchema = z.union([
  z.enum([
    "empty",
    "public-logs",
    "public-data-writes",
    "class-publish",
    "instance-deploy",
    "multi-block-checkpoint",
    /** Hand-written where no public source yields the input; `origin` says why. */
    "synthetic",
  ]),
  /** The block belongs to the recorded checkpoint `<n>`. */
  z.string().regex(/^checkpoint-\d+$/),
]);
export type FixtureFeature = z.infer<typeof fixtureFeatureSchema>;

export const fixtureEnvelopeSchema = z
  .object({
    format: z.literal(FIXTURE_FORMAT),
    kind: z.enum(FIXTURE_KINDS as [FixtureKind, ...FixtureKind[]]),
    source: z.enum(FIXTURE_SOURCES),
    aztecVersion: z.string(),
    recordedAt: z.string().datetime(),
    /** The call that produced `data`, never a URL. */
    origin: z.string(),
    features: z.array(fixtureFeatureSchema),
    data: z.unknown(),
  })
  .strict();

export type FixtureEnvelope = z.infer<typeof fixtureEnvelopeSchema>;

export type Fixture<K extends FixtureKind> = Omit<
  FixtureEnvelope,
  "kind" | "data"
> & { kind: K; data: FixtureData[K] };

/**
 * JSON-safe form of a value: bigint → `{"$bigint"}`, bytes → `{"$hex"}`,
 * Date → `{"$date"}`; `undefined` object values are dropped, as JSON drops them.
 */
export const toTagged = (value: unknown): unknown => {
  if (typeof value === "bigint") {
    return { $bigint: value.toString() };
  }
  if (value instanceof Uint8Array) {
    return { $hex: Buffer.from(value).toString("hex") };
  }
  if (value instanceof Date) {
    return { $date: value.toISOString() };
  }
  if (Array.isArray(value)) {
    return value.map(toTagged);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, toTagged(v)]),
    );
  }
  return value;
};

const TAG_VALUE = {
  $bigint: /^-?\d+$/,
  $hex: /^(?:[0-9a-f]{2})*$/,
  $date: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
} as const;

/**
 * Inverse of {@link toTagged}. Keys starting with `$` are reserved: an object
 * holding one must be exactly one well-formed tag, else this throws.
 */
export const fromTagged = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(fromTagged);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.some(([k]) => k.startsWith("$"))) {
    return Object.fromEntries(entries.map(([k, v]) => [k, fromTagged(v)]));
  }
  const [tag, raw] = entries[0] ?? [];
  const pattern = TAG_VALUE[tag as keyof typeof TAG_VALUE] as RegExp | undefined;
  if (entries.length !== 1 || !pattern || typeof raw !== "string" || !pattern.test(raw)) {
    throw new Error(`malformed tagged value under key ${String(tag)}`);
  }
  if (tag === "$bigint") {
    return BigInt(raw);
  }
  if (tag === "$hex") {
    return Buffer.from(raw, "hex");
  }
  return new Date(raw);
};
