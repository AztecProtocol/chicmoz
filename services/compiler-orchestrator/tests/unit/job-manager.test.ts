import { type EventHandler } from "@chicmoz-pkg/message-bus";
import {
  type CompileSourceRequestEvent,
  generateL2TopicName,
} from "@chicmoz-pkg/message-registry";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type JobLogs } from "../../src/svcs/job-manager/backend.js";
import {
  buildCompileScript,
  buildReaderScript,
} from "../../src/svcs/job-manager/scripts.js";

const nargoToml = (aztecTag: string) => `[package]
name = "token"
type = "contract"

[dependencies]
aztec = { git = "https://github.com/AztecProtocol/aztec-packages/", tag = "${aztecTag}", directory = "noir-projects/aztec-nr/aztec" }
`;

type GitCallback = (
  error: Error | null,
  output?: { stdout: string; stderr: string },
) => void;

const mocks = vi.hoisted(() => ({
  backend: {
    name: "test",
    init: vi.fn(),
    launch: vi.fn(),
    checkStatus: vi.fn(),
    readLogs: vi.fn(),
    getFailureReason: vi.fn(),
    recoverActiveJobs: vi.fn(),
    getConfigStr: vi.fn(),
  },
  execFile: vi.fn(),
  publishMessage: vi.fn(),
  startSubscribe: vi.fn(),
}));

vi.mock("../../src/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("../../src/svcs/job-manager/backends/k8s.js", () => ({
  createK8sBackend: () => mocks.backend,
}));
vi.mock("../../src/svcs/job-manager/backends/aws-batch.js", () => ({
  createAwsBatchBackend: () => mocks.backend,
}));
vi.mock("../../src/svcs/message-bus/index.js", () => ({
  publishMessage: mocks.publishMessage,
}));
vi.mock("@chicmoz-pkg/message-bus", () => ({
  startSubscribe: mocks.startSubscribe,
}));
vi.mock("child_process", () => ({ execFile: mocks.execFile }));

const POLL_INTERVAL_MS = 5000;

const request = (
  overrides: Partial<CompileSourceRequestEvent> = {},
): CompileSourceRequestEvent => ({
  jobId: randomUUID(),
  contractClassId: `0x${"ab".repeat(32)}`,
  version: 1,
  githubUrl: "https://github.com/example/aztec-token",
  gitRef: "release/v1",
  subPath: "contracts/main",
  ...overrides,
});

type JobManager = typeof import("../../src/svcs/job-manager/index.js");
let jobManager: JobManager | undefined;

/** The compile-request handler as the service subscribes it, on a fresh job manager. */
const subscribedHandler = async (): Promise<EventHandler> => {
  jobManager = await import("../../src/svcs/job-manager/index.js");
  const { subscribeHandlers } = await import(
    "../../src/svcs/message-bus/handlers.js"
  );
  await subscribeHandlers();
  expect(mocks.startSubscribe).toHaveBeenCalledTimes(1);
  return mocks.startSubscribe.mock.calls[0][0] as EventHandler;
};

const publishedResults = () =>
  mocks.publishMessage.mock.calls.map(([topic, payload]) => {
    expect(topic).toBe("COMPILE_SOURCE_RESULT_EVENT");
    return payload as Record<string, unknown>;
  });

/**
 * Starts a job, lets the backend report it finished with `logs`, and returns
 * the one result published for it; a later poll must not report it again.
 */
const finishJob = async (
  logs: JobLogs,
  status: "succeeded" | "failed" = "succeeded",
): Promise<Record<string, unknown>> => {
  const handler = await subscribedHandler();
  const event = request();
  await handler.cb(event);
  expect(mocks.backend.launch).toHaveBeenCalledTimes(1);
  mocks.backend.checkStatus.mockResolvedValue(status);
  mocks.backend.readLogs.mockResolvedValue(logs);
  jobManager?.startJobPoller();
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  await vi.waitFor(() => expect(mocks.publishMessage).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  expect(mocks.backend.checkStatus).toHaveBeenCalledTimes(1);
  const results = publishedResults();
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    jobId: event.jobId,
    contractClassId: event.contractClassId,
    version: event.version,
  });
  return results[0];
};

const COMPILE_LOG =
  "===STAGE:COMPILE===\nCompiling contract...\n===STAGE:SOURCE_EXTRACTION===\nDone.";
const COMMIT_HASH = "0123456789abcdef0123456789abcdef01234567";
const ARTIFACT_JSON = JSON.stringify({
  name: "Token",
  transpiled: true,
  functions: [],
});

/** One source record per line, as the reader script writes them: JSON with raw tabs and CRs. */
const sourceRecord = (path: string, content: string) =>
  JSON.stringify({ path, content })
    .replaceAll("\\t", "\t")
    .replaceAll("\\r", "\r");

const readerOutput = (sourceLines: string[]) =>
  [
    "===COMMIT_HASH_START===",
    COMMIT_HASH,
    "===COMMIT_HASH_END===",
    "===ARTIFACT_START===",
    ARTIFACT_JSON,
    "",
    "===ARTIFACT_END===",
    "===SOURCES_START===",
    ...sourceLines,
    "===SOURCES_END===",
    "",
  ].join("\n");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  mocks.execFile.mockImplementation(
    (
      _file: string,
      args: string[],
      _options: unknown,
      callback: GitCallback,
    ) => {
      if (args[0] !== "clone") {
        callback(null, { stdout: "", stderr: "" });
        return;
      }
      // A clone with one contract at its root and another, on a later Aztec version, under contracts/main.
      const dir = args[args.length - 1];
      mkdir(`${dir}/contracts/main`, { recursive: true })
        .then(() => writeFile(`${dir}/Nargo.toml`, nargoToml("v5.9.0")))
        .then(() =>
          writeFile(`${dir}/contracts/main/Nargo.toml`, nargoToml("v6.1.0")),
        )
        .then(
          () => callback(null, { stdout: "", stderr: "" }),
          (error: Error) => callback(error),
        );
    },
  );
  mocks.backend.launch.mockResolvedValue(undefined);
  mocks.publishMessage.mockResolvedValue(undefined);
});

