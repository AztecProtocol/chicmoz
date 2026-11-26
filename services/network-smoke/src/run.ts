import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type L2_MESSAGES,
  withKafkaNamespace,
} from "@chicmoz-pkg/message-registry";
import { COMPOSE_FILE, REPO_ROOT, type Stack, up } from "@chicmoz/test-harness";
import { readConfig } from "./config.js";
import {
  ENDPOINTS_ENV,
  type Endpoints,
  type PruneEndpoints,
  type ScriptedEndpoints,
} from "./endpoints.js";
import { createTopic } from "./kafka.js";
import {
  L1_CHAIN_ID,
  startAnvil,
  startAztecNode,
  startLocalNetwork,
} from "./network.js";
import { releasePorts } from "./port-registry.js";
import { claimRunPorts } from "./ports.js";
import { createProcessGroups, startTimeOf } from "./processes.js";
import { type RpcTap, startRpcTap } from "./rpc-tap.js";
import {
  SMOKE_NETWORK,
  type ServiceName,
  missingBuilds,
  prepareDatabases,
  startServices,
} from "./services.js";
import { createTmpDir, removeTmpDir, tmpDirs } from "./tmp.js";
import { type Toolchain, prepareToolchain } from "./toolchain.js";
import { httpOk, rpc, waitUntil } from "./wait.js";

const PACKAGE_DIR = fileURLToPath(new URL("../", import.meta.url));
const CLI = fileURLToPath(new URL("./cli.js", import.meta.url));
// Per-test timeouts bound each test; this bounds Vitest itself.
const SUITE_TIMEOUT_MS = 15 * 60_000;

export type Mode = "network" | "scripted" | "prune";

const ALL_SERVICES = [
  "explorer-api",
  "ethereum-listener",
  "aztec-listener",
  "websocket-event-publisher",
] as const satisfies readonly ServiceName[];

// A scenario judges what the blocks alone do to the explorer, so the API's
// repair loop, whose first pass comes 2 min after it starts, stays out.
const NO_REPAIR = {
  "explorer-api": { L2_BLOCK_RECONCILIATION_INTERVAL_MS: String(3_600_000) },
};

// Kafka keeps order only within a partition, so a run on several shows
// whether blocks still reach the API in order.
const BLOCK_PARTITIONS = 3;
const BLOCK_TOPIC: keyof L2_MESSAGES = "NEW_BLOCK_EVENT";

const MODES: Record<
  Mode,
  {
    /** `stock`: `aztec start --local-network`; `launcher`: the same network with epoch auto-settle off. */
    node: "stock" | "launcher" | "scripted";
    services: readonly ServiceName[];
    vitestConfig: string;
    extraEnv?: Partial<Record<ServiceName, Record<string, string>>>;
    blockPartitions?: number;
    /** The listener reads the node through `rpc-tap.ts`, which records its tip reads. */
    tapListener?: boolean;
  }
> = {
  network: {
    node: "stock",
    services: ALL_SERVICES,
    vitestConfig: "vitest.smoke.config.ts",
  },
  // The scripted node has no L1, and the scenario reads only the REST API.
  scripted: {
    node: "scripted",
    services: ["explorer-api", "aztec-listener"],
    vitestConfig: "vitest.scripted.config.ts",
    extraEnv: NO_REPAIR,
    blockPartitions: BLOCK_PARTITIONS,
  },
  prune: {
    node: "launcher",
    services: ALL_SERVICES,
    vitestConfig: "vitest.prune.config.ts",
    extraEnv: NO_REPAIR,
    blockPartitions: BLOCK_PARTITIONS,
    tapListener: true,
  },
};

export const RUN_ID_PATTERN = /^ns[0-9a-f]{10}$/;

export type RunRecord = {
  runId: string;
  ownerPid: number;
  /** With the pid, identifies the owner even after the pid is reused. */
  ownerStart?: string;
  composeRunId?: string;
};

const tail = (file: string, lines = 20) => {
  try {
    return readFileSync(file, "utf8")
      .trimEnd()
      .split("\n")
      .slice(-lines)
      .join("\n");
  } catch {
    return "(no log)";
  }
};

