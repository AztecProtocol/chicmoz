import type { CompileSourceRequestEvent } from "@chicmoz-pkg/message-registry";
import type { MicroserviceBaseSvc } from "@chicmoz-pkg/microservice-base";
import type { SourceVerificationFailureStage } from "@chicmoz-pkg/types";
import { execFile } from "child_process";
import { mkdtemp, readFile, rm, stat } from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import { logger } from "../../logger.js";
import {
  COMPILER_IMAGE,
  EXECUTION_BACKEND,
  JOB_POLL_INTERVAL_MS,
  MAX_CONCURRENT_JOBS,
} from "../../environment.js";
import { publishMessage } from "../message-bus/index.js";
import type { CompileBackend, JobLogs, JobState } from "./backend.js";
import { createAwsBatchBackend } from "./backends/aws-batch.js";
import { createK8sBackend } from "./backends/k8s.js";
import { jobName } from "./naming.js";
import { buildCompileScript, buildReaderScript } from "./scripts.js";

const backend: CompileBackend =
  EXECUTION_BACKEND === "aws-batch" ? createAwsBatchBackend() : createK8sBackend();

// --- In-memory state ---

const activeJobs = new Map<string, JobState>();

const MAX_COMPILE_OUTPUT_CHARS = 16 * 1024;
const GIT_COMMAND_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);

// --- Helpers ---


type ResolveCompileInputsError = Error & {
  failureStage: SourceVerificationFailureStage;
  aztecVersion?: string;
};

const createResolveCompileInputsError = (
  failureStage: SourceVerificationFailureStage,
  message: string,
  aztecVersion?: string,
): ResolveCompileInputsError => {
  return Object.assign(new Error(message), {
    failureStage,
    aztecVersion,
  });
};


/**
 * Validate that a git ref (branch, tag, commit hash) is safe.
 * Allows alphanumeric, '.', '-', '_', '/' (for branch names like feature/foo).
 */
const isValidGitRef = (ref: string): boolean =>
  /^[\w.\-/]+$/.test(ref) && !ref.includes("..") && !ref.startsWith("-");

/**
 * Validate that a sub-path within a repository is safe.
 * Allows alphanumeric, '.', '-', '_', '/' (no '..' to prevent traversal).
 */
const isValidSubPath = (path: string): boolean =>
  /^[\w.\-/]+$/.test(path) && !path.includes("..");

const trimCompileOutput = (output?: string): string | undefined => {
  const normalizedOutput = output?.trim();
  if (!normalizedOutput) {
    return undefined;
  }

  if (normalizedOutput.length <= MAX_COMPILE_OUTPUT_CHARS) {
    return normalizedOutput;
  }

  return `[truncated to last ${MAX_COMPILE_OUTPUT_CHARS} chars]\n${normalizedOutput.slice(-MAX_COMPILE_OUTPUT_CHARS)}`;
};

const getLastStageMarker = (compileLog?: string): string | undefined => {
  if (!compileLog) {
    return undefined;
  }

  const matches = Array.from(compileLog.matchAll(/===STAGE:([A-Z_]+)===/g));

  return matches.length > 0 ? matches[matches.length - 1]?.[1] : undefined;
};

