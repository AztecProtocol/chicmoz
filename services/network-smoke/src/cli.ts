import { existsSync, readFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { downProject, listProjects } from "@chicmoz/test-harness";
import { readConfig } from "./config.js";
import { readPgids, stopGroup } from "./processes.js";
import { RUN_ID_PATTERN, type RunRecord, run } from "./run.js";
import { removeTmpDir, tmpDirs } from "./tmp.js";

/**
 * Recovery after the runner itself was killed: stops the run's process
 * groups, removes its compose project and its TMPDIR links. Only a run
 * whose owner is gone.
 */
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
  if (existsSync(`/proc/${record.ownerPid}`)) {
    const cmdline = readFileSync(`/proc/${record.ownerPid}/cmdline`, "utf8");
    if (cmdline.includes("cli.js")) {
      throw new Error(
        `run ${runId} is still owned by pid ${record.ownerPid}; stop that instead`,
      );
    }
  }
  for (const pgid of readPgids(runDir).reverse()) {
    await stopGroup(pgid, runId);
  }
  if (record.composeRunId) {
    const projects = await listProjects();
    if (projects.some((p) => p.runId === record.composeRunId)) {
      await downProject(record.composeRunId);
      process.stdout.write(`removed compose project ${record.composeRunId}\n`);
    }
  } else {
    process.stdout.write(
      "no compose project recorded; if the run died while starting it, see `yarn harness ls`\n",
    );
  }
  for (const dir of Object.values(tmpDirs(runId, runDir))) {
    removeTmpDir(dir);
  }
  process.stdout.write(`run ${runId} is down\n`);
};

const [command, arg] = process.argv.slice(2);

const main = async () => {
  if (command === "run") {
    process.exitCode = await run();
    return;
  }
  if (command === "down" && arg) {
    await down(arg);
    return;
  }
  throw new Error("usage: cli.js run | cli.js down <run id>");
};

main().catch((e: Error) => {
  process.stderr.write(`${e.message}\n`);
  process.exitCode = 1;
});