/**
 * The run owner. Vitest only asserts: its CLI exits on SIGINT before its own
 * async hooks could tear anything down. `network` runs a real local network;
 * `prune` runs it with epoch auto-settle off, so a scenario can have it
 * prune; `scripted` runs the scripted node in its place (`scripted-node.ts`).
 */
export const run = async (mode: Mode): Promise<number> => {
  if (platform() !== "linux") {
    throw new Error("the network smoke run needs Linux (/proc)");
  }
  const {
    node,
    services,
    vitestConfig,
    extraEnv,
    blockPartitions,
    tapListener,
  } = MODES[mode];
  const missing = missingBuilds(services);
  if (missing.length > 0) {
    throw new Error(`run \`yarn build\` first; missing ${missing.join(", ")}`);
  }
  const config = readConfig();
  const runId = `ns${randomBytes(5).toString("hex")}`;
  // generateL2TopicName's name, under this run's namespace.
  const blockTopic = withKafkaNamespace(
    `${SMOKE_NETWORK}__${BLOCK_TOPIC}`,
    runId,
  );
  const runDir = join(config.dir, runId);
  const logDir = join(runDir, "logs");
  mkdirSync(logDir, { recursive: true });
  const record: RunRecord = {
    runId,
    ownerPid: process.pid,
    ownerStart: startTimeOf(process.pid),
  };
  const saveRecord = () => {
    const file = join(runDir, "run.json");
    writeFileSync(`${file}.tmp`, JSON.stringify(record));
    renameSync(`${file}.tmp`, file);
  };
  saveRecord();
  const tmp = tmpDirs(runId, runDir);

  const t0 = Date.now();
  const mark = (name: string) => {
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    appendFileSync(join(runDir, "marks.txt"), `${seconds} ${name}\n`);
    process.stdout.write(`network-smoke [+${seconds}s] ${name}\n`);
  };
  process.stdout.write(`network-smoke: run ${runId} in ${runDir}\n`);

  const groups = createProcessGroups(runId, runDir);
  const abort = new AbortController();
  const inFlight: Promise<unknown>[] = [];
  const track = <T>(work: Promise<T>) => {
    inFlight.push(work.catch(() => undefined));
    return work;
  };
  let stack: Stack | undefined;
  let stackRemoved = false;
  let tap: RpcTap | undefined;

  process.on("exit", () => {
    groups.killAllSync();
    if (stack && !stackRemoved) {
      try {
        execFileSync(
          "docker",
          [
            "compose",
            "-p",
            stack.runId,
            "-f",
            COMPOSE_FILE,
            "--profile",
            "infra",
            "down",
            "-v",
            "--remove-orphans",
            "--timeout",
            "0",
          ],
          {
            cwd: REPO_ROOT,
            stdio: "ignore",
            timeout: 60_000,
            killSignal: "SIGKILL",
          },
        );
      } catch {
        // `yarn harness ls` still lists it.
      }
    }
    removeTmpDir(tmp.node);
    removeTmpDir(tmp.wallet);
  });

  let teardown: Promise<boolean> | undefined;
  const tearDown = (failed: boolean) =>
    (teardown ??= (async () => {
      abort.abort();
      await groups.stopAll();
      // Compose up and migrations cannot be cancelled: every started setup
      // operation settles before the project is removed, so a project that
      // comes up late is removed too.
      await Promise.all(inFlight);
      // A stage that passed its abort check just before the abort may have
      // started one more process.
      const stuck = await groups.stopAll();
      if (stuck.length > 0) {
        process.stderr.write(
          `network-smoke: still running after SIGKILL: ${stuck.join(", ")}; the run's ports stay claimed until this runner exits, and \`down ${runId}\` stops what is left\n`,
        );
      }
      let released = false;
      try {
        if (stack) {
          if (failed) {
            await stack.saveLogs().catch(() => undefined);
          }
          await stack.down();
          stackRemoved = true;
        }
      } finally {
        removeTmpDir(tmp.node);
        removeTmpDir(tmp.wallet);
        await tap?.close();
        // Only once every group stopped: a survivor may still bind a port.
        if (stuck.length === 0) {
          released = await releasePorts(runId);
        }
      }
      mark("torn down");
      return stuck.length === 0 && released;
    })());

  let signalled = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (signalled) {
      // Second signal: no grace; the exit hook kills what is left.
      process.exit(130);
    }
    signalled = true;
    process.stderr.write(`network-smoke: ${signal}, tearing down ${runId}\n`);
    void tearDown(true).finally(() =>
      process.exit(signal === "SIGINT" ? 130 : 143),
    );
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, onSignal);
  }

  const deathOf = (name: string) => () => {
    const death = groups.deaths.find((d) => d.startsWith(`${name} `));
    return death ? `${death}\n${tail(join(logDir, `${name}.log`))}` : undefined;
  };

  let failed = true;
  let clean = false;
  try {
    const nodeTmp = createTmpDir(tmp.node);
    const walletTmp = createTmpDir(tmp.wallet);
    let toolchain: Toolchain | undefined;
    if (node !== "scripted") {
      toolchain = await track(
        prepareToolchain({
          toolchainDir: config.toolchainDir,
          foundryBinDir: config.foundryBinDir,
          runId,
          log: join(logDir, "npm-ci.log"),
          signal: abort.signal,
        }),
      );
      mark("toolchain ready");
      abort.signal.throwIfAborted();
    }

    const ports = await track(
      claimRunPorts({
        runId,
        ownerPid: process.pid,
        worktree: REPO_ROOT,
        fixed: config.ports,
      }),
    );
    const anvilUrl = `http://127.0.0.1:${ports.anvil}`;
    const aztecNodeUrl = `http://127.0.0.1:${ports.aztec}`;
    const explorerApiUrl = `http://127.0.0.1:${ports.explorerApi}`;
    // The scripted node has no admin API; its control API takes that port.
    const controlUrl = `http://127.0.0.1:${ports.aztecAdmin}`;

    // The first failure aborts the other branch and goes straight to
    // teardown, which still drains every tracked setup operation.
    const failFast = <T>(work: Promise<T>) =>
      track(
        work.catch((reason: unknown) => {
          abort.abort();
          throw reason;
        }),
      );
    const infra = failFast(
      (async () => {
        const started = await up();
        stack = started;
        record.composeRunId = started.runId;
        saveRecord();
        mark(`infra up (${started.runId})`);
        abort.signal.throwIfAborted();
        await prepareDatabases(started, services, abort.signal);
        mark("migrated");
        if (blockPartitions !== undefined) {
          abort.signal.throwIfAborted();
          await createTopic(started, blockTopic, blockPartitions);
          mark(`${blockTopic} has ${blockPartitions} partitions`);
        }
        return started;
      })(),
    );
    const localNetwork = async (tools: Toolchain) => {
      startAnvil(groups, tools, ports, runDir);
      await waitUntil(
        "anvil",
        async () => Number(await rpc(anvilUrl, "eth_chainId")) === L1_CHAIN_ID,
        { timeoutMs: 30_000, dead: deathOf("anvil"), signal: abort.signal },
      );
      mark("anvil ready");
      abort.signal.throwIfAborted();
      (node === "launcher" ? startLocalNetwork : startAztecNode)(
        groups,
        tools,
        ports,
        runDir,
        nodeTmp,
      );
      await waitUntil(
        "aztec node",
        async () => (await rpc(aztecNodeUrl, "node_getBlockNumber")) !== null,
        {
          timeoutMs: 240_000,
          dead: deathOf("aztec-node"),
          signal: abort.signal,
        },
      );
      mark("aztec node ready");
    };
    const scriptedNode = async () => {
      groups.start(
        "scripted-node",
        process.execPath,
        [
          "--enable-source-maps",
          CLI,
          "scripted-node",
          String(ports.aztec),
          String(ports.aztecAdmin),
        ],
        // The SDK's hashing backend puts a Unix socket under TMPDIR.
        { cwd: runDir, tier: 1, env: { TMPDIR: nodeTmp } },
      );
      // Not a tip read: the scenario counts those as the listener's polls.
      await waitUntil(
        "scripted node",
        async () => (await rpc(aztecNodeUrl, "node_getNodeInfo")) !== null,
        {
          timeoutMs: 60_000,
          dead: deathOf("scripted-node"),
          signal: abort.signal,
        },
      );
      mark("scripted node ready");
    };
    const chain = failFast(
      toolchain === undefined ? scriptedNode() : localNetwork(toolchain),
    );
    const [infraStack] = await Promise.all([infra, chain]);
    abort.signal.throwIfAborted();

    const rpcTapFile = join(logDir, "rpc-tap.jsonl");
    if (tapListener) {
      // The launcher serves no admin API; the tap takes that port.
      tap = await startRpcTap({
        port: ports.aztecAdmin,
        upstream: aztecNodeUrl,
        file: rpcTapFile,
      });
    }
    startServices(groups, services, {
      stack: infraStack,
      ports,
      runId,
      anvilUrl: node === "scripted" ? undefined : anvilUrl,
      extraEnv,
      aztecNodeUrl: tap?.url ?? aztecNodeUrl,
    });
    const alive = () => services.map((name) => deathOf(name)()).find(Boolean);
    await waitUntil("explorer-api", () => httpOk(`${explorerApiUrl}/health`), {
      timeoutMs: 60_000,
      dead: alive,
      signal: abort.signal,
    });
    if (services.includes("websocket-event-publisher")) {
      await waitUntil(
        "websocket-event-publisher",
        () => httpOk(`http://127.0.0.1:${ports.wsHealth}/health`),
        { timeoutMs: 60_000, dead: alive, signal: abort.signal },
      );
    }
    mark("services ready");
    abort.signal.throwIfAborted();

    const common = {
      runId,
      logDir,
      aztecNodeUrl,
      explorerApiUrl,
      consumerLogs: [...services],
      broker: {
        brokers: infraStack.env.KAFKA_CONNECTION,
        username: infraStack.env.KAFKA_SASL_USERNAME,
        password: infraStack.env.KAFKA_SASL_PASSWORD,
        blockTopic,
        // getConsumerGroupId's ids: `<service>_<network>_<handler>`.
        apiGroupPrefix: withKafkaNamespace(
          `explorer-api_${SMOKE_NETWORK}_`,
          runId,
        ),
      },
    };
    const endpoints: Endpoints | PruneEndpoints | ScriptedEndpoints =
      node === "scripted"
        ? { ...common, controlUrl }
        : {
            ...common,
            anvilUrl,
            wsUrl: `ws://127.0.0.1:${ports.ws}`,
            ...(tap ? { rpcTapFile } : {}),
          };
    const vitestBin = join(
      dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
      "vitest.mjs",
    );
    const vitest = groups.start(
      "vitest",
      process.execPath,
      [vitestBin, "run", "--config", vitestConfig],
      {
        cwd: PACKAGE_DIR,
        tier: 3,
        inheritOutput: true,
        exitIsDeath: false,
        env: {
          TERM: process.env.TERM ?? "dumb",
          CI: process.env.CI ?? "",
          TMPDIR: walletTmp,
          [ENDPOINTS_ENV]: JSON.stringify(endpoints),
        },
      },
    );
    let timer: NodeJS.Timeout | undefined;
    const code = await new Promise<number | string>((resolve) => {
      vitest.child.on("exit", (exitCode) => resolve(exitCode ?? "a signal"));
      vitest.child.on("error", (e) => resolve(e.message));
      timer = setTimeout(
        () => resolve(`no result within ${SUITE_TIMEOUT_MS / 60_000} min`),
        SUITE_TIMEOUT_MS,
      );
    });
    clearTimeout(timer);
    mark(`tests exited ${code}`);
    for (const death of groups.deaths) {
      const name = death.split(/[ :]/)[0];
      process.stderr.write(
        `network-smoke: ${death} during the run\n${tail(join(logDir, `${name}.log`))}\n`,
      );
    }
    failed = code !== 0 || groups.deaths.length > 0;
  } catch (e) {
    process.stderr.write(`network-smoke: ${(e as Error).message}\n`);
  } finally {
    clean = await tearDown(failed);
  }
  const passed = !failed && clean;
  process.stdout.write(
    `network-smoke: ${passed ? "passed" : "FAILED"}; logs in ${logDir}\n`,
  );
  return passed ? 0 : 1;
};
