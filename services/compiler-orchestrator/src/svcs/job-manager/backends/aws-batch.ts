import {
  BatchClient,
  DescribeJobDefinitionsCommand,
  DescribeJobsCommand,
  ListJobsCommand,
  RegisterJobDefinitionCommand,
  SubmitJobCommand,
  type JobStatus,
} from "@aws-sdk/client-batch";
import {
  CloudWatchLogsClient,
  GetLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { logger } from "../../../logger.js";
import {
  AWS_BATCH_EXECUTION_ROLE_ARN,
  AWS_BATCH_JOB_DEF_PREFIX,
  AWS_BATCH_JOB_QUEUE,
  AWS_BATCH_LOG_GROUP,
  JOB_CPU_LIMIT,
  JOB_MEMORY_LIMIT,
  JOB_TIMEOUT_SECONDS,
  L2_NETWORK_ID,
  MAX_CONCURRENT_JOBS,
} from "../../../environment.js";
import type { CompileBackend, JobLogs, JobScripts, JobState } from "../backend.js";

// Same identifying metadata as the k8s backend's labels/annotations, carried
// as Batch job tags so restart recovery can rebuild JobState.
const TAG_JOB_ID = "chicmoz-job-id";
const TAG_NETWORK_ID = "chicmoz-l2-network";
const TAG_CONTRACT_CLASS_ID = "chicmoz-contract-class-id";
const TAG_VERSION = "chicmoz-version";
const TAG_GITHUB_URL = "chicmoz-github-url";
const TAG_AZTEC_VERSION = "chicmoz-aztec-version";
const TAG_COMPILER_IMAGE = "chicmoz-compiler-image";
const NETWORK_TAG_VALUE = L2_NETWORK_ID.toLowerCase();

const ACTIVE_JOB_STATUSES: JobStatus[] = [
  "SUBMITTED",
  "PENDING",
  "RUNNABLE",
  "STARTING",
  "RUNNING",
];

type BatchJobHandle = {
  batchJobId: string;
  logStreamName?: string;
  statusReason?: string;
  containerReason?: string;
  exitCode?: number;
};

let batchClient: BatchClient;
let logsClient: CloudWatchLogsClient;

const jobHandles = new Map<string, BatchJobHandle>();
const jobDefinitionCache = new Map<string, string>();

// Fargate accepts a fixed vCPU menu; round the configured limit up to the
// nearest valid size so k8s-style values ("500m", "2") keep working.
const FARGATE_VCPU_STEPS = [0.25, 0.5, 1, 2, 4, 8, 16];

const toFargateVcpu = (cpuLimit: string): number => {
  const requested = cpuLimit.endsWith("m")
    ? Number(cpuLimit.slice(0, -1)) / 1000
    : Number(cpuLimit);
  const vcpu = FARGATE_VCPU_STEPS.find((step) => step >= requested);
  return vcpu ?? FARGATE_VCPU_STEPS[FARGATE_VCPU_STEPS.length - 1];
};

const toFargateMemoryMib = (memoryLimit: string, vcpu: number): number => {
  let mib: number;
  if (memoryLimit.endsWith("Gi")) {
    mib = Number(memoryLimit.slice(0, -2)) * 1024;
  } else if (memoryLimit.endsWith("Mi")) {
    mib = Number(memoryLimit.slice(0, -2));
  } else {
    mib = Number(memoryLimit) / (1024 * 1024);
  }
  // Fargate constrains memory per vCPU tier; clamp into the valid band.
  const minByVcpu: Record<number, number> = {
    0.25: 512,
    0.5: 1024,
    1: 2048,
    2: 4096,
    4: 8192,
    8: 16384,
    16: 32768,
  };
  const maxByVcpu: Record<number, number> = {
    0.25: 2048,
    0.5: 4096,
    1: 8192,
    2: 16384,
    4: 30720,
    8: 61440,
    16: 122880,
  };
  const min = minByVcpu[vcpu] ?? 4096;
  const max = maxByVcpu[vcpu] ?? 16384;
  const clamped = Math.min(Math.max(mib, min), max);
  // Whole GiB increments keep every tier happy.
  return Math.ceil(clamped / 1024) * 1024 > max
    ? max
    : Math.ceil(clamped / 1024) * 1024;
};

const sanitizeDefinitionName = (image: string): string => {
  const tag = image.includes(":") ? image.slice(image.lastIndexOf(":") + 1) : "latest";
  return `${AWS_BATCH_JOB_DEF_PREFIX}-${NETWORK_TAG_VALUE}-${tag}`
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .substring(0, 128);
};

const ensureJobDefinition = async (compilerImage: string): Promise<string> => {
  const cached = jobDefinitionCache.get(compilerImage);
  if (cached) {
    return cached;
  }

  const definitionName = sanitizeDefinitionName(compilerImage);

  const existing = await batchClient.send(
    new DescribeJobDefinitionsCommand({
      jobDefinitionName: definitionName,
      status: "ACTIVE",
    }),
  );
  const match = (existing.jobDefinitions ?? [])
    .sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0))
    .find((def) => def.containerProperties?.image === compilerImage);
  if (match?.jobDefinitionArn) {
    jobDefinitionCache.set(compilerImage, match.jobDefinitionArn);
    return match.jobDefinitionArn;
  }

  const vcpu = toFargateVcpu(JOB_CPU_LIMIT);
  const memoryMib = toFargateMemoryMib(JOB_MEMORY_LIMIT, vcpu);

  logger.info(
    `Registering Batch job definition ${definitionName} (image=${compilerImage} vcpu=${vcpu} memoryMib=${memoryMib})`,
  );
  const registered = await batchClient.send(
    new RegisterJobDefinitionCommand({
      jobDefinitionName: definitionName,
      type: "container",
      platformCapabilities: ["FARGATE"],
      retryStrategy: { attempts: 1 },
      containerProperties: {
        image: compilerImage,
        executionRoleArn: AWS_BATCH_EXECUTION_ROLE_ARN,
        // Placeholder; the real compile command arrives via containerOverrides.
        command: ["/bin/sh", "-c", "echo chicmoz-compiler-placeholder"],
        resourceRequirements: [
          { type: "VCPU", value: String(vcpu) },
          { type: "MEMORY", value: String(memoryMib) },
        ],
        networkConfiguration: { assignPublicIp: "ENABLED" },
        fargatePlatformConfiguration: { platformVersion: "LATEST" },
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": AWS_BATCH_LOG_GROUP,
            "awslogs-stream-prefix": "compile",
          },
        },
      },
    }),
  );

  if (!registered.jobDefinitionArn) {
    throw new Error(`Failed to register job definition ${definitionName}`);
  }
  jobDefinitionCache.set(compilerImage, registered.jobDefinitionArn);
  return registered.jobDefinitionArn;
};

