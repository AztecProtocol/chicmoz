import {
  loadContractArtifact,
  type NoirCompiledContract,
} from "@aztec-labs/aztec.js/abi";
import {
  ARTIFACT_REFUSED_MESSAGE,
  checkArtifactShape,
} from "@chicmoz-pkg/contract-verification";
import { type ContractStandard } from "@chicmoz-pkg/types";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  classPath,
  instancePath,
  rawArtifact,
  readClassRow,
  readDeploymentArguments,
  seedClass,
  seedInstance,
  seedStoredArtifact,
  unusedAddress,
  variant,
} from "./support/contracts.js";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";
import { gate } from "./support/gate.js";

vi.mock(
  "../../src/svcs/database/controllers/l2contract/get-registered-contract-class.js",
  async (importOriginal) => {
    const actual = await importOriginal<{
      getL2RegisteredContractClass: (
        ...args: [string, number, boolean?]
      ) => Promise<unknown>;
    }>();
    const { gate: fileGate } = await import("./support/gate.js");
    return {
      ...actual,
      getL2RegisteredContractClass: fileGate.after(
        actual.getL2RegisteredContractClass,
      ),
    };
  },
);

// A struct list the SDK's artifact schema refuses inside a nested union, in an
// artifact the size walk accepts; the SDK's error message quotes its record key.
const SDK_MESSAGE_MARKER = "zzmarker7f3a";
const refusedBySdkSchema = (artifact: NoirCompiledContract) => {
  (artifact.outputs.structs as Record<string, unknown>)[SDK_MESSAGE_MARKER] = [
    {
      kind: "struct",
      path: "x::Y",
      fields: [{ name: "f", type: { kind: "unknown" } }],
    },
  ];
  const json = JSON.stringify(artifact);
  expect(() => checkArtifactShape(JSON.parse(json))).not.toThrow();
  expect(() => loadContractArtifact(artifact)).toThrow(SDK_MESSAGE_MARKER);
  return json;
};

const TOKEN_STANDARD = {
  name: "token",
  version: "4.2.0-aztecnr-rc.2",
} as ContractStandard;