const detectFailureStage = ({
  reason,
  compileLog,
  readerLog,
  podStatusOutput,
  fallbackStage,
}: {
  reason?: string;
  compileLog?: string;
  readerLog?: string;
  podStatusOutput?: string;
  fallbackStage?: SourceVerificationFailureStage;
}): SourceVerificationFailureStage => {
  const combinedOutput = [compileLog, readerLog, podStatusOutput, reason]
    .filter(Boolean)
    .join("\n");

  if (reason === "timeout") {
    return "TIMEOUT";
  }

  if (
    /ErrImagePull|ImagePullBackOff|InvalidImageName|Back-off pulling image|Failed to pull image|pull access denied|manifest unknown|no such image|failed to resolve reference/i.test(
      combinedOutput,
    )
  ) {
    return "IMAGE_RESOLUTION";
  }

  if (/Invalid git ref|Invalid sub-path/i.test(combinedOutput)) {
    return "INPUT_VALIDATION";
  }

  if (
    /Selected artifact is not transpiled|Compiled artifact is still not transpiled|Transpiler doesn't know how to process|thread '\s*<unnamed>' panicked at .*transpile/i.test(
      combinedOutput,
    )
  ) {
    return "TRANSPILATION";
  }

  if (
    /No compiled artifact found after compile|No compiled artifact found after workspace compile|NO_ARTIFACT_FOUND|Could not parse artifact from job pod logs/i.test(
      combinedOutput,
    )
  ) {
    return "ARTIFACT_DISCOVERY";
  }

  if (
    /pathspec|reference is not a tree|did not match any file\(s\) known to git|can't cd to/i.test(
      combinedOutput,
    )
  ) {
    return "CHECKOUT";
  }

  if (
    /fatal: repository|repository .* not found|Could not resolve host|unable to access|Authentication failed/i.test(
      combinedOutput,
    )
  ) {
    return "CLONE";
  }

  const stageMarker = getLastStageMarker(compileLog);
  if (stageMarker === "CLONE") {
    return "CLONE";
  }
  if (stageMarker === "CHECKOUT") {
    return "CHECKOUT";
  }
  if (stageMarker === "ARTIFACT_DISCOVERY") {
    return "ARTIFACT_DISCOVERY";
  }
  if (stageMarker === "SOURCE_EXTRACTION") {
    return "SOURCE_EXTRACTION";
  }
  if (stageMarker === "COMPILE") {
    return "COMPILE";
  }

  if (
    /Compiling contract|Running compile command|bb exited with code|nargo|compile/i.test(
      combinedOutput,
    )
  ) {
    return "COMPILE";
  }

  return fallbackStage ?? "INTERNAL";
};

const summarizeFailure = (
  failureStage: SourceVerificationFailureStage,
): string => {
  switch (failureStage) {
    case "INPUT_VALIDATION":
      return "Compilation request validation failed";
    case "NARGO_DISCOVERY":
      return "Nargo.toml discovery failed";
    case "IMAGE_RESOLUTION":
      return "Compiler image resolution failed";
    case "CLONE":
      return "Repository clone failed";
    case "CHECKOUT":
      return "Repository checkout failed";
    case "COMPILE":
      return "Compilation failed";
    case "TRANSPILATION":
      return "Compilation failed during transpilation";
    case "ARTIFACT_DISCOVERY":
      return "Compiled artifact could not be found";
    case "ARTIFACT_VERIFICATION":
      return "Artifact verification failed";
    case "SOURCE_EXTRACTION":
      return "Compiled source extraction failed";
    case "TIMEOUT":
      return "Compilation job timed out";
    case "INTERNAL":
      return "Internal compilation error";
  }

  return "Internal compilation error";
};

const buildCompilerImage = (aztecVersion: string): string => {
  const normalizedAztecVersion = aztecVersion.replace(/^v/, "");
  const lastColonIndex = COMPILER_IMAGE.lastIndexOf(":");
  const slashIndex = COMPILER_IMAGE.lastIndexOf("/");

  if (lastColonIndex > slashIndex) {
    return `${COMPILER_IMAGE.slice(0, lastColonIndex)}:${normalizedAztecVersion}`;
  }

  return `${COMPILER_IMAGE}:${normalizedAztecVersion}`;
};

const extractAztecVersionFromNargoToml = (
  contents: string,
): string | undefined => {
  const dependenciesSection = contents.match(
    /^\[dependencies\]\s*([\s\S]*?)(?=^\[|$)/m,
  )?.[1];

  const inlineTag = dependenciesSection
    ?.match(
      /^\s*aztec\s*=\s*\{[\s\S]*?\btag\s*=\s*"([^"]+)"[\s\S]*?\}\s*$/m,
    )?.[1]
    ?.trim();
  if (inlineTag) {
    return inlineTag;
  }

  const aztecSection = contents.match(
    /^\[dependencies\.aztec\]\s*([\s\S]*?)(?=^\[|$)/m,
  )?.[1];

  return aztecSection?.match(/^\s*tag\s*=\s*"([^"]+)"/m)?.[1]?.trim();
};