const buildCombinedScript = (scripts: JobScripts): string =>
  [
    "set -e",
    // The k8s backend provides /output as a volume; on Fargate the compile
    // and reader phases share one container filesystem instead.
    "mkdir -p /output /workspace",
    scripts.compileScript,
    scripts.readerScript,
  ].join("\n");

const launch = async (state: JobState, scripts: JobScripts): Promise<void> => {
  const jobDefinitionArn = await ensureJobDefinition(state.compilerImage);

  const response = await batchClient.send(
    new SubmitJobCommand({
      jobName: state.backendJobName,
      jobQueue: AWS_BATCH_JOB_QUEUE,
      jobDefinition: jobDefinitionArn,
      timeout: { attemptDurationSeconds: JOB_TIMEOUT_SECONDS },
      propagateTags: true,
      tags: {
        [TAG_JOB_ID]: state.jobId,
        [TAG_NETWORK_ID]: NETWORK_TAG_VALUE,
        [TAG_CONTRACT_CLASS_ID]: state.contractClassId,
        [TAG_VERSION]: String(state.version),
        [TAG_GITHUB_URL]: state.githubUrl,
        [TAG_AZTEC_VERSION]: state.aztecVersion,
        [TAG_COMPILER_IMAGE]: state.compilerImage,
      },
      containerOverrides: {
        command: ["/bin/sh", "-c", buildCombinedScript(scripts)],
        environment: [
          { name: "NARGO_HOME", value: "/root/nargo" },
          { name: "GIT_URL", value: state.githubUrl },
          { name: "AZTEC_VERSION", value: state.aztecVersion },
          ...(state.gitRef ? [{ name: "GIT_REF", value: state.gitRef }] : []),
          ...(state.subPath ? [{ name: "SUB_PATH", value: state.subPath }] : []),
        ],
      },
    }),
  );

  if (!response.jobId) {
    throw new Error("Batch SubmitJob returned no jobId");
  }
  jobHandles.set(state.jobId, { batchJobId: response.jobId });
  logger.info(
    `Submitted Batch job: ${state.backendJobName} (batchJobId=${response.jobId})`,
  );
};

