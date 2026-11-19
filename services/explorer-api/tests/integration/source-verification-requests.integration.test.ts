import { eq, inArray } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  type SeededClass,
  classPath,
  rawArtifact,
  seedClass,
} from "./support/contracts.js";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";
import {
  compileResult,
  deliverCompileResult,
  readJob,
  seedJob,
  sourceUrlOf,
} from "./support/source-verification.js";

type MessageBus = typeof import("../../src/svcs/message-bus/index.js");

// Records what the routes hand the message bus; the publish itself still goes to Kafka.
vi.mock("../../src/svcs/message-bus/index.js", async (importOriginal) => {
  const actual = await importOriginal<MessageBus>();
  return { ...actual, publishMessage: vi.fn(actual.publishMessage) };
});

const publishCalls = async () => {
  const { publishMessage } = await import(
    "../../src/svcs/message-bus/index.js"
  );
  return vi.mocked(publishMessage).mock.calls;
};

const jobsOf = async ({ contractClassId, version }: SeededClass) => {
  const { controllers } = await import("../../src/svcs/database/index.js");
  return controllers.l2Contract.getSourceVerificationJobsByContractClass(
    contractClassId,
    version,
  );
};

const unknownClass = (): SeededClass => ({
  contractClassId: `0x${randomBytes(32).toString("hex")}`,
  version: 1,
});

const INVALID_URL_ERROR =
  "Invalid GitHub URL. Must be a public GitHub repository URL.";

describe("source verification requests", () => {
  let api: ExplorerApiForTest;
  let unverified: SeededClass;

  const submit = (seeded: SeededClass, body: Record<string, string>) =>
    api.request.post(`${classPath(seeded)}/verify-source`).send(body);

  beforeAll(async () => {
    api = await startExplorerApiForTest();
    unverified = await seedClass(rawArtifact("auth_contract-Auth"));
  });

  beforeEach(async () => {
    const { publishMessage } = await import(
      "../../src/svcs/message-bus/index.js"
    );
    vi.mocked(publishMessage).mockClear();
  });

  afterAll(async () => {
    await api?.close();
  });

  it.each([
    ["a GitHub URL without a repository", "https://github.com/example"],
    [
      "a GitHub URL with a path below the repository",
      "https://github.com/example/token/tree/main",
    ],
    ["a URL on another host", "https://gitlab.com/example/token"],
    [
      "a URL on a host that only starts with github.com",
      "https://github.com.example.org/example/token",
    ],
  ])("refuses %s with 400", async (_, githubUrl) => {
    const jobsBefore = await jobsOf(unverified);

    const res = await submit(unverified, { githubUrl });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: INVALID_URL_ERROR });
    expect(await jobsOf(unverified)).toEqual(jobsBefore);
    expect(await publishCalls()).toEqual([]);
  });

  // zod 3's .url() returns the input untrimmed, so the repository check sees
  // the padding.
  it("refuses a GitHub URL padded with spaces with 400", async () => {
    const jobsBefore = await jobsOf(unverified);

    const res = await submit(unverified, {
      githubUrl: " https://github.com/example/token ",
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: INVALID_URL_ERROR });
    expect(await jobsOf(unverified)).toEqual(jobsBefore);
    expect(await publishCalls()).toEqual([]);
  });

  it("answers 404 for an unknown class", async () => {
    const res = await submit(unknownClass(), {
      githubUrl: "https://github.com/example/token",
    });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Contract class not found" });
    expect(await publishCalls()).toEqual([]);
  });

  it("refuses a class whose source is already verified, with its status", async () => {
    const file = "claim_contract-Claim";
    const verified = await seedClass(rawArtifact(file));
    const job = await seedJob(verified);
    const result = compileResult(job, JSON.stringify(rawArtifact(file)));
    await deliverCompileResult(result);
    expect((await readJob(job.jobId)).status).toBe("VERIFIED");

    const res = await submit(verified, {
      githubUrl: "https://github.com/example/another-token",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      jobId: null,
      status: "VERIFIED",
      sourceCodeUrl: sourceUrlOf(job, result),
    });
    expect((await jobsOf(verified)).map(({ id }) => id)).toEqual([job.jobId]);
    expect(await publishCalls()).toEqual([]);
  });

  it("creates a job and publishes one compile request for a valid request", async () => {
    const body = {
      githubUrl: "https://github.com/example/token.git",
      gitRef: "release/v1",
      subPath: "contracts/token",
    };

    const res = await submit(unverified, body);

    expect(res.status).toBe(202);
    const { jobId } = res.body as { jobId: string };
    expect(res.body).toEqual({ jobId, status: "COMPILING" });
    expect(await publishCalls()).toEqual([
      ["COMPILE_SOURCE_REQUEST_EVENT", { jobId, ...unverified, ...body }],
    ]);
    expect(await readJob(jobId)).toMatchObject({
      ...unverified,
      ...body,
      status: "COMPILING",
    });
  });

  it("serves a created job's status under its own class only", async () => {
    const githubUrl = "https://github.com/example/token";
    const created = await submit(unverified, { githubUrl });
    const { jobId } = created.body as { jobId: string };

    const res = await api.request.get(
      `${classPath(unverified)}/verify-source/${jobId}`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: jobId,
      ...unverified,
      githubUrl,
      gitRef: null,
      subPath: null,
      status: "COMPILING",
    });
    const otherVersion = { ...unverified, version: unverified.version + 1 };
    for (const elsewhere of [unknownClass(), otherVersion]) {
      const other = await api.request.get(
        `${classPath(elsewhere)}/verify-source/${jobId}`,
      );
      expect(other.status).toBe(404);
    }
  });

  it("counts only the requesting address's active jobs toward its limit of three", async () => {
    // Earlier tests left jobs from this address active.
    const { getDb } = await import("@chicmoz-pkg/postgres-helper");
    const { sourceVerificationJobs: t } = await import(
      "../../src/svcs/database/schema/l2contract/index.js"
    );
    await getDb()
      .update(t)
      .set({ status: "FAILED" })
      .where(inArray(t.status, ["PENDING", "COMPILING", "VERIFYING"]));
    const body = { githubUrl: "https://github.com/example/token" };
    const first = await submit(unverified, body);
    expect(first.status).toBe(202);
    const { clientIp } = await readJob((first.body as { jobId: string }).jobId);
    expect(typeof clientIp).toBe("string");
    const pending = await seedJob(unverified, { status: "PENDING", clientIp });
    await seedJob(unverified, { status: "VERIFYING", clientIp });
    for (const status of ["VERIFIED", "FAILED"] as const) {
      await seedJob(unverified, { status, clientIp });
    }
    for (const status of ["PENDING", "COMPILING", "VERIFYING"] as const) {
      await seedJob(unverified, { status, clientIp: "203.0.113.7" });
    }
    const jobsBefore = await jobsOf(unverified);

    const refused = await submit(unverified, body);

    expect(refused.status).toBe(429);
    expect(await jobsOf(unverified)).toEqual(jobsBefore);
    await getDb()
      .update(t)
      .set({ status: "FAILED" })
      .where(eq(t.id, pending.jobId));
    expect((await submit(unverified, body)).status).toBe(202);
    expect(await publishCalls()).toHaveLength(2);
  });
});
