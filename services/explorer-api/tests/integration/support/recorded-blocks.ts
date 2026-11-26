import {
  type Canonical,
  type FixtureSource,
  type Stack,
  REPO_ROOT,
  canonical,
  frameBytes,
  listFixtures,
  loadFixture,
} from "@chicmoz/test-harness";
import { type NewBlockEvent } from "@chicmoz-pkg/message-registry";
import { type CacheKeys } from "@chicmoz-pkg/redis-helper";
import { BSON } from "bson";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// explorer-api modules read their environment at import, so everything from
// src is imported dynamically, after startExplorerApiForTest().

/** The recorded blocks of one source in chain order, as one ordered pass of aztec-listener. */
export const recordedBlocks = (source: FixtureSource) => {
  const fixtures = listFixtures(source, "l2-block").map(
    (name) => [name, loadFixture(source, "l2-block", name).data] as const,
  );
  const tip = Math.max(...fixtures.map(([, data]) => data.expected.height));
  return fixtures
    .map(([name, data]) => {
      const event: NewBlockEvent = {
        blockNumber: data.expected.height,
        statusHint: "proposed",
        block: data.hex,
        ordered: { tip },
      };
      return { name, expected: data.expected, event };
    })
    .sort((a, b) => a.expected.height - b.expected.height);
};

/** Bytecode, artifacts and class-publish logs run to hundreds of kilobytes per copy. */
const BULKY_KEYS = new Set([
  "artifactJson",
  "packedBytecode",
  "contractClassLogs",
]);
const BULKY_BYTES = 1024;

const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  Object.getPrototypeOf(value) === Object.prototype;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const shapeOf = (value: unknown) =>
  Array.isArray(value)
    ? `array(${value.length})`
    : isPlainObject(value)
      ? `object{${Object.keys(value).sort().join(",")}}`
      : typeof value;

// A bulky value becomes a digest of its canonical JSON, which still changes
// with the value, its type or its encoding; a database uuid becomes a marker.
const prepare = (value: unknown, dbUuidKeys: ReadonlySet<string>): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => prepare(item, dbUuidKeys));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (dbUuidKeys.has(key)) {
        if (typeof item !== "string" || !UUID.test(item)) {
          throw new TypeError(`${key} is not a database uuid`);
        }
        return [key, "<database uuid>"];
      }
      if (BULKY_KEYS.has(key)) {
        const json = JSON.stringify(canonical(item));
        if (json.length > BULKY_BYTES) {
          return [
            key,
            {
              sha256: sha256Hex(json),
              bytes: json.length,
              shape: shapeOf(item),
            },
          ];
        }
      }
      return [key, prepare(item, dbUuidKeys)];
    }),
  );
};

export type DbFilled = {
  /** Keys holding a time the database fills (`defaultNow()`, `NOW()`). */
  dbTimeKeys?: readonly string[];
  /** Keys holding a uuid the database generates (`defaultRandom()`). */
  dbUuidKeys?: readonly string[];
};

/** Canonical snapshot form with database-filled values masked. */
export const snapshotOf = (
  value: unknown,
  { dbTimeKeys = [], dbUuidKeys = [] }: DbFilled = {},
): Canonical => canonical(prepare(value, new Set(dbUuidKeys)), { dbTimeKeys });

type ProducerFrame = { eventType: string; bson: string };

const PRODUCER_FRAMES = {
  "aztec-listener":
    "services/aztec-listener/tests/characterization/__snapshots__/producer-frames.json.snap",
  "ethereum-listener":
    "services/ethereum-listener/tests/__snapshots__/l1-frames.json.snap",
} as const;

/** The consumer-side payload of a frame a producer test committed (aztec-listener's by default). */
export const producerFrameData = (
  name: string,
  eventType: string,
  producer: keyof typeof PRODUCER_FRAMES = "aztec-listener",
): unknown => {
  const frames = JSON.parse(
    readFileSync(join(REPO_ROOT, PRODUCER_FRAMES[producer]), "utf8"),
  ) as Record<string, ProducerFrame | undefined>;
  const frame = frames[name];
  if (frame?.eventType !== eventType) {
    throw new Error(`no ${eventType} frame named ${name}`);
  }
  const bytes = new Uint8Array(Buffer.from(frame.bson, "hex"));
  return (BSON.deserialize(bytes) as { data: unknown }).data;
};