const runGit = async (
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> => {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: GIT_COMMAND_TIMEOUT_MS,
    });

    return {
      stdout: stdout.toString(),
      stderr: stderr.toString(),
    };
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: NodeJS.Signals;
    };

    if (
      execError.killed === true ||
      execError.signal === "SIGTERM" ||
      execError.message.includes("timed out")
    ) {
      throw createResolveCompileInputsError(
        "TIMEOUT",
        `Git command timed out after ${GIT_COMMAND_TIMEOUT_MS}ms: git ${args.join(" ")}`,
      );
    }

    throw error;
  }
};

const resolveCompileInputs = async (
  event: CompileSourceRequestEvent,
): Promise<{ aztecVersion: string; compilerImage: string }> => {
  if (event.gitRef && !isValidGitRef(event.gitRef)) {
    throw createResolveCompileInputsError(
      "INPUT_VALIDATION",
      `Invalid git ref: ${event.gitRef}`,
    );
  }

  if (event.subPath && !isValidSubPath(event.subPath)) {
    throw createResolveCompileInputsError(
      "INPUT_VALIDATION",
      `Invalid sub-path: ${event.subPath}`,
    );
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "source-verify-"));

  try {
    try {
      await runGit(["clone", "--depth", "1", event.githubUrl, tempDir]);
    } catch (error) {
      throw createResolveCompileInputsError(
        "CLONE",
        `Failed to clone repository: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (event.gitRef) {
      try {
        await runGit(
          ["fetch", "--depth", "1", "origin", "--", event.gitRef],
          tempDir,
        );
        await runGit(["checkout", "--detach", "FETCH_HEAD"], tempDir);
      } catch (error) {
        throw createResolveCompileInputsError(
          "CHECKOUT",
          `Failed to checkout git ref ${event.gitRef}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const repoPath = (() => {
      if (!event.subPath) {
        return tempDir;
      }

      if (
        event.subPath.startsWith("/") ||
        event.subPath.startsWith("\\") ||
        path.isAbsolute(event.subPath)
      ) {
        throw createResolveCompileInputsError(
          "CHECKOUT",
          `Could not enter sub-path: ${event.subPath}`,
        );
      }

      const resolvedRepoPath = path.resolve(tempDir, event.subPath);
      const relativeRepoPath = path.relative(tempDir, resolvedRepoPath);

      if (
        relativeRepoPath === ".." ||
        relativeRepoPath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeRepoPath)
      ) {
        throw createResolveCompileInputsError(
          "CHECKOUT",
          `Could not enter sub-path: ${event.subPath}`,
        );
      }

      return resolvedRepoPath;
    })();

    try {
      await stat(repoPath);
    } catch {
      throw createResolveCompileInputsError(
        "CHECKOUT",
        `Could not enter sub-path: ${event.subPath}`,
      );
    }

    const nargoPath = path.join(repoPath, "Nargo.toml");

    let nargoToml: string;
    try {
      nargoToml = await readFile(nargoPath, "utf8");
    } catch {
      throw createResolveCompileInputsError(
        "NARGO_DISCOVERY",
        `Could not find readable Nargo.toml at ${event.subPath ? `${event.subPath}/Nargo.toml` : "Nargo.toml"}`,
      );
    }

    const aztecVersion = extractAztecVersionFromNargoToml(nargoToml);
    if (!aztecVersion) {
      throw createResolveCompileInputsError(
        "NARGO_DISCOVERY",
        `Could not determine dependencies.aztec.tag from ${event.subPath ? `${event.subPath}/Nargo.toml` : "Nargo.toml"}`,
      );
    }

    const compilerImage = buildCompilerImage(aztecVersion);

    return { aztecVersion, compilerImage };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
};


const buildCompileOutput = ({
  compileLog,
  readerLog,
  podStatusOutput,
}: JobLogs & { podStatusOutput?: string }): string | undefined => {
  const sections = [
    compileLog ? `=== compiler log ===\n${compileLog.trim()}` : undefined,
    readerLog ? `=== reader log ===\n${readerLog.trim()}` : undefined,
    podStatusOutput
      ? `=== pod status ===\n${podStatusOutput.trim()}`
      : undefined,
  ].filter(Boolean);

  return trimCompileOutput(sections.join("\n\n"));
};

const parseJobResults = (
  readerLog: string,
): {
  artifactJson: string;
  sourceFiles: Array<{ path: string; content: string }>;
  commitHash?: string;
} => {
  const logStr = readerLog;

  // Parse commit hash
  const commitHashMatch = logStr.match(
    /===COMMIT_HASH_START===\n([\s\S]*?)\n===COMMIT_HASH_END===/,
  );
  const commitHash = commitHashMatch ? commitHashMatch[1].trim() : undefined;

  // Parse artifact
  const artifactMatch = logStr.match(
    /===ARTIFACT_START===\n([\s\S]*?)\n===ARTIFACT_END===/,
  );
  if (!artifactMatch) {
    throw new Error("Could not parse artifact from compile job logs");
  }
  const artifactJson = artifactMatch[1].trim();

  // Parse source files
  const sourcesMatch = logStr.match(
    /===SOURCES_START===\n([\s\S]*?)\n===SOURCES_END===/,
  );
  const sourceFiles: Array<{ path: string; content: string }> = [];
  if (sourcesMatch) {
    const lines = sourcesMatch[1].trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { path: string; content: string };
        sourceFiles.push(parsed);
      } catch {
        logger.warn(`Failed to parse source file line: ${line}`);
      }
    }
  }

  return { artifactJson, sourceFiles, commitHash };
};

