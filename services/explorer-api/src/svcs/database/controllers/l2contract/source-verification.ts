import { getDb as db } from "@chicmoz-pkg/postgres-helper";
import type {
  SourceVerificationFailureStage,
  SourceVerificationStatus,
} from "@chicmoz-pkg/types";
import {
  TransactionRollbackError,
  and,
  desc,
  eq,
  inArray,
  isNull,
  notInArray,
  sql,
} from "drizzle-orm";
import {
  l2ContractClassRegistered,
  sourceVerificationJobs,
} from "../../schema/l2contract/index.js";

// A finished job's status is final: a late or repeated result changes nothing.
const unfinishedJob = (jobId: string) =>
  and(
    eq(sourceVerificationJobs.id, jobId),
    notInArray(sourceVerificationJobs.status, ["VERIFIED", "FAILED"]),
  );

export const createSourceVerificationJob = async ({
  id,
  contractClassId,
  version,
  githubUrl,
  gitRef,
  subPath,
  clientIp,
}: {
  id: string;
  contractClassId: string;
  version: number;
  githubUrl: string;
  gitRef?: string;
  subPath?: string;
  clientIp?: string;
}): Promise<void> => {
  await db()
    .insert(sourceVerificationJobs)
    .values({
      id,
      contractClassId,
      version,
      githubUrl,
      gitRef: gitRef ?? null,
      subPath: subPath ?? null,
      aztecVersion: null,
      clientIp: clientIp ?? null,
      status: "PENDING",
    });
};

export const getSourceVerificationJob = async (
  jobId: string,
): Promise<typeof sourceVerificationJobs.$inferSelect | null> => {
  const result = await db()
    .select()
    .from(sourceVerificationJobs)
    .where(eq(sourceVerificationJobs.id, jobId))
    .limit(1);
  return result.length > 0 ? result[0] : null;
};

export const getSourceVerificationJobsByContractClass = async (
  contractClassId: string,
  version: number,
): Promise<Array<typeof sourceVerificationJobs.$inferSelect>> => {
  return db()
    .select()
    .from(sourceVerificationJobs)
    .where(
      and(
        eq(sourceVerificationJobs.contractClassId, contractClassId),
        eq(sourceVerificationJobs.version, version),
      ),
    );
};

export const updateSourceVerificationJobStatus = async ({
  jobId,
  status,
  error,
  commitHash,
  aztecVersion,
  failureStage,
  compileOutput,
}: {
  jobId: string;
  status: SourceVerificationStatus;
  error?: string;
  commitHash?: string;
  aztecVersion?: string;
  failureStage?: SourceVerificationFailureStage;
  compileOutput?: string;
}): Promise<{ updated: boolean }> => {
  const updateValues: Record<string, unknown> = {
    status,
    error: error ?? null,
    failureStage: failureStage ?? null,
    compileOutput: compileOutput ?? null,
  };
  if (commitHash !== undefined) {
    updateValues.commitHash = commitHash;
  }
  if (aztecVersion !== undefined) {
    updateValues.aztecVersion = aztecVersion;
  }
  const updated = await db()
    .update(sourceVerificationJobs)
    .set(updateValues)
    .where(unfinishedJob(jobId))
    .returning({ id: sourceVerificationJobs.id });
  return { updated: updated.length > 0 };
};

/**
 * Stores a class's verified source and marks its job VERIFIED, both or
 * neither: nothing is written when the class already has source or the job
 * has finished. Database errors propagate.
 */
