import { type Stack, type StackInfo, up } from "./stack.js";

/**
 * The body of a Vitest global setup: `start` brings up one `infra` stack per
 * run and returns what the setup hands to test files (`project.provide`);
 * `prepare` runs once the stack is healthy, for example to migrate a template
 * database. `stop` saves the logs and removes the stack unless HARNESS_KEEP=1.
 * It takes no Vitest types, so each consumer declares `ProvidedContext`
 * against its own Vitest install.
 */
export const harnessGlobalSetup = (
  prepare?: (stack: Stack) => Promise<void>,
) => {
  let stack: Stack | undefined;
  return {
    start: async (): Promise<StackInfo> => {
      stack = await up();
      await prepare?.(stack);
      return { runId: stack.runId, runDir: stack.runDir, env: stack.env };
    },
    stop: async (): Promise<void> => {
      if (stack === undefined) {
        return;
      }
      await stack.saveLogs();
      if (process.env.HARNESS_KEEP === "1") {
        process.stderr.write(
          `harness: kept run ${stack.runId}; remove it with: yarn harness down ${stack.runId}\n`,
        );
        return;
      }
      await stack.down();
      process.stderr.write(`harness: removed run ${stack.runId}\n`);
    },
  };
};
