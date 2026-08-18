export type JobState = {
  jobId: string;
  backendJobName: string;
  contractClassId: string;
  version: number;
  githubUrl: string;
  gitRef?: string;
  subPath?: string;
  aztecVersion: string;
  compilerImage: string;
  createdAt: Date;
};

export type JobScripts = {
  compileScript: string;
  readerScript: string;
};

export type JobLogs = {
  compileLog?: string;
  readerLog?: string;
  diagnostics?: string;
};

/**
 * Where compile jobs execute. The job manager owns input resolution, output
 * parsing, and result publishing; a backend only launches sandboxed compile
 * jobs and reports their status and raw logs back.
 */
export interface CompileBackend {
  readonly name: string;
  init(): Promise<void>;
  /** Start the compile job. Must not throw for expected compile failures. */
  launch(state: JobState, scripts: JobScripts): Promise<void>;
  checkStatus(state: JobState): Promise<"running" | "succeeded" | "failed">;
  /**
   * Raw logs after the job reached a terminal state. On success, readerLog
   * contains the ===ARTIFACT_START===/... delimited result markers.
   */
  readLogs(state: JobState): Promise<JobLogs>;
  /** Human-readable failure reason; the literal "timeout" on deadline kills. */
  getFailureReason(state: JobState): Promise<string>;
  /** Rediscover jobs still running after an orchestrator restart. */
  recoverActiveJobs(): Promise<JobState[]>;
  getConfigStr(): string;
}