export const storeVerifiedSource = async ({
  jobId,
  contractClassId,
  version,
  sourceCode,
  sourceCodeUrl,
  sourceCodeCommitHash,
  aztecVersion,
}: {
  jobId: string;
  contractClassId: string;
  version: number;
  sourceCode: Array<{ path: string; content: string }>;
  sourceCodeUrl: string;
  sourceCodeCommitHash?: string;
  aztecVersion?: string;
}): Promise<{ written: boolean }> => {
  try {
    return await db().transaction(async (tx) => {
      const stored = await tx
        .update(l2ContractClassRegistered)
        .set({
          sourceCode,
          sourceCodeUrl,
          sourceCodeCommitHash: sourceCodeCommitHash ?? null,
        })
        .where(
          and(
            eq(l2ContractClassRegistered.contractClassId, contractClassId),
            eq(l2ContractClassRegistered.version, version),
            isNull(l2ContractClassRegistered.sourceCodeUrl),
          ),
        )
        .returning({ contractClassId: l2ContractClassRegistered.contractClassId });
      if (stored.length === 0) {
        return { written: false };
      }
      const verified = await tx
        .update(sourceVerificationJobs)
        .set({
          status: "VERIFIED",
          error: null,
          failureStage: null,
          compileOutput: null,
          ...(sourceCodeCommitHash !== undefined
            ? { commitHash: sourceCodeCommitHash }
            : {}),
          ...(aztecVersion !== undefined ? { aztecVersion } : {}),
        })
        .where(unfinishedJob(jobId))
        .returning({ id: sourceVerificationJobs.id });
      if (verified.length === 0) {
        tx.rollback();
      }
      return { written: true };
    });
  } catch (error) {
    if (error instanceof TransactionRollbackError) {
      return { written: false };
    }
    throw error;
  }
};

export const getActiveVerificationJobCount = async (): Promise<number> => {
  const result = await db()
    .select({ count: sql<number>`count(*)` })
    .from(sourceVerificationJobs)
    .where(
      inArray(sourceVerificationJobs.status, [
        "PENDING",
        "COMPILING",
        "VERIFYING",
      ]),
    );
  return result[0]?.count ?? 0;
};

export const getActiveJobCountByIp = async (
  clientIp: string,
): Promise<number> => {
  const result = await db()
    .select({ count: sql<number>`count(*)` })
    .from(sourceVerificationJobs)
    .where(
      and(
        eq(sourceVerificationJobs.clientIp, clientIp),
        inArray(sourceVerificationJobs.status, [
          "PENDING",
          "COMPILING",
          "VERIFYING",
        ]),
      ),
    );
  return result[0]?.count ?? 0;
};

export const getContractClassSourceCode = async (
  contractClassId: string,
  version: number,
): Promise<{
  sourceCode: Array<{ path: string; content: string }> | null;
  sourceCodeUrl: string | null;
  sourceCodeCommitHash: string | null;
  gitRef: string | null;
  aztecVersion: string | null;
}> => {
  const result = await db()
    .select({
      sourceCode: l2ContractClassRegistered.sourceCode,
      sourceCodeUrl: l2ContractClassRegistered.sourceCodeUrl,
      sourceCodeCommitHash: l2ContractClassRegistered.sourceCodeCommitHash,
      gitRef: sourceVerificationJobs.gitRef,
      aztecVersion: sourceVerificationJobs.aztecVersion,
    })
    .from(l2ContractClassRegistered)
    .leftJoin(
      sourceVerificationJobs,
      and(
        eq(sourceVerificationJobs.contractClassId, contractClassId),
        eq(sourceVerificationJobs.version, version),
        eq(sourceVerificationJobs.status, "VERIFIED"),
      ),
    )
    .where(
      and(
        eq(l2ContractClassRegistered.contractClassId, contractClassId),
        eq(l2ContractClassRegistered.version, version),
      ),
    )
    .orderBy(
      desc(sourceVerificationJobs.updatedAt),
      desc(sourceVerificationJobs.createdAt),
    )
    .limit(1);
  if (result.length === 0) {
    return {
      sourceCode: null,
      sourceCodeUrl: null,
      sourceCodeCommitHash: null,
      gitRef: null,
      aztecVersion: null,
    };
  }
  return {
    sourceCode: result[0].sourceCode ?? null,
    sourceCodeUrl: result[0].sourceCodeUrl ?? null,
    sourceCodeCommitHash: result[0].sourceCodeCommitHash ?? null,
    gitRef: result[0].gitRef ?? null,
    aztecVersion: result[0].aztecVersion ?? null,
  };
};