const describeJob = async (
  state: JobState,
): Promise<
  { handle: BatchJobHandle; status?: JobStatus } | undefined
> => {
  const handle = jobHandles.get(state.jobId);
  if (!handle) {
    return undefined;
  }

  const described = await batchClient.send(
    new DescribeJobsCommand({ jobs: [handle.batchJobId] }),
  );
  const job = described.jobs?.[0];
  if (!job) {
    return { handle };
  }

  const lastAttempt = job.attempts?.[job.attempts.length - 1];
  handle.logStreamName =
    job.container?.logStreamName ??
    lastAttempt?.container?.logStreamName ??
    handle.logStreamName;
  handle.statusReason = job.statusReason ?? handle.statusReason;
  handle.containerReason =
    job.container?.reason ??
    lastAttempt?.container?.reason ??
    handle.containerReason;
  handle.exitCode =
    job.container?.exitCode ?? lastAttempt?.container?.exitCode ?? handle.exitCode;

  return { handle, status: job.status };
};

const checkStatus = async (
  state: JobState,
): Promise<"running" | "succeeded" | "failed"> => {
  try {
    const described = await describeJob(state);
    if (!described) {
      logger.error(
        `No Batch job handle for jobId=${state.jobId}; marking failed`,
      );
      return "failed";
    }

    if (described.status === "SUCCEEDED") {
      return "succeeded";
    }
    if (described.status === "FAILED") {
      return "failed";
    }
    return "running";
  } catch (e) {
    logger.error(
      `Error checking Batch job status for ${state.backendJobName}: ${(e as Error).message}`,
    );
    return "failed";
  }
};

const readLogStream = async (logStreamName: string): Promise<string> => {
  const messages: string[] = [];
  let nextToken: string | undefined;

  for (;;) {
    const response = await logsClient.send(
      new GetLogEventsCommand({
        logGroupName: AWS_BATCH_LOG_GROUP,
        logStreamName,
        startFromHead: true,
        nextToken,
      }),
    );

    for (const event of response.events ?? []) {
      if (event.message !== undefined) {
        messages.push(event.message);
      }
    }

    if (!response.nextForwardToken || response.nextForwardToken === nextToken) {
      break;
    }
    nextToken = response.nextForwardToken;
  }

  return messages.join("\n");
};