// --- Job completion handling ---

const handleJobCompletion = async (state: JobState): Promise<void> => {
  // Remove from active jobs immediately to prevent duplicate handling on next poll
  activeJobs.delete(state.jobId);
  logger.info(`Job completed successfully: ${state.backendJobName}`);

  let logs: JobLogs = {};
  try {
    logs = await backend.readLogs(state);
    const { artifactJson, sourceFiles, commitHash } = parseJobResults(
      logs.readerLog ?? "",
    );

    await publishMessage("COMPILE_SOURCE_RESULT_EVENT", {
      jobId: state.jobId,
      contractClassId: state.contractClassId,
      version: state.version,
      status: "success",
      aztecVersion: state.aztecVersion,
      artifactJson,
      sourceFiles,
      commitHash,
    });

    logger.info(`Published success result for jobId=${state.jobId}`);
  } catch (e) {
    logger.error(
      `Failed to read artifact for jobId=${state.jobId}: ${(e as Error).message}`,
    );

    const failureStage = detectFailureStage({
      compileLog: logs.compileLog,
      readerLog: logs.readerLog,
      fallbackStage: "SOURCE_EXTRACTION",
    });

    try {
      await publishMessage("COMPILE_SOURCE_RESULT_EVENT", {
        jobId: state.jobId,
        contractClassId: state.contractClassId,
        version: state.version,
        status: "compilation_failed",
        aztecVersion: state.aztecVersion,
        error: summarizeFailure(failureStage),
        failureStage,
        compileOutput: buildCompileOutput(logs),
      });
    } catch (publishError) {
      logger.error(
        `Failed to publish failure result for jobId=${state.jobId}: ${(publishError as Error).message}`,
      );
    }
  }
};

