import {
  type RegisterJobDefinitionCommandInput,
  type SubmitJobCommandInput,
} from "@aws-sdk/client-batch";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type JobState } from "../../src/svcs/job-manager/backend.js";
import { createAwsBatchBackend } from "../../src/svcs/job-manager/backends/aws-batch.js";
import { createK8sBackend } from "../../src/svcs/job-manager/backends/k8s.js";
import { jobName } from "../../src/svcs/job-manager/naming.js";
import {
  buildCompileScript,
  buildReaderScript,
} from "../../src/svcs/job-manager/scripts.js";

const mocks = vi.hoisted(() => {
  // environment.ts parses these at import; the aws-batch backend refuses to start without them.
  process.env.AWS_BATCH_JOB_QUEUE = "compile-queue";
  process.env.AWS_BATCH_EXECUTION_ROLE_ARN =
    "arn:aws:iam::000000000000:role/compile";
  return {
    createNamespacedJob: vi.fn(),
    listNamespacedPod: vi.fn(),
    readNamespacedPod: vi.fn(),
    readNamespacedPodLog: vi.fn(),
    batchSend: vi.fn(),
  };
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
      return {
        createNamespacedJob: mocks.createNamespacedJob,
        listNamespacedPod: mocks.listNamespacedPod,
        readNamespacedPod: mocks.readNamespacedPod,
        readNamespacedPodLog: mocks.readNamespacedPodLog,
      };
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

/** Answers the Batch calls a launch makes, and `extra` by command name. */
const stubBatch = (extra: Record<string, unknown> = {}) =>
  mocks.batchSend.mockImplementation(
    (command: { constructor: { name: string } }) => {
      const name = command.constructor.name;
      const response = {
        DescribeJobDefinitionsCommand: { jobDefinitions: [] },
        RegisterJobDefinitionCommand: {
          jobDefinitionArn: "arn:job-definition",
        },
        SubmitJobCommand: { jobId: "batch-job" },
        ...extra,
      }[name];
      return response
        ? Promise.resolve(response)
        : Promise.reject(new Error(`unexpected ${name}`));
    },
  );

/** Inputs of every `commandName` sent to Batch so far. */
const sentInputs = <Input>(commandName: string): Input[] =>
  mocks.batchSend.mock.calls
    .map(
      ([command]) => command as { constructor: { name: string }; input: Input },
    )
    .filter((command) => command.constructor.name === commandName)
    .map((command) => command.input);

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
    const commands = buildCompileScript(gitRef, subPath).split(" && ");
    expect(commands).toEqual(
      expect.arrayContaining([
        `git clone "$GIT_URL" /workspace/repo`,
        `git checkout "$GIT_REF"`,
        `cd "/workspace/repo/$SUB_PATH"`,
        `SOURCE_ROOT="/workspace/repo/$SUB_PATH"`,
      ]),
    );
    for (const value of [githubUrl, gitRef, subPath]) {
      expect(commands.filter((command) => command.includes(value))).toEqual([]);
    }

    const defaults = buildCompileScript().split(" && ");
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
    stubBatch();
    const backend = createAwsBatchBackend();
    await backend.init();
    const state = jobState();

    await backend.launch(state, scripts);

    const submits = sentInputs<SubmitJobCommandInput>("SubmitJobCommand");
    expect(submits).toHaveLength(1);
    const [input] = submits;
    expect(input).toMatchObject({
      jobName: state.backendJobName,
      containerOverrides: {
        command: [
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

describe("memory kill", () => {
  it("reads a Kubernetes memory kill from a container's terminated reason", async () => {
    mocks.listNamespacedPod.mockResolvedValue({
      items: [{ metadata: { name: "compile-pod" } }],
    });
    mocks.readNamespacedPodLog.mockResolvedValue("");
    mocks.readNamespacedPod.mockResolvedValue({
      status: {
        initContainerStatuses: [
          { state: { terminated: { reason: "OOMKilled" } } },
        ],
      },
    });
    const backend = createK8sBackend();
    await backend.init();

    expect(await backend.readLogs(jobState())).toMatchObject({
      outOfMemory: true,
    });
  });

  it("reads an AWS Batch memory kill from the container's reason", async () => {
    stubBatch({
      DescribeJobsCommand: {
        jobs: [
          {
            status: "FAILED",
            container: {
              reason: "OutOfMemoryError: Container killed due to memory usage",
            },
          },
        ],
      },
    });
    const backend = createAwsBatchBackend();
    await backend.init();
    const state = jobState();
    await backend.launch(state, scripts);

    expect(await backend.readLogs(state)).toMatchObject({ outOfMemory: true });
  });
});

// The integration harness's Redis image: small, pinned, and has /bin/sh.
const STAND_IN_BASE_IMAGE =
  "redis:7.2-alpine@sha256:2f66de68111e64c3927859f158f8e666066dae2b97d9f82770a6f37a5aa1c335";

const docker = (
  args: string[],
  { input, timeout = 120_000 }: { input?: string; timeout?: number } = {},
) =>
  spawnSync("docker", args, {
    encoding: "utf8",
    input,
    timeout,
    // A job's output carries its whole artifact, several MB.
    maxBuffer: 256 * 1024 * 1024,
  });

const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 }).status ===
  0;

// GitHub's runners have Docker, so there a missing daemon fails rather than skips.
describe.skipIf(!dockerAvailable && process.env.GITHUB_ACTIONS !== "true")(
  "AWS Batch job in an image with the compiler image's entrypoint",
  () => {
    const image = `chicmoz-batch-entrypoint-test:${randomUUID()}`;
    const containers: string[] = [];

    beforeAll(() => {
      // Docker applies only the last ENTRYPOINT.
      const entrypoint = readFileSync(
        new URL(
          "../../../event-cannon/Dockerfile.compile-contracts",
          import.meta.url,
        ),
        "utf8",
      )
        .match(/^ENTRYPOINT\s.*$/gim)
        ?.at(-1);
      expect(entrypoint).toBeDefined();
      const build = docker(["build", "--quiet", "--tag", image, "-"], {
        input: `FROM ${STAND_IN_BASE_IMAGE}\n${entrypoint}\n`,
      });
      expect(build.status, build.stderr).toBe(0);
    }, 180_000);

    afterAll(() => {
      if (containers.length > 0) {
        docker(["rm", "--force", "--volumes", ...containers]);
      }
      docker(["image", "rm", "--force", image]);
    });

    /** Runs `command` as the container's CMD, which is what Batch does with a job's `command`. */
    const runAsBatchJob = (command: string[] = []) => {
      const name = `chicmoz-batch-entrypoint-test-${randomUUID()}`;
      containers.push(name);
      const { status, stdout, stderr } = docker([
        "run",
        "--rm",
        "--name",
        name,
        "--network",
        "none",
        image,
        ...command,
      ]);
      return { status, stdout, stderr };
    };

    it("runs the job's script and returns its output and exit code", async () => {
      stubBatch();
      const backend = createAwsBatchBackend();
      await backend.init();
      // A fresh image, so this launch registers its own job definition.
      const state = {
        ...jobState(),
        compilerImage: `contract-compiler:${randomUUID()}`,
      };

      await backend.launch(state, {
        compileScript: "echo compile-ran",
        readerScript: "echo reader-ran && exit 7",
      });

      const [definition] = sentInputs<RegisterJobDefinitionCommandInput>(
        "RegisterJobDefinitionCommand",
      ).filter(
        (input) => input.containerProperties?.image === state.compilerImage,
      );
      const [submit] = sentInputs<SubmitJobCommandInput>(
        "SubmitJobCommand",
      ).filter((input) => input.jobName === state.backendJobName);
      expect({
        job: runAsBatchJob(submit?.containerOverrides?.command),
        placeholder: runAsBatchJob(definition?.containerProperties?.command),
      }).toMatchObject({
        job: { status: 7, stdout: "compile-ran\nreader-ran\n" },
        placeholder: { status: 0, stdout: "chicmoz-compiler-placeholder\n" },
      });
    }, 60_000);
  },
);

// An image built from Dockerfile.compile-contracts for the Aztec version
// ExplorerShowcase pins, e.g. contract-compiler:6.0.0 from
// scripts/build_contract_compiler.sh. Building one pulls a 2 GB Aztec image,
// so unset, the block is skipped.
const compilerImage = process.env.CONTRACT_COMPILER_IMAGE ?? "";

type Artifact = { functions: { name: string; verification_key?: string }[] };

const verificationKeys = ({ functions }: Artifact) =>
  Object.fromEntries(
    functions.flatMap(({ name, verification_key: key }) =>
      key ? [[name, key]] : [],
    ),
  );

describe.skipIf(!compilerImage)(
  "AWS Batch compile job in the compiler image, with no network",
  () => {
    const contract = fileURLToPath(
      new URL(
        "../../../event-cannon/src/contract-projects/ExplorerShowcase",
        import.meta.url,
      ),
    );
    // The job clones this volume's repository instead of GitHub.
    const source = `chicmoz-compile-source-${randomUUID()}`;
    const containers: string[] = [];

    afterAll(() => {
      if (containers.length > 0) {
        docker(["rm", "--force", ...containers]);
      }
      docker(["volume", "rm", "--force", source]);
    });

    const runOffline = (args: string[], timeout?: number) => {
      const name = `chicmoz-compile-test-${randomUUID()}`;
      containers.push(name);
      return docker(
        ["run", "--rm", "--name", name, "--network", "none", ...args],
        { timeout },
      );
    };

    it("compiles a contract and derives its private functions' verification keys", async () => {
      // Without target/, the job compiles from source instead of reusing the committed artifact.
      const seeded = runOffline([
        "--volume",
        `${contract}:/contract:ro`,
        "--volume",
        `${source}:/source`,
        compilerImage,
        "cp -R /contract/. /source && rm -rf /source/target && cd /source && git init -q && git add -A && git -c user.name=test -c user.email=test@localhost commit -qm source",
      ]);
      expect(seeded.status, seeded.stderr).toBe(0);

      stubBatch();
      const backend = createAwsBatchBackend();
      await backend.init();
      const state: JobState = {
        ...jobState(),
        githubUrl: "/source",
        gitRef: undefined,
        subPath: undefined,
        compilerImage,
      };
      await backend.launch(state, {
        compileScript: buildCompileScript(state.gitRef, state.subPath),
        readerScript: buildReaderScript(),
      });
      const [submit] = sentInputs<SubmitJobCommandInput>(
        "SubmitJobCommand",
      ).filter((input) => input.jobName === state.backendJobName);

      const job = runOffline(
        [
          "--volume",
          `${source}:/source:ro`,
          ...(submit?.containerOverrides?.environment ?? []).flatMap(
            ({ name = "", value = "" }) => ["--env", `${name}=${value}`],
          ),
          compilerImage,
          ...(submit?.containerOverrides?.command ?? []),
        ],
        600_000,
      );
      expect(
        job.status,
        `${job.stdout.slice(-4000)}\n${job.stderr.slice(-4000)}`,
      ).toBe(0);

      // Keys derived from the wrong CRS points would differ from the committed ones.
      const artifact =
        /===ARTIFACT_START===\n([\s\S]*?)\n===ARTIFACT_END===/.exec(
          job.stdout,
        )?.[1];
      expect(artifact).toBeDefined();
      const committed = readFileSync(
        `${contract}/target/explorer_showcase-ExplorerShowcase.json`,
        "utf8",
      );
      expect(verificationKeys(JSON.parse(artifact ?? "") as Artifact)).toEqual(
        verificationKeys(JSON.parse(committed) as Artifact),
      );
    }, 660_000);
  },
);
