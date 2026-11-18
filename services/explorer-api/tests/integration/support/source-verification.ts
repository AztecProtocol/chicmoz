import { deliver } from "@chicmoz/test-harness";
import { type CompileSourceResultEvent } from "@chicmoz-pkg/message-registry";
import { eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { type SeededClass } from "./contracts.js";

type JobStatus = "PENDING" | "COMPILING" | "VERIFYING" | "VERIFIED" | "FAILED";

export type SeededJob = SeededClass & {
  jobId: string;
  githubUrl: string;
  gitRef: string;
};

/** A job as the submit route leaves it once the compile request is published. */
export const seedJob = async (
  seeded: SeededClass,
  {
    status = "COMPILING",
    error,
    clientIp,
  }: { status?: JobStatus; error?: string; clientIp?: string | null } = {},
): Promise<SeededJob> => {
  const { getDb } = await import("@chicmoz-pkg/postgres-helper");
  const { sourceVerificationJobs } = await import(
    "../../../src/svcs/database/schema/l2contract/index.js"
  );
  const job = {
    ...seeded,
    jobId: randomUUID(),
    githubUrl: `https://github.com/example/${randomBytes(4).toString("hex")}`,
    gitRef: `v${randomBytes(2).toString("hex")}`,
  };
  await getDb()
    .insert(sourceVerificationJobs)
    .values({
      id: job.jobId,
      contractClassId: job.contractClassId,
      version: job.version,
      githubUrl: job.githubUrl,
      gitRef: job.gitRef,
      status,
      error: error ?? null,
      clientIp: clientIp ?? null,
    });
  return job;
};

export const readJob = async (jobId: string) => {
  const { getDb } = await import("@chicmoz-pkg/postgres-helper");
  const { sourceVerificationJobs: t } = await import(
    "../../../src/svcs/database/schema/l2contract/index.js"
  );
  const [row] = await getDb().select().from(t).where(eq(t.id, jobId));
  if (!row) {
    throw new Error(`no job ${jobId}`);
  }
  return row;
};

/** A successful compile result for the job's class: the artifact, one source file and the resolved commit. */
export const compileResult = (
  job: SeededJob,
  artifactJson: string,
  overrides: Partial<CompileSourceResultEvent> = {},
): CompileSourceResultEvent => ({
  jobId: job.jobId,
  contractClassId: job.contractClassId,
  version: job.version,
  status: "success",
  aztecVersion: `6.0.${randomBytes(1)[0]}`,
  artifactJson,
  sourceFiles: [{ path: "src/main.nr", content: `// ${job.jobId}` }],
  commitHash: randomBytes(20).toString("hex"),
  ...overrides,
});

export const sourceUrlOf = (job: SeededJob, result: CompileSourceResultEvent) =>
  `${job.githubUrl}/tree/${result.commitHash}`;

export const deliverCompileResult = async (result: CompileSourceResultEvent) => {
  const { compileSourceResultHandler } = await import(
    "../../../src/events/received/on-compile-source-result.js"
  );
  await deliver(compileSourceResultHandler, result);
};