const handleJobFailure = async (state: JobState): Promise<void> => {
  // Remove from active jobs immediately to prevent duplicate handling on next poll
  activeJobs.delete(state.jobId);
  const reason = await backend.getFailureReason(state);
  const logs = await backend.readLogs(state);
  const failureStage = detectFailureStage({
    reason,
    compileLog: logs.compileLog,
    readerLog: logs.readerLog,
    podStatusOutput: logs.diagnostics,
  });
  const status =
    failureStage === "TIMEOUT"
      ? ("timeout" as const)
      : failureStage === "CLONE"
        ? ("clone_failed" as const)
        : ("compilation_failed" as const);

  logger.warn(`Job failed: ${state.backendJobName}, reason: ${reason}`);

  try {
    await publishMessage("COMPILE_SOURCE_RESULT_EVENT", {
      jobId: state.jobId,
      contractClassId: state.contractClassId,
      version: state.version,
      status,
      aztecVersion: state.aztecVersion,
      error: summarizeFailure(failureStage),
      failureStage,
      compileOutput: buildCompileOutput({
        ...logs,
        podStatusOutput: logs.diagnostics,
      }),
    });
  } catch (e) {
    logger.error(
      `Failed to publish failure result for jobId=${state.jobId}: ${(e as Error).message}`,
    );
  }
};

// --- Poll loop ---

let pollIntervalHandle: ReturnType<typeof setInterval> | null = null;

const pollActiveJobs = async (): Promise<void> => {
  const jobs = Array.from(activeJobs.values());

  for (const state of jobs) {
    const status = await backend.checkStatus(state);

    if (status === "succeeded") {
      await handleJobCompletion(state);
    } else if (status === "failed") {
      await handleJobFailure(state);
    }
    // "running" -> do nothing, check again next poll
  }
};
export const startJobPoller = (): void => {
  if (pollIntervalHandle) {
    return;
  }
  pollIntervalHandle = setInterval(() => {
    pollActiveJobs().catch((e) => {
      logger.error(`Job poll error: ${(e as Error).message}`);
    });
  }, JOB_POLL_INTERVAL_MS);
  logger.info(`Job poller started (interval: ${JOB_POLL_INTERVAL_MS}ms)`);
};

const stopJobPoller = (): void => {
  if (pollIntervalHandle) {
    clearInterval(pollIntervalHandle);
    pollIntervalHandle = null;
  }
};

