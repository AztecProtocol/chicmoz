import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  classPath,
  rawArtifact,
  readClassRow,
  seedClass,
  seedStoredArtifact,
} from "./support/contracts.js";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";
import { gate } from "./support/gate.js";
import {
  compileResult,
  deliverCompileResult,
  readJob,
  seedJob,
  sourceUrlOf,
} from "./support/source-verification.js";

vi.mock(
  "../../src/svcs/database/controllers/l2contract/source-verification.js",
  async (importOriginal) => {
    const actual = await importOriginal<{
      storeVerifiedSource: (...args: never[]) => Promise<unknown>;
    }>();
    const { gate: fileGate } = await import("./support/gate.js");
    return {
      ...actual,
      storeVerifiedSource: fileGate.before(actual.storeVerifiedSource),
    };
  },
);

const rawJson = (file: string) => JSON.stringify(rawArtifact(file));

describe("source verification results", () => {
  let api: ExplorerApiForTest;

  beforeAll(async () => {
    api = await startExplorerApiForTest();
  });

  afterEach(() => {
    gate.disarm();
  });

  afterAll(async () => {
    await api?.close();
  });

  it("fails a job whose compiled artifact does not match the contract class", async () => {
    const artifact = rawArtifact("public_checks_contract-PublicChecks");
    const seeded = await seedClass(artifact);
    await seedStoredArtifact(seeded, artifact);
    const job = await seedJob(seeded);

    await deliverCompileResult(
      compileResult(
        job,
        rawJson("multi_call_entrypoint_contract-MultiCallEntrypoint"),
      ),
    );

    expect(await readJob(job.jobId)).toMatchObject({
      status: "FAILED",
      failureStage: "ARTIFACT_VERIFICATION",
      error: "Compiled artifact does not match the contract class",
    });
    expect(await readClassRow(seeded)).toMatchObject({
      artifactJson: JSON.stringify(artifact),
      sourceCode: null,
      sourceCodeUrl: null,
      sourceCodeCommitHash: null,
    });
  });

  it("verifies source and stores the artifact for a matching job", async () => {
    const file =
      "schnorr_initializerless_account_contract-SchnorrInitializerlessAccount";
    const seeded = await seedClass(rawArtifact(file));
    const job = await seedJob(seeded);
    const result = compileResult(job, rawJson(file));

    await deliverCompileResult(result);

    expect(await readJob(job.jobId)).toMatchObject({
      status: "VERIFIED",
      commitHash: result.commitHash,
      aztecVersion: result.aztecVersion,
      error: null,
      failureStage: null,
      compileOutput: null,
    });
    expect(await readClassRow(seeded)).toMatchObject({
      artifactJson: result.artifactJson,
      artifactContractName: "SchnorrInitializerlessAccount",
      sourceCode: result.sourceFiles,
      sourceCodeUrl: sourceUrlOf(job, result),
      sourceCodeCommitHash: result.commitHash,
    });
  });

  it("keeps the first verified source when two results match (two jobs)", async () => {
    const file = "price_feed_contract-PriceFeed";
    const seeded = await seedClass(rawArtifact(file));
    const jobs = [await seedJob(seeded), await seedJob(seeded)];
    const results = jobs.map((job) => compileResult(job, rawJson(file)));
    gate.arm();

    await Promise.all(results.map((result) => deliverCompileResult(result)));

    const statuses = await Promise.all(
      jobs.map(async (job) => (await readJob(job.jobId)).status),
    );
    expect([...statuses].sort()).toEqual(["FAILED", "VERIFIED"]);
    const winner = statuses.indexOf("VERIFIED");
    const loser = 1 - winner;
    expect(await readJob(jobs[loser].jobId)).toMatchObject({
      error: "Source code is already verified for this contract class",
    });
    expect(await readClassRow(seeded)).toMatchObject({
      sourceCode: results[winner].sourceFiles,
      sourceCodeUrl: sourceUrlOf(jobs[winner], results[winner]),
      sourceCodeCommitHash: results[winner].commitHash,
    });
    const source = await api.request.get(`${classPath(seeded)}/source`);
    expect(source.body).toMatchObject({
      gitRef: jobs[winner].gitRef,
      aztecVersion: results[winner].aztecVersion,
    });
  });

  it("keeps the first verified source when two results match (one job, its result twice)", async () => {
    const file = "auth_registry_contract-AuthRegistry";
    const seeded = await seedClass(rawArtifact(file));
    const job = await seedJob(seeded);
    const result = compileResult(job, rawJson(file));
    gate.arm();

    await Promise.all([
      deliverCompileResult(result),
      deliverCompileResult(result),
    ]);

    expect(await readJob(job.jobId)).toMatchObject({
      status: "VERIFIED",
      error: null,
      failureStage: null,
    });
    expect(await readClassRow(seeded)).toMatchObject({
      sourceCode: result.sourceFiles,
      sourceCodeUrl: sourceUrlOf(job, result),
    });
  });

  it.each([
    [
      "an unknown job",
      "ecdsa_k_account_contract-EcdsaKAccount",
      undefined,
      "success",
    ],
    [
      "a failed job",
      "sponsored_fpc_contract-SponsoredFPC",
      { status: "FAILED", error: "Compilation timed out" },
      "success",
    ],
    [
      "a verified job",
      "handshake_registry_contract-HandshakeRegistry",
      { status: "VERIFIED" },
      "compilation_failed",
    ],
  ] as const)(
    "ignores results for jobs that are unknown or finished (%s)",
    async (_, file, jobState, status) => {
      const seeded = await seedClass(rawArtifact(file));
      const job = await seedJob(seeded, jobState ?? {});
      const result = compileResult(job, rawJson(file), { status });
      const classBefore = await readClassRow(seeded);
      const jobBefore = await readJob(job.jobId);

      await deliverCompileResult(
        jobState ? result : { ...result, jobId: randomUUID() },
      );

      expect(await readClassRow(seeded)).toEqual(classBefore);
      expect(await readJob(job.jobId)).toEqual(jobBefore);
    },
  );

  it("checks a result against the class of its job", async () => {
    const jobClass = await seedClass(rawArtifact("escrow_contract-Escrow"));
    const otherFile = "ecdsa_r_account_contract-EcdsaRAccount";
    const otherClass = await seedClass(rawArtifact(otherFile));
    const job = await seedJob(jobClass);
    const before = [await readClassRow(jobClass), await readClassRow(otherClass)];

    await deliverCompileResult(
      compileResult(job, rawJson(otherFile), {
        contractClassId: otherClass.contractClassId,
        version: otherClass.version,
      }),
    );

    expect(await readJob(job.jobId)).toMatchObject({
      status: "FAILED",
      failureStage: "ARTIFACT_VERIFICATION",
    });
    expect([
      await readClassRow(jobClass),
      await readClassRow(otherClass),
    ]).toEqual(before);
  });

  it("a failed finalization stores no source", async () => {
    const file = "schnorr_hardcoded_account_contract-SchnorrHardcodedAccount";
    const seeded = await seedClass(rawArtifact(file));
    await seedStoredArtifact(seeded, rawArtifact(file));
    const job = await seedJob(seeded);
    const { getDb } = await import("@chicmoz-pkg/postgres-helper");
    // Makes the VERIFIED transition fail after the source write has run.
    const constraint = `no_verified_${job.jobId.replaceAll("-", "")}`;
    await getDb().execute(
      sql.raw(
        `ALTER TABLE source_verification_jobs ADD CONSTRAINT ${constraint} CHECK (NOT (id = '${job.jobId}' AND status = 'VERIFIED'))`,
      ),
    );
    try {
      await deliverCompileResult(compileResult(job, rawJson(file)));
    } finally {
      await getDb().execute(
        sql.raw(
          `ALTER TABLE source_verification_jobs DROP CONSTRAINT ${constraint}`,
        ),
      );
    }

    expect(await readClassRow(seeded)).toMatchObject({
      sourceCode: null,
      sourceCodeUrl: null,
      sourceCodeCommitHash: null,
    });
    expect((await readJob(job.jobId)).status).toBe("FAILED");
  });
});
