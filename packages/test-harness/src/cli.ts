import { HARNESS_LABEL, downProject, listProjects } from "./stack.js";

const [command, runId] = process.argv.slice(2);

const main = async () => {
  if (command === "ls") {
    const projects = await listProjects();
    if (projects.length === 0) {
      process.stdout.write("no harness projects on this host\n");
      return;
    }
    for (const p of projects) {
      process.stdout.write(
        `${p.runId}\t${p.states}\t${p.created}\t${p.worktree}\n`,
      );
    }
    return;
  }
  if (command === "down" && runId) {
    if (!(await listProjects()).some((p) => p.runId === runId)) {
      throw new Error(
        `no project ${runId} with label ${HARNESS_LABEL}; nothing removed`,
      );
    }
    await downProject(runId);
    process.stdout.write(`removed ${runId}\n`);
    return;
  }
  throw new Error("usage: yarn harness ls | yarn harness down <run id>");
};

main().catch((e: Error) => {
  process.stderr.write(`${e.message}\n`);
  process.exitCode = 1;
});
