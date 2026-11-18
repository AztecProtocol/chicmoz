import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { type JobState } from "../../src/svcs/job-manager/backend.js";
import { createAwsBatchBackend } from "../../src/svcs/job-manager/backends/aws-batch.js";
import { createK8sBackend } from "../../src/svcs/job-manager/backends/k8s.js";
import { jobName } from "../../src/svcs/job-manager/naming.js";
import { buildCompileScript } from "../../src/svcs/job-manager/scripts.js";

const mocks = vi.hoisted(() => {
  // environment.ts parses these at import; the aws-batch backend refuses to start without them.
  process.env.AWS_BATCH_JOB_QUEUE = "compile-queue";
  process.env.AWS_BATCH_EXECUTION_ROLE_ARN =
    "arn:aws:iam::000000000000:role/compile";
  return { createNamespacedJob: vi.fn(), batchSend: vi.fn() };
});

vi.mock("../../src/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class {},
  CoreV1Api: class {},
  KubeConfig: class {
    loadFromDefault = vi.fn();
    makeApiClient() {
      return { createNamespacedJob: mocks.createNamespacedJob };
    }
  },
}));
vi.mock("@aws-sdk/client-batch", () => {
  class Command {
    constructor(readonly input: unknown) {}
  }
  return {
    BatchClient: class {
      send = mocks.batchSend;
    },
    DescribeJobDefinitionsCommand: class DescribeJobDefinitionsCommand extends Command {},
    DescribeJobsCommand: class DescribeJobsCommand extends Command {},
    ListJobsCommand: class ListJobsCommand extends Command {},
    RegisterJobDefinitionCommand: class RegisterJobDefinitionCommand extends Command {},
    SubmitJobCommand: class SubmitJobCommand extends Command {},
  };
});
vi.mock("@aws-sdk/client-cloudwatch-logs", () => ({
  CloudWatchLogsClient: class {},
  GetLogEventsCommand: class {},
}));

const githubUrl = "https://github.com/example/aztec-token";
const gitRef = "release/v1";
const subPath = "contracts/main";

const jobState = (): JobState => {
  const jobId = randomUUID();
  return {
    jobId,
    backendJobName: jobName(jobId),
    contractClassId: `0x${"ab".repeat(32)}`,
    version: 1,
    githubUrl,
    gitRef,
    subPath,
    aztecVersion: "v6.0.0",
    compilerImage: "contract-compiler:6.0.0",
    createdAt: new Date(),
  };
};

const scripts = {
  compileScript: "compile-script",
  readerScript: "reader-script",
};

/** Dotted paths of every string in `value` that contains `needle`. */
const pathsContaining = (value: unknown, needle: string, at = ""): string[] => {
  if (typeof value === "string") {
    return value.includes(needle) ? [at] : [];
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      pathsContaining(child, needle, at ? `${at}.${key}` : key),
    );
  }
  return [];
};

const K8S_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

describe("job naming", () => {
  it("names a job after its id within Kubernetes name rules", () => {
    const id = randomUUID();
    const names = [
      [jobName(id), `compile-${id}`],
      [jobName(id.toUpperCase()), `compile-${id}`],
      [jobName(`${id}_${id}`), `compile-${`${id}${id}`.slice(0, 40)}`],
    ];
    for (const [name, expected] of names) {
      expect(name).toBe(expected);
      expect(name).toMatch(K8S_NAME);
      expect(name.length).toBeLessThanOrEqual(63);
    }
  });
});

describe("compile script", () => {
  it("clones, checks out and enters the repository through the job's environment", () => {
    const commands = buildCompileScript(githubUrl, gitRef, subPath).split(
      " && ",
    );
    expect(commands).toEqual(
      expect.arrayContaining([
        `git clone "$GIT_URL" /workspace/repo`,
        `git checkout "$GIT_REF"`,
        `cd "/workspace/repo/$SUB_PATH"`,
        `SOURCE_ROOT="/workspace/repo/$SUB_PATH"`,
      ]),
    );
    const repoCommands = commands.filter((command) =>
      /^(git|cd|SOURCE_ROOT=)/.test(command),
    );
    for (const value of [githubUrl, gitRef, subPath]) {
      expect(repoCommands.filter((command) => command.includes(value))).toEqual(
        [],
      );
    }

    const defaults = buildCompileScript(githubUrl).split(" && ");
    expect(defaults).toContain("cd /workspace/repo");
    expect(
      defaults.filter((command) => command.startsWith("git checkout")),
    ).toEqual([]);
  });
});

