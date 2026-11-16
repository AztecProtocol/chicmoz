import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { REPO_ROOT } from "./repo.js";

const execFileAsync = promisify(execFile);

export const COMPOSE_FILE = join(
  REPO_ROOT,
  "packages",
  "test-harness",
  "compose",
  "compose.yaml",
);
/** Label on every harness container; `ls` and `down` act only on projects that carry it. */
export const HARNESS_LABEL = "chicmoz.harness=1";

const RUN_ID = /^[a-z][a-z0-9]{2,30}$/;
const WAIT_SECONDS = 120;

/** What a process on the host needs to reach the stack, in the services' own env names. */
export type StackEnv = {
  POSTGRES_IP: string;
  POSTGRES_PORT: string;
  POSTGRES_ADMIN: string;
  POSTGRES_PASSWORD: string;
  KAFKA_CONNECTION: string;
  KAFKA_SASL_USERNAME: string;
  KAFKA_SASL_PASSWORD: string;
  REDIS_HOST: string;
  REDIS_PORT: string;
};

/** The serializable part of a stack, as handed from Vitest's global setup to test files. */
export type StackInfo = { runId: string; runDir: string; env: StackEnv };

export type Stack = StackInfo & {
  exec(service: string, cmd: readonly string[]): Promise<string>;
  saveLogs(): Promise<void>;
  /** `down -v --remove-orphans`; safe to call twice. */
  down(): Promise<void>;
};

const compose = async (
  runId: string,
  args: readonly string[],
  timeout = 60_000,
): Promise<string> => {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      [
        "compose",
        "-p",
        runId,
        "-f",
        COMPOSE_FILE,
        "--profile",
        "infra",
        ...args,
      ],
      { cwd: REPO_ROOT, timeout, maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout;
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr?.trim();
    throw new Error(
      `docker compose ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`,
    );
  }
};

const hostPort = async (runId: string, service: string, port: number) => {
  const out = (await compose(runId, ["port", service, String(port)])).trim();
  const match = /^127\.0\.0\.1:(\d+)$/.exec(out);
  if (!match) {
    throw new Error(
      `${service}:${port} is not bound to 127.0.0.1 (got "${out}")`,
    );
  }
  return match[1];
};

export const newRunId = () => `ih${randomBytes(5).toString("hex")}`;

export const runDirOf = (runId: string) => join(REPO_ROOT, ".harness", runId);

const execIn = (runId: string, service: string, cmd: readonly string[]) =>
  compose(runId, ["exec", "-T", service, ...cmd]);

const saveLogs = async (runId: string) => {
  const logs = await compose(runId, ["logs", "--no-color", "--timestamps"]);
  writeFileSync(join(runDirOf(runId), "compose.log"), logs);
};

/** Removes compose project `runId` with its volumes; a no-op when it is gone. */
export const downProject = async (runId: string): Promise<void> => {
  await compose(runId, ["down", "-v", "--remove-orphans", "--timeout", "5"]);
};

/** Binds the Docker operations of a running stack to its run id. */
export const attach = (info: StackInfo): Stack => ({
  ...info,
  exec: (service, cmd) => execIn(info.runId, service, cmd),
  saveLogs: () => saveLogs(info.runId),
  down: () => downProject(info.runId),
});

/**
 * Starts the `infra` profile (Postgres, Kafka, Redis) as compose project
 * `runId` and waits until every service is healthy. On failure the logs land
 * in `.harness/<runId>/compose.log` and the project is removed.
 */
export const up = async ({
  runId = process.env.HARNESS_RUN_ID ?? newRunId(),
}: { runId?: string } = {}): Promise<Stack> => {
  if (!RUN_ID.test(runId)) {
    throw new Error(`run id "${runId}" must match ${RUN_ID}`);
  }
  const runDir = runDirOf(runId);
  mkdirSync(runDir, { recursive: true });
  process.stderr.write(
    `harness: starting run ${runId} (logs in .harness/${runId}/)\n`,
  );

  try {
    await compose(runId, ["up", "-d"], WAIT_SECONDS * 1000);
    const kafkaPort = await hostPort(runId, "kafka", 19092);
    // Containers reach the broker as kafka:9092, the host through its assigned port.
    await execIn(runId, "kafka", [
      "sh",
      "-c",
      `echo SASL_PLAINTEXT://kafka:9092,EXTERNAL://127.0.0.1:${kafkaPort} > /tmp/advertised`,
    ]);
    await compose(
      runId,
      ["up", "-d", "--wait", "--wait-timeout", String(WAIT_SECONDS)],
      (WAIT_SECONDS + 30) * 1000,
    );
    const env: StackEnv = {
      POSTGRES_IP: "127.0.0.1",
      POSTGRES_PORT: await hostPort(runId, "postgres", 5432),
      POSTGRES_ADMIN: "admin",
      POSTGRES_PASSWORD: "secret-local-password",
      KAFKA_CONNECTION: `127.0.0.1:${kafkaPort}`,
      KAFKA_SASL_USERNAME: "controller_user",
      KAFKA_SASL_PASSWORD: "test",
      REDIS_HOST: "127.0.0.1",
      REDIS_PORT: await hostPort(runId, "redis", 6379),
    };
    process.stderr.write(`harness: run ${runId} is up\n`);
    return attach({ runId, runDir, env });
  } catch (e) {
    await saveLogs(runId).catch(() => undefined);
    await downProject(runId).catch(() => undefined);
    throw new Error(
      `harness run ${runId} did not start: ${
        (e as Error).message
      }; logs in .harness/${runId}/compose.log`,
    );
  }
};

export type HarnessProject = {
  runId: string;
  worktree: string;
  created: string;
  states: string;
};

/** Harness projects on this Docker host, from any worktree. */
export const listProjects = async (): Promise<HarnessProject[]> => {
  const { stdout } = await execFileAsync("docker", [
    "ps",
    "-a",
    "--filter",
    `label=${HARNESS_LABEL}`,
    "--format",
    '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.CreatedAt}}\t{{.State}}',
  ]);
  const projects = new Map<string, HarnessProject>();
  for (const line of stdout.split("\n").filter(Boolean)) {
    const [runId, workingDir, created, state] = line.split("\t");
    const project = projects.get(runId);
    if (project) {
      project.states = `${project.states},${state}`;
      project.created = created < project.created ? created : project.created;
    } else {
      projects.set(runId, {
        runId,
        worktree: workingDir.replace(/\/packages\/test-harness\/compose$/, ""),
        created,
        states: state,
      });
    }
  }
  return [...projects.values()];
};
