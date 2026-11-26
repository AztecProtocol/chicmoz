import { existsSync, readFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { downProject } from "@chicmoz/test-harness";
import { readConfig } from "./config.js";
import { releasePorts } from "./port-registry.js";
import { ownerAlive, readPgids, stopGroup } from "./processes.js";
import { RUN_ID_PATTERN, type RunRecord, run } from "./run.js";
import { removeTmpDir, tmpDirs } from "./tmp.js";

const HARNESS_RUN_ID = /^ih[0-9a-f]{10}$/;

/** Cleans up after a runner that was killed; refuses while it still runs. */
const down = async (runId: string) => {
  if (platform() !== "linux") {
    throw new Error("down needs Linux (/proc)");
  }
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`"${runId}" is not a network smoke run id (ns + 10 hex)`);
  }
  const runDir = join(readConfig().dir, runId);
  const recordFile = join(runDir, "run.json");
  if (!existsSync(recordFile)) {
    throw new Error(`no run ${runId} in ${runDir}`);
  }
  const record = JSON.parse(readFileSync(recordFile, "utf8")) as RunRecord;
  if (ownerAlive(record)) {
    throw new Error(
      `run ${runId} is still owned by pid ${record.ownerPid}; stop that instead`,
    );
  }
  const stuck: number[] = [];
  let released = false;
  try {
    for (const pgid of readPgids(runDir).reverse()) {
      if (!(await stopGroup(pgid, runId))) {
        stuck.push(pgid);
      }
    }
    // Printed now, so a compose failure below cannot hide them.
    if (stuck.length > 0) {
      process.stderr.write(
        `run ${runId}: process groups ${stuck.join(", ")} still running after SIGKILL\n`,
      );
    }
    if (record.composeRunId) {
      // Not gated on `listProjects()`: it lists containers, and an
      // interrupted teardown can leave only the network or a volume.
      if (!HARNESS_RUN_ID.test(record.composeRunId)) {
        throw new Error(
          `run ${runId}: "${record.composeRunId}" is not a harness run id`,
        );
      }
      await downProject(record.composeRunId);
      process.stdout.write(`removed compose project ${record.composeRunId}\n`);
    } else {
      process.stdout.write(
        "no compose project recorded; if the run died while starting it, see `yarn harness ls`\n",
      );
    }
  } finally {
    for (const dir of Object.values(tmpDirs(runId, runDir))) {
      removeTmpDir(dir);
    }
    // Only once every group stopped: a survivor may still bind a port.
    released = stuck.length === 0 && (await releasePorts(runId));
  }
  if (stuck.length > 0) {
    throw new Error(
      `run ${runId} is not down: process groups survived, so its port claims stay listed (their runner is gone, so other tools may reap them)`,
    );
  }
  if (!released) {
    throw new Error(
      `run ${runId} is not down: its port claims could not be released`,
    );
  }
  process.stdout.write(`run ${runId} is down\n`);
};

const portOf = (value: string) => {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`"${value}" is not a port`);
  }
  return port;
};

const [command, ...args] = process.argv.slice(2);

const main = async () => {
  if (command === "run" && args.length === 0) {
    process.exitCode = await run("network");
    return;
  }
  if (
    command === "run" &&
    args.length === 1 &&
    (args[0] === "scripted" || args[0] === "prune")
  ) {
    process.exitCode = await run(args[0]);
    return;
  }
  if (command === "down" && args.length === 1) {
    await down(args[0]);
    return;
  }
  // A child of `run scripted`; it serves until the run stops its group.
  if (command === "scripted-node" && args.length === 2) {
    // Imported here, so `run` and `down` never load the SDK.
    const { startScriptedNode } = await import("./scripted-node.js");
    const node = await startScriptedNode({
      rpcPort: portOf(args[0]),
      controlPort: portOf(args[1]),
    });
    process.stdout.write(
      `scripted node: rpc ${node.rpcUrl}, control ${node.controlUrl}\n`,
    );
    return;
  }
  throw new Error(
    "usage: cli.js run [scripted | prune] | cli.js down <run id> | cli.js scripted-node <rpc port> <control port>",
  );
};

main().catch((e: Error) => {
  process.stderr.write(`${e.message}\n`);
  process.exitCode = 1;
});