// --- Public API ---
export const handleCompileRequest = async (
  event: CompileSourceRequestEvent,
): Promise<void> => {
  if (activeJobs.size >= MAX_CONCURRENT_JOBS) {
    logger.warn(
      `Max concurrent jobs (${MAX_CONCURRENT_JOBS}) reached, rejecting jobId=${event.jobId}`,
    );
    try {
      await publishMessage("COMPILE_SOURCE_RESULT_EVENT", {
        jobId: event.jobId,
        contractClassId: event.contractClassId,
        version: event.version,
        status: "compilation_failed",
        error: summarizeFailure("INTERNAL"),
        failureStage: "INTERNAL",
        compileOutput:
          "Server at maximum compilation capacity. Please try again later.",
      });
    } catch (e) {
      logger.error(
        `Failed to publish rejection for jobId=${event.jobId}: ${(e as Error).message}`,
      );
    }
    return;
  }

  if (event.gitRef && !isValidGitRef(event.gitRef)) {
    logger.warn(`Invalid gitRef for jobId=${event.jobId}: ${event.gitRef}`);
    try {
      await publishMessage("COMPILE_SOURCE_RESULT_EVENT", {
        jobId: event.jobId,
        contractClassId: event.contractClassId,
        version: event.version,
        status: "compilation_failed",
        error: summarizeFailure("INPUT_VALIDATION"),
        failureStage: "INPUT_VALIDATION",
        compileOutput:
          "Invalid git ref. Only alphanumeric characters, '.', '-', '_', and '/' are allowed.",
      });
    } catch (e) {
      logger.error(
        `Failed to publish rejection for jobId=${event.jobId}: ${(e as Error).message}`,
      );
    }
    return;
  }

  if (event.subPath && !isValidSubPath(event.subPath)) {
    logger.warn(`Invalid subPath for jobId=${event.jobId}: ${event.subPath}`);
    try {
      await publishMessage("COMPILE_SOURCE_RESULT_EVENT", {
        jobId: event.jobId,
        contractClassId: event.contractClassId,
        version: event.version,
        status: "compilation_failed",
        error: summarizeFailure("INPUT_VALIDATION"),
        failureStage: "INPUT_VALIDATION",
        compileOutput:
          "Invalid sub-path. Only alphanumeric characters, '.', '-', '_', and '/' are allowed (no '..').",
      });
    } catch (e) {
      logger.error(
        `Failed to publish rejection for jobId=${event.jobId}: ${(e as Error).message}`,
      );
    }
    return;
  }

  const jName = jobName(event.jobId);

  let resolvedInputs: { aztecVersion: string; compilerImage: string };

  try {
    resolvedInputs = await resolveCompileInputs(event);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failureStage =
      (error as Partial<ResolveCompileInputsError>).failureStage ?? "INTERNAL";
    const aztecVersion = (error as Partial<ResolveCompileInputsError>)
      .aztecVersion;

    logger.warn(
      `Failed to resolve compile inputs for jobId=${event.jobId}: ${message}`,
    );

    try {
      await publishMessage("COMPILE_SOURCE_RESULT_EVENT", {
        jobId: event.jobId,
        contractClassId: event.contractClassId,
        version: event.version,
        status:
          failureStage === "CLONE" ? "clone_failed" : "compilation_failed",
        aztecVersion,
        error: summarizeFailure(failureStage),
        failureStage,
        compileOutput: trimCompileOutput(message),
      });
    } catch (publishError) {
      logger.error(
        `Failed to publish resolution failure for jobId=${event.jobId}: ${(publishError as Error).message}`,
      );
    }
    return;
  }

  logger.info(
    `Resolved compile inputs for jobId=${event.jobId}: aztecVersion=${resolvedInputs.aztecVersion} compilerImage=${resolvedInputs.compilerImage}`,
  );

  const state: JobState = {
    jobId: event.jobId,
    backendJobName: jName,
    contractClassId: event.contractClassId,
    version: event.version,
    githubUrl: event.githubUrl,
    gitRef: event.gitRef,
    subPath: event.subPath,
    aztecVersion: resolvedInputs.aztecVersion,
    compilerImage: resolvedInputs.compilerImage,
    createdAt: new Date(),
  };

  try {
    await backend.launch(state, {
      compileScript: buildCompileScript(
        state.githubUrl,
        state.gitRef,
        state.subPath,
      ),
      readerScript: buildReaderScript(),
    });
    activeJobs.set(event.jobId, state);
    logger.info(`Started compile job: jobId=${event.jobId} k8sJob=${jName}`);
  } catch (e) {
    logger.error(
      `Failed to create compile job for jobId=${event.jobId}: ${(e as Error).message}`,
    );

    try {
      await publishMessage("COMPILE_SOURCE_RESULT_EVENT", {
        jobId: event.jobId,
        contractClassId: event.contractClassId,
        version: event.version,
        status: "compilation_failed",
        aztecVersion: state.aztecVersion,
        error: summarizeFailure("INTERNAL"),
        failureStage: "INTERNAL",
        compileOutput: trimCompileOutput(
          `Failed to create compile job: ${(e as Error).message}`,
        ),
      });
    } catch (publishError) {
      logger.error(
        `Failed to publish failure result for jobId=${event.jobId}: ${(publishError as Error).message}`,
      );
    }
  }
};

// --- Recovery ---

export const recoverActiveJobs = async (): Promise<void> => {
  const recovered = await backend.recoverActiveJobs();
  for (const state of recovered) {
    activeJobs.set(state.jobId, state);
  }
};

// --- Service lifecycle ---

export const jobManagerService: MicroserviceBaseSvc = {
  svcId: "JOB_MANAGER",
  getConfigStr: () => `EXECUTION_BACKEND=${EXECUTION_BACKEND} ${backend.getConfigStr()}`,
  init: () => backend.init(),
  health: () => true,
  shutdown: (): Promise<void> => {
    stopJobPoller();
    logger.info("Job manager shut down");
    return Promise.resolve();
  },
};