/** The consumer-side payload of a recorded local-network frame fixture. */
export const recordedFrameData = (name: string): unknown =>
  (
    BSON.deserialize(
      frameBytes(loadFixture("local-network", "frame", name)),
    ) as {
      data: unknown;
    }
  ).data;

/** Redis access at the exact key string explorer-api builds for `keys`. */
export const cacheAt = (stack: Stack, namespace: string, keys: CacheKeys) => {
  const key = [namespace, "SANDBOX", ...keys].join("-");
  return {
    key,
    /** The stored string, byte for byte; throws when the key is absent. */
    stored: async () => {
      const exists = await stack.exec("redis", ["redis-cli", "EXISTS", key]);
      if (exists.trim() !== "1") {
        throw new Error(`no cache entry at ${key}`);
      }
      const out = await stack.exec("redis", ["redis-cli", "GET", key]);
      return out.endsWith("\n") ? out.slice(0, -1) : out;
    },
    remove: async () => {
      await stack.exec("redis", ["redis-cli", "DEL", key]);
    },
    // Through explorer-api's own client: a value this size exceeds one argv entry.
    seed: async (value: string) => {
      const { setEntry } = await import("@chicmoz-pkg/redis-helper");
      await setEntry(keys, value, 600);
    },
  };
};

const FIXED = {
  iso: "2000-01-01T00:00:00.000Z",
  uuid: "00000000-0000-4000-8000-000000000000",
} as const;

// The exact form a Date takes through JSON.stringify, so a writer that starts
// sending another form fails here instead of being masked.
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const HOLDS: Record<keyof typeof FIXED, (value: unknown) => boolean> = {
  iso: (value) => typeof value === "string" && ISO_TIME.test(value),
  uuid: (value) => typeof value === "string" && UUID.test(value),
};

/** A value the database fills at `path` (`"*"` steps into every array element). */
export type DbFilledAt = { path: readonly string[]; wire: keyof typeof FIXED };

const fixAt = (
  value: unknown,
  [head, ...rest]: readonly string[],
  wire: keyof typeof FIXED,
): number => {
  if (head === "*") {
    if (!Array.isArray(value)) {
      throw new TypeError("expected an array");
    }
    return value.reduce<number>((n, item) => n + fixAt(item, rest, wire), 0);
  }
  if (!isPlainObject(value) || !Object.hasOwn(value, head)) {
    throw new TypeError(`no ${head}`);
  }
  if (rest.length > 0) {
    return fixAt(value[head], rest, wire);
  }
  if (!HOLDS[wire](value[head])) {
    throw new TypeError(`${head} is not a database-filled ${wire}`);
  }
  value[head] = FIXED[wire];
  return 1;
};

/**
 * The writer's cache string with every database-filled value replaced by a
 * fixed one of the same wire type; every other byte is the writer's.
 */
export const normalizedCacheString = (
  stored: string,
  filled: readonly DbFilledAt[],
): string => {
  const parsed: unknown = JSON.parse(stored);
  // Holds unless JSON.stringify would reorder integer-like keys or respell a
  // number or an escape, any of which would hide a writer change.
  if (JSON.stringify(parsed) !== stored) {
    throw new Error("the cache string does not round-trip through JSON");
  }
  for (const { path, wire } of filled) {
    if (fixAt(parsed, path, wire) === 0) {
      throw new Error(`nothing at ${path.join("/")}`);
    }
  }
  return JSON.stringify(parsed);
};

type OpenApiSchema = {
  type?: string | string[];
  required?: string[];
  items?: OpenApiSchema;
  anyOf?: OpenApiSchema[];
  oneOf?: OpenApiSchema[];
  properties?: Record<string, OpenApiSchema>;
  nullable?: boolean;
};

type OpenApiDocument = {
  paths?: Record<
    string,
    | {
        get?: {
          responses?: Record<
            string,
            { content?: Record<string, { schema?: OpenApiSchema }> }
          >;
        };
      }
    | undefined
  >;
};

/** GET routes whose document schema names no required key anywhere. */
const NO_REQUIRED_KEYS: Record<string, string> = {
  "/l2/dropped-txs/{hash}":
    "the document describes the body as an object without properties",
};

const jsonTypeOf = (value: unknown) =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

const variantsOf = (schema: OpenApiSchema) => [
  ...(schema.anyOf ?? []),
  ...(schema.oneOf ?? []),
];

