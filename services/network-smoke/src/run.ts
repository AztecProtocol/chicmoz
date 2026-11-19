import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Stack, up } from "@chicmoz/test-harness";
import { readConfig } from "./config.js";
import { ENDPOINTS_ENV, type Endpoints } from "./endpoints.js";
import { L1_CHAIN_ID, startAnvil, startAztecNode } from "./network.js";
import { freePorts } from "./ports.js";
import { createProcessGroups } from "./processes.js";
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

export const RUN_ID_PATTERN = /^ns[0-9a-f]{10}$/;

export type RunRecord = {
  runId: string;
  ownerPid: number;
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
 * Starts the pipeline, runs the assertions in a Vitest child and tears down
 * everything it started. Vitest never owns a process: its CLI exits on
 * SIGINT before any async cleanup of its own hooks could run.
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
  const record: RunRecord = { runId, ownerPid: process.pid };
  const saveRecord = () =>
    writeFileSync(join(runDir, "run.json"), JSON.stringify(record));
  saveRecord();
  const tmp = tmpDirs(runId, runDir);
  const nodeTmp = createTmpDir(tmp.node);
  const walletTmp = createTmpDir(tmp.wallet);

  const t0 = Date.now();
  const mark = (name: string) => {
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    appendFileSync(join(runDir, "marks.txt"), `${seconds} ${name}\n`);
    process.stdout.write(`network-smoke [+${seconds}s] ${name}\n`);
  };
  process.stdout.write(`network-smoke: run ${runId} in ${runDir}\n`);

  const groups = createProcessGroups(runId, runDir);
  const abort = new AbortController();
  // Setup work that cannot be cancelled (compose up, migrations, npm ci);
  // teardown waits for it so a stack that comes up late is still removed.
  const inFlight: Promise<unknown>[] = [];
  const track = <T>(work: Promise<T>) => {
    inFlight.push(work.catch(() => undefined));
    return work;
  };
  let stack: Stack | undefined;
  let stackRemoved = false;
  let vitest: ChildProcess | undefined;

  process.on("exit", () => {
    groups.killAllSync();
    vitest?.kill("SIGKILL");
    if (stack && !stackRemoved) {
      try {
        execFileSync(
          "docker",
          [
            "compose",
            "-p",
            stack.runId,
            "down",
            "-v",
            "--remove-orphans",
            "--timeout",
            "0",
          ],
          { stdio: "ignore" },
        );
      } catch {
        // `yarn harness ls` still lists it.
      }
    }
  });

  let teardown: Promise<void> | undefined;
  const tearDown = (failed: boolean) =>
    (teardown ??= (async () => {
      abort.abort();
      vitest?.kill("SIGTERM");
      await groups.stopAll();
      await Promise.all(inFlight);
      // A stage that passed its abort check just before the abort may have
      // started one more process.
      await groups.stopAll();
      if (stack) {
        if (failed) {
          await stack.saveLogs().catch(() => undefined);
        }
        await stack.down();
        stackRemoved = true;
      }
      removeTmpDir(tmp.node);
      removeTmpDir(tmp.wallet);
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

    const infra = track(
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
    const chain = track(
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
    const [infraResult, chainResult] = await Promise.allSettled([infra, chain]);
    if (infraResult.status === "rejected") {
      throw infraResult.reason;
    }
    if (chainResult.status === "rejected") {
      throw chainResult.reason;
    }
    abort.signal.throwIfAborted();

    startServices(groups, {
      stack: infraResult.value,
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
    const child = spawn(
      process.execPath,
      [vitestBin, "run", "--config", "vitest.smoke.config.ts"],
      {
        cwd: PACKAGE_DIR,
        stdio: "inherit",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          TERM: process.env.TERM ?? "dumb",
          CI: process.env.CI ?? "",
          // The wallet's stores are temporary LMDB files under TMPDIR.
          TMPDIR: walletTmp,
          [ENDPOINTS_ENV]: JSON.stringify(endpoints),
        },
      },
    );
    vitest = child;
    const code = await new Promise<number>((resolve) =>
      child.on("exit", (exitCode) => resolve(exitCode ?? 1)),
    );
    mark(`tests exited ${code}`);
    for (const death of groups.deaths) {
      const name = death.split(" ")[0];
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