describe("job spec", () => {
  it("passes the repository inputs to a Kubernetes job only as environment values", async () => {
    const backend = createK8sBackend();
    await backend.init();
    const state = jobState();

    await backend.launch(state, scripts);

    expect(mocks.createNamespacedJob).toHaveBeenCalledTimes(1);
    const [{ body: job }] = mocks.createNamespacedJob.mock.calls[0] as [
      { body: { metadata: { name: string } } },
    ];
    expect(job.metadata.name).toBe(state.backendJobName);
    expect(pathsContaining(job, githubUrl).sort()).toEqual([
      "metadata.annotations.chicmoz/github-url",
      "spec.template.spec.initContainers.0.env.1.value",
    ]);
    expect(pathsContaining(job, gitRef)).toEqual([
      "spec.template.spec.initContainers.0.env.3.value",
    ]);
    expect(pathsContaining(job, subPath)).toEqual([
      "spec.template.spec.initContainers.0.env.4.value",
    ]);
    expect(job).toMatchObject({
      spec: {
        template: {
          spec: {
            initContainers: [
              {
                command: ["/bin/sh", "-c"],
                args: [scripts.compileScript],
                env: [
                  { name: "NARGO_HOME" },
                  { name: "GIT_URL", value: githubUrl },
                  { name: "AZTEC_VERSION" },
                  { name: "GIT_REF", value: gitRef },
                  { name: "SUB_PATH", value: subPath },
                ],
              },
            ],
            containers: [
              { command: ["/bin/sh", "-c"], args: [scripts.readerScript] },
            ],
          },
        },
      },
    });
  });

  it("passes the repository inputs to an AWS Batch job only as environment values and tags", async () => {
    mocks.batchSend.mockImplementation(
      (command: { constructor: { name: string } }) => {
        switch (command.constructor.name) {
          case "DescribeJobDefinitionsCommand":
            return Promise.resolve({ jobDefinitions: [] });
          case "RegisterJobDefinitionCommand":
            return Promise.resolve({ jobDefinitionArn: "arn:job-definition" });
          case "SubmitJobCommand":
            return Promise.resolve({ jobId: "batch-job" });
          default:
            return Promise.reject(
              new Error(`unexpected ${command.constructor.name}`),
            );
        }
      },
    );
    const backend = createAwsBatchBackend();
    await backend.init();
    const state = jobState();

    await backend.launch(state, scripts);

    const submits = mocks.batchSend.mock.calls
      .map(
        ([command]) =>
          command as { constructor: { name: string }; input: unknown },
      )
      .filter((command) => command.constructor.name === "SubmitJobCommand");
    expect(submits).toHaveLength(1);
    const { input } = submits[0];
    expect(input).toMatchObject({
      jobName: state.backendJobName,
      containerOverrides: {
        command: [
          "/bin/sh",
          "-c",
          `set -e\nmkdir -p /output /workspace\n${scripts.compileScript}\n${scripts.readerScript}`,
        ],
        environment: [
          { name: "NARGO_HOME" },
          { name: "GIT_URL", value: githubUrl },
          { name: "AZTEC_VERSION" },
          { name: "GIT_REF", value: gitRef },
          { name: "SUB_PATH", value: subPath },
        ],
      },
    });
    expect(pathsContaining(input, githubUrl).sort()).toEqual([
      "containerOverrides.environment.1.value",
      "tags.chicmoz-github-url",
    ]);
    expect(pathsContaining(input, gitRef)).toEqual([
      "containerOverrides.environment.3.value",
    ]);
    expect(pathsContaining(input, subPath)).toEqual([
      "containerOverrides.environment.4.value",
    ]);
  });
});