describe("contract class artifact uploads", () => {
  let api: ExplorerApiForTest;

  beforeAll(async () => {
    api = await startExplorerApiForTest();
  });

  afterAll(async () => {
    await api?.close();
  });

  const verifyDeployment = (
    address: string,
    verifiedDeploymentArguments: Record<string, unknown>,
  ) =>
    api.request
      .post(instancePath(address))
      .send({ verifiedDeploymentArguments });

  it.each([
    [
      "another class's artifact",
      "ecdsa_k_account_contract-EcdsaKAccount",
      () => JSON.stringify(rawArtifact("escrow_contract-Escrow")),
      "Incorrect artifact",
    ],
    [
      "an artifact loaded by the SDK",
      "ecdsa_r_account_contract-EcdsaRAccount",
      () =>
        JSON.stringify(
          loadContractArtifact(
            rawArtifact("ecdsa_r_account_contract-EcdsaRAccount"),
          ),
        ),
      "Artifact must be the raw aztec compile output",
    ],
  ])(
    "answers 400 with the rule for a refused artifact upload (%s)",
    async (_, classFile, upload, text) => {
      const seeded = await seedClass(rawArtifact(classFile));

      const res = await api.request
        .post(classPath(seeded))
        .send({ stringifiedArtifactJson: upload() });

      expect({ status: res.status, text: res.text }).toEqual({
        status: 400,
        text,
      });
      expect((await readClassRow(seeded)).artifactJson).toBeNull();
    },
  );

  it("an artifact upload reads the class from the database, not the cache", async () => {
    const artifact = rawArtifact(
      "schnorr_hardcoded_account_contract-SchnorrHardcodedAccount",
    );
    const seeded = await seedClass(artifact);
    await seedStoredArtifact(seeded, artifact);
    const stored = await readClassRow(seeded);
    // A with-artifact entry holding a row read without the artifact columns.
    const { controllers } = await import("../../src/svcs/database/index.js");
    const { jsonStringify } = await import("@chicmoz-pkg/types");
    const { setEntry } = await import("@chicmoz-pkg/redis-helper");
    await setEntry(
      [
        "l2",
        "contract-classes",
        seeded.contractClassId,
        seeded.version,
        "with-artifact",
      ],
      jsonStringify(
        await controllers.l2Contract.getL2RegisteredContractClass(
          seeded.contractClassId,
          seeded.version,
        ),
      ),
      60,
    );

    const res = await api.request
      .post(classPath(seeded))
      .send({ stringifiedArtifactJson: JSON.stringify(variant(artifact)) });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ artifactJson: stored.artifactJson });
    expect(await readClassRow(seeded)).toEqual(stored);
  });

  it("concurrent artifact uploads keep the first written one", async () => {
    const artifact = rawArtifact("escrow_contract-Escrow");
    const seeded = await seedClass(artifact);
    gate.arm();

    const responses = await Promise.all(
      [artifact, variant(artifact)].map((upload) =>
        api.request
          .post(classPath(seeded))
          .send({ stringifiedArtifactJson: JSON.stringify(upload) }),
      ),
    );

    const { artifactJson } = await readClassRow(seeded);
    expect(responses.map((res) => res.status).sort()).toEqual([200, 201]);
    expect(
      responses.map(
        (res) => (res.body as { artifactJson: string }).artifactJson,
      ),
    ).toEqual([artifactJson, artifactJson]);
  });

  describe("an artifact the SDK's schema refuses", () => {
    it("the class artifact route answers the fixed refusal, not the SDK's message", async () => {
      const artifact = rawArtifact("auth_contract-Auth");
      const seeded = await seedClass(artifact);

      const res = await api.request
        .post(classPath(seeded))
        .send({ stringifiedArtifactJson: refusedBySdkSchema(artifact) });

      expect({ status: res.status, text: res.text }).toEqual({
        status: 400,
        text: ARTIFACT_REFUSED_MESSAGE,
      });
      expect((await readClassRow(seeded)).artifactJson).toBeNull();
    });

    it("the deployment verification route answers the fixed refusal, not the SDK's message", async () => {
      const artifact = rawArtifact(
        "handshake_registry_contract-HandshakeRegistry",
      );
      const seeded = await seedClass(artifact);
      const { address, deploymentArguments } = await seedInstance(artifact);

      const res = await verifyDeployment(address, {
        ...deploymentArguments,
        stringifiedArtifactJson: refusedBySdkSchema(artifact),
      });

      expect({ status: res.status, text: res.text }).toEqual({
        status: 400,
        text: ARTIFACT_REFUSED_MESSAGE,
      });
      expect((await readClassRow(seeded)).artifactJson).toBeNull();
      expect(await readDeploymentArguments(address)).toBeUndefined();
    });
  });

  describe("deployment verification", () => {
    it("a deployment verification leaves a stored artifact unchanged", async () => {
      const artifact = rawArtifact("public_checks_contract-PublicChecks");
      const seeded = await seedClass(artifact);
      await seedStoredArtifact(seeded, artifact, TOKEN_STANDARD);
      const stored = await readClassRow(seeded);
      const { address, deploymentArguments } = await seedInstance(artifact);

      const res = await verifyDeployment(address, {
        ...deploymentArguments,
        stringifiedArtifactJson: JSON.stringify(variant(artifact)),
      });

      expect(res.status).toBe(200);
      expect(stored).toMatchObject({
        artifactJson: JSON.stringify(artifact),
        standardContractType: TOKEN_STANDARD.name,
      });
      expect(stored.selectorMap).not.toBeNull();
      expect(await readClassRow(seeded)).toEqual(stored);
    });

    it("a deployment verification without an artifact uses the stored one", async () => {
      const artifact = rawArtifact(
        "multi_call_entrypoint_contract-MultiCallEntrypoint",
      );
      const seeded = await seedClass(artifact);
      await seedStoredArtifact(seeded, artifact);
      const { address, deploymentArguments } = await seedInstance(artifact);

      const res = await verifyDeployment(address, deploymentArguments);

      expect(res.status).toBe(200);
      expect(await readDeploymentArguments(address)).toMatchObject({
        salt: deploymentArguments.salt,
        publicKeysString: deploymentArguments.publicKeysString,
      });
    });
  });

  describe("deployment verification storing a first artifact", () => {
    it("a refused deployment verification stores nothing", async () => {
      const artifact = rawArtifact("auth_registry_contract-AuthRegistry");
      const seeded = await seedClass(artifact);
      const { address, deploymentArguments } = await seedInstance(artifact, {
        atAddress: await unusedAddress(artifact),
      });

      const res = await verifyDeployment(address, {
        ...deploymentArguments,
        stringifiedArtifactJson: JSON.stringify(artifact),
      });

      expect({ status: res.status, text: res.text }).toEqual({
        status: 400,
        text: "Uploaded data does not lead to correct contract address",
      });
      expect((await readClassRow(seeded)).artifactJson).toBeNull();
      expect(await readDeploymentArguments(address)).toBeUndefined();
    });

    it("a deployment verification stores a first artifact once it is verified", async () => {
      const artifact = rawArtifact(
        "schnorr_initializerless_account_contract-SchnorrInitializerlessAccount",
      );
      const seeded = await seedClass(artifact);
      const { address, deploymentArguments } = await seedInstance(artifact);

      const res = await verifyDeployment(address, {
        ...deploymentArguments,
        stringifiedArtifactJson: JSON.stringify(artifact),
      });

      expect(res.status).toBe(200);
      expect(await readClassRow(seeded)).toMatchObject({
        artifactJson: JSON.stringify(artifact),
        artifactContractName: artifact.name,
      });
      expect(await readDeploymentArguments(address)).toMatchObject({
        salt: deploymentArguments.salt,
      });
    });

    it("a deployment verification refuses an artifact of another class", async () => {
      const artifact = rawArtifact("price_feed_contract-PriceFeed");
      const seeded = await seedClass(artifact);
      const { address, deploymentArguments } = await seedInstance(artifact);

      const res = await verifyDeployment(address, {
        ...deploymentArguments,
        stringifiedArtifactJson: JSON.stringify(
          rawArtifact("sponsored_fpc_contract-SponsoredFPC"),
        ),
      });

      expect({ status: res.status, text: res.text }).toEqual({
        status: 400,
        text: "Uploaded artifact does not match contract class",
      });
      expect((await readClassRow(seeded)).artifactJson).toBeNull();
      expect(await readDeploymentArguments(address)).toBeUndefined();
    });
  });
});