afterEach(async () => {
  await jobManager?.jobManagerService.shutdown();
  jobManager = undefined;
  vi.useRealTimers();
  vi.resetAllMocks();
  // The job manager keeps its active jobs in module state.
  vi.resetModules();
});

describe("compile request handler", () => {
  it("starts exactly one compile job with the request's fields", async () => {
    const handler = await subscribedHandler();
    expect(handler.topic).toBe(
      generateL2TopicName("SANDBOX", "COMPILE_SOURCE_REQUEST_EVENT"),
    );
    const event = request();

    await handler.cb(event);

    expect(mocks.backend.launch).toHaveBeenCalledTimes(1);
    expect(mocks.backend.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: event.jobId,
        backendJobName: `compile-${event.jobId}`,
        contractClassId: event.contractClassId,
        version: event.version,
        githubUrl: event.githubUrl,
        gitRef: event.gitRef,
        subPath: event.subPath,
        aztecVersion: "v6.1.0",
        compilerImage: "contract-compiler:6.1.0",
      }),
      {
        compileScript: buildCompileScript(
          event.githubUrl,
          event.gitRef,
          event.subPath,
        ),
        readerScript: buildReaderScript(),
      },
    );
    expect(mocks.publishMessage).not.toHaveBeenCalled();
  });

  it("hands the repository inputs to git as separate arguments", async () => {
    const handler = await subscribedHandler();
    const event = request();

    await handler.cb(event);

    const gitCalls = mocks.execFile.mock.calls.map(
      ([file, args]) => [file, args] as [string, string[]],
    );
    expect(gitCalls.map(([file]) => file)).toEqual(["git", "git", "git"]);
    expect(gitCalls[0][1]).toEqual([
      "clone",
      "--depth",
      "1",
      event.githubUrl,
      expect.any(String),
    ]);
    expect(gitCalls[1][1]).toEqual([
      "fetch",
      "--depth",
      "1",
      "origin",
      "--",
      event.gitRef,
    ]);
    expect(gitCalls[2][1]).toEqual(["checkout", "--detach", "FETCH_HEAD"]);
  });

  it.each([
    ["git ref with a space", { gitRef: "main branch" }],
    ["git ref starting with a dash", { gitRef: "--help" }],
    ["git ref containing ..", { gitRef: "main..other" }],
    ["sub-path with a space", { subPath: "contracts main" }],
    ["sub-path containing ..", { subPath: "../outside" }],
  ])("refuses a %s before running git or the backend", async (_, overrides) => {
    const handler = await subscribedHandler();

    await handler.cb(request(overrides));

    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.backend.launch).not.toHaveBeenCalled();
    expect(publishedResults()).toEqual([
      expect.objectContaining({
        status: "compilation_failed",
        failureStage: "INPUT_VALIDATION",
      }),
    ]);
  });

  it("publishes a failed result when the backend cannot start the job", async () => {
    mocks.backend.launch.mockRejectedValue(
      new Error("jobs.batch is forbidden"),
    );
    const handler = await subscribedHandler();
    const event = request();

    await expect(handler.cb(event)).resolves.toBeUndefined();

    expect(publishedResults()).toEqual([
      expect.objectContaining({
        jobId: event.jobId,
        status: "compilation_failed",
        failureStage: "INTERNAL",
        aztecVersion: "v6.1.0",
      }),
    ]);
  });

  it("publishes a failed result for a job the backend reports failed", async () => {
    mocks.backend.getFailureReason.mockResolvedValue("timeout");

    const result = await finishJob(
      { compileLog: "===STAGE:COMPILE===" },
      "failed",
    );

    expect(result).toMatchObject({
      status: "timeout",
      failureStage: "TIMEOUT",
      error: "Compilation job timed out",
    });
  });
});

describe("job output reader", () => {
  it("parses the source files of a finished job", async () => {
    const files = [
      { path: "Nargo.toml", content: '[package]\nname = "token"' },
      {
        path: "src/main.nr",
        content: 'contract Token {\n    // "quoted" \\ backslash\n}',
      },
    ];

    const result = await finishJob({
      compileLog: COMPILE_LOG,
      readerLog: readerOutput(
        files.map((file) => sourceRecord(file.path, file.content)),
      ),
    });

    expect(result).toMatchObject({
      status: "success",
      artifactJson: ARTIFACT_JSON,
      commitHash: COMMIT_HASH,
      aztecVersion: "v6.1.0",
      sourceFiles: files,
    });
  });

  it("fails a job whose artifact section is cut off", async () => {
    const full = readerOutput([
      sourceRecord("Nargo.toml", '[package]\nname = "token"'),
    ]);
    // The artifact stops part-way and its end marker is gone; the sources are intact.
    const cut = full.replace(
      `${ARTIFACT_JSON}\n\n===ARTIFACT_END===`,
      ARTIFACT_JSON.slice(0, 10),
    );
    expect(cut).not.toBe(full);

    const result = await finishJob({ compileLog: COMPILE_LOG, readerLog: cut });

    expect(result).toMatchObject({
      status: "compilation_failed",
      failureStage: "SOURCE_EXTRACTION",
    });
    expect(result).not.toHaveProperty("artifactJson");
  });
});
