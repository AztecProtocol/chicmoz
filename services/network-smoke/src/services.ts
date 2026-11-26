import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type MigratingService,
  REPO_ROOT,
  type Stack,
  createDatabase,
  runMigrateEntrypoint,
} from "@chicmoz/test-harness";
import { type Ports } from "./ports.js";
import { type ProcessGroups } from "./processes.js";
import { settleAll } from "./wait.js";

type Service = {
  entry: string;
  nodeArgs: readonly string[];
  database?: string;
};

const STRICT = ["--unhandled-rejections=strict", "--enable-source-maps"];

// Entry points and Node flags as in each service's `start` script.
export const SERVICES = {
  "explorer-api": {
    entry: "build/src/index.js",
    nodeArgs: STRICT,
    database: "explorer_api_sandbox",
  },
  "ethereum-listener": {
    entry: "build/src/index.js",
    nodeArgs: STRICT,
    database: "ethereum_listener_sandbox",
  },
  "aztec-listener": {
    entry: "build/src/index.js",
    nodeArgs: [],
    database: "aztec_listener_sandbox",
  },
  "websocket-event-publisher": { entry: "build/index.js", nodeArgs: STRICT },
} as const satisfies Record<string, Service>;

export type ServiceName = keyof typeof SERVICES;

/** Every run's `L2_NETWORK_ID`; topic names start with it. */
export const SMOKE_NETWORK = "SANDBOX";

const serviceDir = (name: string) => join(REPO_ROOT, "services", name);

/** The runner starts what `yarn build` produced; it never builds. */
export const missingBuilds = (names: readonly ServiceName[]): string[] =>
  names
    .flatMap((name) => {
      const svc: Service = SERVICES[name];
      return [
        join(serviceDir(name), svc.entry),
        ...(svc.database
          ? [join(serviceDir(name), "build", "scripts", "migrate.js")]
          : []),
      ];
    })
    .filter((path) => !existsSync(path));

export const prepareDatabases = (
  stack: Stack,
  names: readonly ServiceName[],
  signal: AbortSignal,
) =>
  settleAll(
    names.flatMap((name) => {
      const { database }: Service = SERVICES[name];
      return database
        ? [
            (async () => {
              await createDatabase(stack, database);
              signal.throwIfAborted();
              await runMigrateEntrypoint(
                stack,
                name as MigratingService,
                database,
              );
            })(),
          ]
        : [];
    }),
  );

export const startServices = (
  groups: ProcessGroups,
  names: readonly ServiceName[],
  {
    stack,
    ports,
    runId,
    anvilUrl,
    aztecNodeUrl,
    extraEnv = {},
  }: {
    stack: Stack;
    ports: Ports;
    runId: string;
    /** Only the ethereum-listener reads it. */
    anvilUrl?: string;
    aztecNodeUrl: string;
    /** Per service, on top of the env below. */
    extraEnv?: Partial<Record<ServiceName, Record<string, string>>>;
  },
) => {
  const common = {
    ...stack.env,
    NODE_ENV: "production",
    L2_NETWORK_ID: SMOKE_NETWORK,
    KAFKA_NAMESPACE: runId,
  };
  const env: Record<ServiceName, () => Record<string, string>> = {
    "explorer-api": () => ({
      PORT: String(ports.explorerApi),
      INSTANCE_NAME: "smoke-explorer-api",
      // Production has no default for it: the OpenAPI page's key field.
      PUBLIC_API_KEY: "dev-api-key",
      // Seconds. The defaults (60 and 10) would serve a block cached before
      // its L1 proposal arrived for a minute.
      CACHE_TTL: "5",
      CACHE_LATEST_TTL: "2",
      // The block stream starts an empty listener store at the finalized
      // block, so the blocks below it reach the API through reconciliation.
      L2_BLOCK_RECONCILIATION_INTERVAL_MS: "5000",
    }),
    "ethereum-listener": () => {
      if (anvilUrl === undefined) {
        throw new Error("the ethereum-listener needs an L1 node");
      }
      return {
        INSTANCE_NAME: "smoke-ethereum-listener",
        LISTEN_FOR_BLOCKS: "true",
        ETHEREUM_HTTP_RPC_URL: anvilUrl,
        ETHEREUM_WS_RPC_URL: anvilUrl.replace(/^http/, "ws"),
      };
    },
    "aztec-listener": () => ({
      INSTANCE_NAME: "smoke-aztec-listener",
      AZTEC_RPC_URLS: `sandbox::${aztecNodeUrl}`,
      BLOCK_POLL_INTERVAL_MS: "1000",
      // Tips that arrive before their blocks are degraded until the next
      // tips event; the 60 s default heartbeat would hold that for a minute.
      L2_TIPS_HEARTBEAT_INTERVAL_MS: "5000",
    }),
    "websocket-event-publisher": () => ({
      PORT: String(ports.ws),
      // This service reads the broker address under its own name.
      KAFKA_CONNECTION_URL: stack.env.KAFKA_CONNECTION,
    }),
  };
  return names.map((name) => {
    const svc: Service = SERVICES[name];
    return groups.start(name, process.execPath, [...svc.nodeArgs, svc.entry], {
      cwd: serviceDir(name),
      tier: 2,
      env: {
        ...common,
        ...env[name](),
        ...extraEnv[name],
        ...(svc.database ? { POSTGRES_DB_NAME: svc.database } : {}),
      },
    });
  });
};
