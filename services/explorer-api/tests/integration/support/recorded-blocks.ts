import {
  type Canonical,
  type FixtureSource,
  type Stack,
  REPO_ROOT,
  canonical,
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

/** The recorded blocks of one source in chain order, as aztec-listener publishes them. */
export const recordedBlocks = (source: FixtureSource) =>
  listFixtures(source, "l2-block")
    .map((name) => {
      const { data } = loadFixture(source, "l2-block", name);
      const event: NewBlockEvent = {
        blockNumber: data.expected.height,
        statusHint: "proposed",
        block: data.hex,
      };
      return { name, expected: data.expected, event };
    })
    .sort((a, b) => a.expected.height - b.expected.height);

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

// The node's own times come from its payload and the frozen clock; only its
// error rows are stamped by Postgres (`defaultNow()`).
export const rpcNodeSnapshotOf = (value: unknown): Canonical => {
  if (!isPlainObject(value)) {
    throw new TypeError("rpc node body is not an object");
  }
  const { errors, ...node } = value;
  return {
    ...(canonical(node) as Record<string, Canonical>),
    ...(errors === undefined
      ? {}
      : {
          errors: canonical(errors, {
            dbTimeKeys: ["createdAt", "lastSeenAt"],
          }),
        }),
  };
};

type ProducerFrame = { eventType: string; bson: string };

/** The consumer-side payload of a frame aztec-listener's producer test committed. */
export const producerFrameData = (name: string, eventType: string): unknown => {
  const frames = JSON.parse(
    readFileSync(
      join(
        REPO_ROOT,
        "services/aztec-listener/tests/characterization/__snapshots__/producer-frames.json.snap",
      ),
      "utf8",
    ),
  ) as Record<string, ProducerFrame | undefined>;
  const frame = frames[name];
  if (frame?.eventType !== eventType) {
    throw new Error(`no ${eventType} frame named ${name}`);
  }
  const bytes = new Uint8Array(Buffer.from(frame.bson, "hex"));
  return (BSON.deserialize(bytes) as { data: unknown }).data;
};

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

type OpenApiSchema = {
  type?: string | string[];
  required?: string[];
  items?: OpenApiSchema;
  anyOf?: OpenApiSchema[];
  oneOf?: OpenApiSchema[];
  properties?: Record<string, unknown>;
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

const objectVariant = (schema: OpenApiSchema): OpenApiSchema =>
  [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].find(
    (variant) => variant.properties !== undefined,
  ) ?? schema;

/**
 * The `required` keys of a GET route's 200 JSON schema in the generated
 * document, and whether that schema describes an array of such objects.
 */
export const requiredKeysOf = (spec: unknown, openApiPath: string) => {
  const schema = (spec as OpenApiDocument).paths?.[openApiPath]?.get
    ?.responses?.["200"]?.content?.["application/json"]?.schema;
  if (!schema) {
    throw new Error(`no GET 200 JSON schema for ${openApiPath}`);
  }
  // OpenAPI 3.1 allows a list of types (e.g. ["object", "null"]).
  const isArray = [schema.type].flat().includes("array");
  const element = objectVariant(isArray ? (schema.items ?? {}) : schema);
  return { isArray, required: element.required ?? [] };
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
