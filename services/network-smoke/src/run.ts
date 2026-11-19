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
import { COMPOSE_FILE, REPO_ROOT, type Stack, up } from "@chicmoz/test-harness";
import { readConfig } from "./config.js";
import { ENDPOINTS_ENV, type Endpoints } from "./endpoints.js";
import { L1_CHAIN_ID, startAnvil, startAztecNode } from "./network.js";
import { freePorts } from "./ports.js";
import { createProcessGroups, startTimeOf } from "./processes.js";
import {
  SERVICES,
  missingBuilds,
  prepareDatabases,
  startServices,
} from "./services.js";
import { createTmpDir, removeTmpDir, tmpDirs } from "./tmp.js";
import { prepareToolchain } from "./toolchain.js";
import { httpOk, rpc, waitUntil } from "./wait.js";

const PACKAGE_DIR = fileURLToPath(new URL("../", import.meta.url));
// Per-test timeouts bound each test; this bounds Vitest itself.
const SUITE_TIMEOUT_MS = 15 * 60_000;

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
 * async hooks could tear anything down.
 */
export const run = async (): Promise<number> => {
  if (platform() !== "linux") {
    throw new Error("the network smoke run needs Linux (/proc)");
  }
  const missing = missingBuilds();
  if (missing.length > 0) {
    throw new Error(`run \`yarn build\` first; missing ${missing.join(", ")}`);
  }
  const config = readConfig();
  const runId = `ns${randomBytes(5).toString("hex")}`;
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
          { cwd: REPO_ROOT, stdio: "ignore", timeout: 60_000 },
        );
      } catch {
        // `yarn harness ls` still lists it.
      }
    }
    removeTmpDir(tmp.node);
    removeTmpDir(tmp.wallet);
  });

  let teardown: Promise<void> | undefined;
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
      await groups.stopAll();
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
      }
      mark("torn down");
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
  try {
    const nodeTmp = createTmpDir(tmp.node);
    const walletTmp = createTmpDir(tmp.wallet);
    const toolchain = await track(
      prepareToolchain({
        toolchainDir: config.toolchainDir,
        foundryBinDir: config.foundryBinDir,
        runId,
        log: join(logDir, "npm-ci.log"),
      }),
    );
    mark("toolchain ready");
    abort.signal.throwIfAborted();

    const ports = config.ports ?? (await freePorts());
    const anvilUrl = `http://127.0.0.1:${ports.anvil}`;
    const aztecNodeUrl = `http://127.0.0.1:${ports.aztec}`;
    const explorerApiUrl = `http://127.0.0.1:${ports.explorerApi}`;

    // The first failure aborts the other branch instead of waiting for it.
    let firstFailure: { reason: unknown } | undefined;
    const failFast = <T>(work: Promise<T>) =>
      track(
        work.catch((reason: unknown) => {
          firstFailure ??= { reason };
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
        await prepareDatabases(started);
        mark("migrated");
        return started;
      })(),
    );
    const chain = failFast(
      (async () => {
        startAnvil(groups, toolchain, ports, runDir);
        await waitUntil(
          "anvil",
          async () =>
            Number(await rpc(anvilUrl, "eth_chainId")) === L1_CHAIN_ID,
          { timeoutMs: 30_000, dead: deathOf("anvil"), signal: abort.signal },
        );
        mark("anvil ready");
        abort.signal.throwIfAborted();
        startAztecNode(groups, toolchain, ports, runDir, nodeTmp);
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
      })(),
    );
    await Promise.allSettled([infra, chain]);
    if (firstFailure) {
      throw firstFailure.reason;
    }
    abort.signal.throwIfAborted();

    startServices(groups, {
      stack: await infra,
      ports,
      runId,
      anvilUrl,
      aztecNodeUrl,
    });
    const alive = () =>
      Object.keys(SERVICES)
        .map((name) => deathOf(name)())
        .find(Boolean);
    await waitUntil("explorer-api", () => httpOk(`${explorerApiUrl}/health`), {
      timeoutMs: 60_000,
      dead: alive,
      signal: abort.signal,
    });
    await waitUntil(
      "websocket-event-publisher",
      () => httpOk(`http://127.0.0.1:${ports.wsHealth}/health`),
      { timeoutMs: 60_000, dead: alive, signal: abort.signal },
    );
    mark("services ready");
    abort.signal.throwIfAborted();

    const endpoints: Endpoints = {
      runId,
      logDir,
      anvilUrl,
      aztecNodeUrl,
      explorerApiUrl,
      wsUrl: `ws://127.0.0.1:${ports.ws}`,
      consumerLogs: Object.keys(SERVICES),
    };
    const vitestBin = join(
      dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
      "vitest.mjs",
    );
    const vitest = groups.start(
      "vitest",
      process.execPath,
      [vitestBin, "run", "--config", "vitest.smoke.config.ts"],
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
    await tearDown(failed);
  }
  process.stdout.write(
    `network-smoke: ${failed ? "FAILED" : "passed"}; logs in ${logDir}\n`,
  );
  return failed ? 1 : 0;
};