const readLogs = async (state: JobState): Promise<JobLogs> => {
  try {
    const described = await describeJob(state);
    const handle = described?.handle;
    if (!handle?.logStreamName) {
      return { diagnostics: handle?.statusReason };
    }

    const fullLog = await readLogStream(handle.logStreamName);

    // The compile and reader phases share one log stream; the first reader
    // marker separates them so downstream parsing matches the k8s backend.
    const markerIndex = fullLog.indexOf("===COMMIT_HASH_START===");
    const compileLog = markerIndex >= 0 ? fullLog.slice(0, markerIndex) : fullLog;
    const readerLog = markerIndex >= 0 ? fullLog.slice(markerIndex) : undefined;

    const diagnostics = [
      handle.statusReason,
      handle.containerReason,
      handle.exitCode !== undefined ? `exitCode=${handle.exitCode}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      compileLog: compileLog.trim() || undefined,
      readerLog,
      diagnostics: diagnostics || undefined,
    };
  } catch (error) {
    logger.warn(
      `Failed to read Batch job logs for jobId=${state.jobId}: ${(error as Error).message}`,
    );
    return {};
  }
};

const getFailureReason = async (state: JobState): Promise<string> => {
  try {
    const described = await describeJob(state);
    const handle = described?.handle;
    if (!handle) {
      return "unable to read job status";
    }

    const reason = [handle.statusReason, handle.containerReason]
      .filter(Boolean)
      .join(": ");

    if (/timed? ?out|deadline|duration exceeded/i.test(reason)) {
      return "timeout";
    }
    return reason || "unknown failure";
  } catch {
    return "unable to read job status";
  }
};

const recoverActiveJobsFromBatch = async (): Promise<JobState[]> => {
  logger.info("Recovering active compile jobs from AWS Batch...");
  const recoveredJobs: JobState[] = [];

  try {
    const activeIds: string[] = [];
    for (const jobStatus of ACTIVE_JOB_STATUSES) {
      let nextToken: string | undefined;
      do {
        const listed = await batchClient.send(
          new ListJobsCommand({
            jobQueue: AWS_BATCH_JOB_QUEUE,
            jobStatus,
            nextToken,
          }),
        );
        for (const summary of listed.jobSummaryList ?? []) {
          if (summary.jobId && summary.jobName?.startsWith("compile-")) {
            activeIds.push(summary.jobId);
          }
        }
        nextToken = listed.nextToken;
      } while (nextToken);
    }

    for (let i = 0; i < activeIds.length; i += 100) {
      const described = await batchClient.send(
        new DescribeJobsCommand({ jobs: activeIds.slice(i, i + 100) }),
      );
      for (const job of described.jobs ?? []) {
        const tags = job.tags ?? {};
        const jobId = tags[TAG_JOB_ID];
        if (!jobId || tags[TAG_NETWORK_ID] !== NETWORK_TAG_VALUE || !job.jobId) {
          continue;
        }

        const state: JobState = {
          jobId,
          backendJobName: job.jobName ?? `compile-${jobId}`,
          contractClassId: tags[TAG_CONTRACT_CLASS_ID] ?? "unknown-recovery",
          version: Number(tags[TAG_VERSION]) || 0,
          githubUrl: tags[TAG_GITHUB_URL] ?? "unknown-recovery",
          aztecVersion: tags[TAG_AZTEC_VERSION] ?? "unknown-recovery",
          compilerImage: tags[TAG_COMPILER_IMAGE] ?? "unknown-recovery",
          createdAt: job.createdAt ? new Date(job.createdAt) : new Date(),
        };
        jobHandles.set(jobId, { batchJobId: job.jobId });
        recoveredJobs.push(state);
        logger.info(
          `Recovered active Batch job: ${state.backendJobName} (jobId=${jobId})`,
        );
      }
    }

    logger.info(`Recovery complete. ${recoveredJobs.length} active jobs found.`);
  } catch (e) {
    logger.error(`Failed to recover active Batch jobs: ${(e as Error).message}`);
  }

  return recoveredJobs;
};

export const createAwsBatchBackend = (): CompileBackend => ({
  name: "aws-batch",
  init: () => {
    if (!AWS_BATCH_JOB_QUEUE) {
      return Promise.reject(
        new Error("AWS_BATCH_JOB_QUEUE is required for the aws-batch backend"),
      );
    }
    if (!AWS_BATCH_EXECUTION_ROLE_ARN) {
      return Promise.reject(
        new Error(
          "AWS_BATCH_EXECUTION_ROLE_ARN is required for the aws-batch backend",
        ),
      );
    }
    batchClient = new BatchClient({});
    logsClient = new CloudWatchLogsClient({});
    logger.info("AWS Batch client initialized");
    return Promise.resolve();
  },
  launch,
  checkStatus,
  readLogs,
  getFailureReason,
  recoverActiveJobs: recoverActiveJobsFromBatch,
  getConfigStr: () =>
    `AWS_BATCH_JOB_QUEUE=${AWS_BATCH_JOB_QUEUE} MAX_CONCURRENT=${MAX_CONCURRENT_JOBS} LOG_GROUP=${AWS_BATCH_LOG_GROUP}`,
});