const hasRequiredKeys = (schema: OpenApiSchema): boolean =>
  (schema.required?.length ?? 0) > 0 ||
  Object.values(schema.properties ?? {}).some(hasRequiredKeys) ||
  (schema.items !== undefined && hasRequiredKeys(schema.items)) ||
  variantsOf(schema).some(hasRequiredKeys);

// OpenAPI 3.1 allows a list of types (e.g. ["object", "null"]).
const declares = (schema: OpenApiSchema, type: string) =>
  [schema.type].flat().includes(type) ||
  (type === "number" && [schema.type].flat().includes("integer")) ||
  (type === "null" && schema.nullable === true) ||
  (type === "object" && schema.properties !== undefined) ||
  (type === "array" && schema.items !== undefined);

const collectMismatches = (
  schema: OpenApiSchema,
  value: unknown,
  at: string,
  out: string[],
): void => {
  const type = jsonTypeOf(value);
  const variants = variantsOf(schema);
  const own =
    variants.length === 0
      ? schema
      : variants.find((variant) => declares(variant, type));
  if (type !== "object" && type !== "array") {
    // A scalar or null where only an object or array is documented would
    // otherwise skip every required key below it.
    const shapes = variants.length === 0 ? [schema] : variants;
    const allowed =
      (type === "null" && schema.nullable === true) ||
      shapes.some(
        (s) =>
          declares(s, type) ||
          (s.type === undefined &&
            s.properties === undefined &&
            s.items === undefined),
      );
    if (
      !allowed &&
      shapes.some((s) => declares(s, "object") || declares(s, "array"))
    ) {
      out.push(`${at || "/"}: ${type}, not an object or array`);
    }
    return;
  }
  if (own === undefined) {
    return;
  }
  if (own.type !== undefined && !declares(own, type)) {
    out.push(`${at || "/"}: ${type}, not ${String(own.type)}`);
    return;
  }
  if (Array.isArray(value)) {
    const { items } = own;
    if (items) {
      value.forEach((item, i) =>
        collectMismatches(items, item, `${at}/${i}`, out),
      );
    }
    return;
  }
  const object = value as Record<string, unknown>;
  for (const key of own.required ?? []) {
    if (!Object.hasOwn(object, key)) {
      out.push(`${at}/${key}`);
    }
  }
  for (const [key, property] of Object.entries(own.properties ?? {})) {
    if (Object.hasOwn(object, key)) {
      collectMismatches(property, object[key], `${at}/${key}`, out);
    }
  }
};

/**
 * Where `body` departs from the GET route's 200 JSON schema in the generated
 * document: a required key absent at any depth, or an object or array where
 * the schema declares another type.
 */
export const documentMismatches = (
  spec: unknown,
  openApiPath: string,
  body: unknown,
): string[] => {
  const schema = (spec as OpenApiDocument).paths?.[openApiPath]?.get
    ?.responses?.["200"]?.content?.["application/json"]?.schema;
  if (!schema) {
    throw new Error(`no GET 200 JSON schema for ${openApiPath}`);
  }
  const listed = Object.hasOwn(NO_REQUIRED_KEYS, openApiPath);
  if (hasRequiredKeys(schema) === listed) {
    throw new Error(
      listed
        ? `${openApiPath} names required keys now: drop it from NO_REQUIRED_KEYS`
        : `${openApiPath} names no required key: list it in NO_REQUIRED_KEYS with the reason`,
    );
  }
  const out: string[] = [];
  collectMismatches(schema, body, "", out);
  return out;
};

/** Rows a cache test removes so that only its seeded entry can answer. */
export const removeRpcNodes = async () => {
  const { getDb } = await import("@chicmoz-pkg/postgres-helper");
  const { l2RpcNodeTable } = await import(
    "../../../src/svcs/database/schema/l2/rpc-node.js"
  );
  await getDb().delete(l2RpcNodeTable);
};

export const removeValidators = async () => {
  const { getDb } = await import("@chicmoz-pkg/postgres-helper");
  const { l1L2ValidatorTable } = await import(
    "../../../src/svcs/database/schema/l1/l2-validator.js"
  );
  await getDb().delete(l1L2ValidatorTable);
};

export const setInstanceSalt = async (address: string, salt: string) => {
  const { getDb } = await import("@chicmoz-pkg/postgres-helper");
  const { l2ContractInstanceDeployed: t } = await import(
    "../../../src/svcs/database/schema/l2contract/index.js"
  );
  await getDb().update(t).set({ salt }).where(eq(t.address, address));
};
