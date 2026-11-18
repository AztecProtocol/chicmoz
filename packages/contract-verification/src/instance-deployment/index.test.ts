import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import {
  loadContractArtifact,
  type NoirCompiledContract,
} from "@aztec-labs/aztec.js/abi";
import {
  getContractClassFromArtifact,
  getContractInstanceFromInstantiationParams,
} from "@aztec-labs/aztec.js/contracts";
import { Fr } from "@aztec-labs/aztec.js/fields";
import authArtifactJson from "@aztec-labs/noir-contracts.js/artifacts/auth_contract-Auth" with { type: "json" };
import escrowArtifactJson from "@aztec-labs/noir-contracts.js/artifacts/escrow_contract-Escrow" with { type: "json" };
import publicChecksArtifactJson from "@aztec-labs/noir-contracts.js/artifacts/public_checks_contract-PublicChecks" with { type: "json" };
import { type AbiType } from "@aztec-labs/stdlib/abi";
import { CONSTRUCTOR_ARGS_MAX } from "@chicmoz-pkg/types";
import { describe, expect, test } from "vitest";
import { generateVerifyInstancePayload } from "./generate-payload.js";
import { verifyInstanceDeploymentPayload } from "./verify-payload.js";

const copy = (json: unknown) => structuredClone(json) as NoirCompiledContract;

const admin =
  "0x0000000000000000000000000000000000000000000000000000000000001234";
const other =
  "0x0000000000000000000000000000000000000000000000000000000000005678";

const deploy = async (
  artifactJson: unknown,
  constructorArgs: string[],
  constructorArtifact?: string,
) => {
  const artifact = loadContractArtifact(copy(artifactJson));
  const contractClass = await getContractClassFromArtifact(artifact);
  const instance = await getContractInstanceFromInstantiationParams(artifact, {
    constructorArtifact,
    constructorArgs,
    deployer: AztecAddress.ZERO,
    salt: Fr.random(),
  });
  return { contractClassId: contractClass.id.toString(), instance };
};

const verify = (
  { contractClassId, instance }: Awaited<ReturnType<typeof deploy>>,
  storedArtifact: unknown,
  constructorArgs: string[],
  limits?: Parameters<typeof verifyInstanceDeploymentPayload>[1],
) =>
  verifyInstanceDeploymentPayload(
    {
      ...generateVerifyInstancePayload({
        publicKeysString: instance.publicKeys.toString(),
        deployer: instance.deployer.toString(),
        salt: instance.salt.toString(),
        constructorArgs,
      }),
      stringifiedArtifactJson: JSON.stringify(storedArtifact),
      instanceAddress: instance.address.toString(),
      contractClassId,
      immutablesHash: instance.immutablesHash.toString(),
    },
    limits,
  );

const withInitializerMarker = (
  artifactJson: unknown,
  marked: string[],
): NoirCompiledContract => {
  const artifact = copy(artifactJson);
  for (const fn of artifact.functions) {
    const attributes = fn.custom_attributes.filter(
      (attribute) => attribute !== "abi_initializer",
    );
    fn.custom_attributes = marked.includes(fn.name)
      ? [...attributes, "abi_initializer"]
      : attributes;
  }
  return artifact;
};

describe("v5 instance deployment verification", () => {
  test("verifies an instance deployed through its marked initializer", async () => {
    const deployment = await deploy(authArtifactJson, [admin]);

    await expect(
      verify(deployment, authArtifactJson, [admin]),
    ).resolves.toEqual({ isVerified: true, initializer: "constructor" });
  });

  test.each<[string, unknown, string[]]>([
    ["removed", authArtifactJson, []],
    ["moved to another function", authArtifactJson, ["set_authorized"]],
    ["removed from a private initializer", escrowArtifactJson, []],
  ])(
    "verifies the deployment when the stored artifact's initializer marker is %s",
    async (_, artifactJson, marked) => {
      const deployment = await deploy(artifactJson, [admin]);
      const stored = withInitializerMarker(artifactJson, marked);
      const storedClass = await getContractClassFromArtifact(
        loadContractArtifact(copy(stored)),
      );
      expect(storedClass.id.toString()).toBe(deployment.contractClassId);

      await expect(verify(deployment, stored, [admin])).resolves.toEqual({
        isVerified: true,
        initializer: "constructor",
      });
    },
  );

  test("verifies an instance without an initializer only with empty constructor arguments", async () => {
    const deployment = await deploy(publicChecksArtifactJson, []);

    await expect(
      verify(deployment, publicChecksArtifactJson, []),
    ).resolves.toEqual({ isVerified: true, initializer: null });
    await expect(
      verify(deployment, publicChecksArtifactJson, [admin]),
    ).resolves.toEqual({ isVerified: false });
  });

  // Built without the marker, so the initialization hash is zero; Auth's
  // zero-parameter functions would meet a candidate limit of 0 first.
  test("verifies an instance without an initializer before any candidate limit", async () => {
    const deployment = await deploy(
      withInitializerMarker(authArtifactJson, []),
      [],
    );

    await expect(
      verify(deployment, authArtifactJson, [], {
        candidates: 0,
        encodedFields: 65_536,
      }),
    ).resolves.toEqual({ isVerified: true, initializer: null });
  });

  test("refuses constructor arguments that lead to another address for every function", async () => {
    const deployment = await deploy(authArtifactJson, [admin]);

    await expect(
      verify(deployment, authArtifactJson, [other]),
    ).resolves.toEqual({ isVerified: false });
  });

  test("refuses an argument longer than the argument length limit", async () => {
    const deployment = await deploy(authArtifactJson, [admin]);
    const padded = (length: number) =>
      `0x${admin.slice(2).padStart(length - 2, "0")}`;

    await expect(
      verify(deployment, authArtifactJson, [admin]),
    ).resolves.toEqual({ isVerified: true, initializer: "constructor" });
    await expect(
      verify(deployment, authArtifactJson, [padded(8_192)]),
    ).resolves.toEqual({ isVerified: true, initializer: "constructor" });
    await expect(
      verify(deployment, authArtifactJson, [padded(8_193)]),
    ).resolves.toEqual({
      isVerified: false,
      stoppedAt: {
        limit: "argumentLength",
        candidatesExamined: 0,
        encodedFields: 0,
      },
    });
  });

  test.each<[string, AbiType, string]>([
    [
      "a string longer than the argument cap",
      { kind: "string", length: CONSTRUCTOR_ARGS_MAX + 1 },
      "a",
    ],
    [
      "an integer wider than a field",
      { kind: "integer", sign: "unsigned", width: 255 },
      "1",
    ],
    [
      "a bounded vector of addresses declared without fields",
      {
        kind: "struct",
        path: "std::collections::bounded_vec::BoundedVec",
        fields: [
          {
            name: "storage",
            type: {
              kind: "array",
              length: CONSTRUCTOR_ARGS_MAX,
              type: {
                kind: "struct",
                path: "aztec::protocol_types::address::aztec_address::AztecAddress",
                fields: [],
              },
            },
          },
          {
            name: "len",
            type: { kind: "integer", sign: "unsigned", width: 32 },
          },
        ],
      },
      "1",
    ],
  ])(
    "does not try a function whose parameters exceed the encoding bounds (%s)",
    async (_, type, arg) => {
      const artifact = copy(authArtifactJson);
      const setAuthorized = artifact.functions.find(
        (fn) => fn.name === "set_authorized",
      );
      if (!setAuthorized) {
        throw new Error("Auth has no set_authorized function");
      }
      setAuthorized.abi.parameters[0].type = type;
      const deployment = await deploy(artifact, [arg], "set_authorized");

      await expect(verify(deployment, artifact, [arg])).resolves.toEqual({
        isVerified: false,
      });
    },
  );

  // The marker moves to a one-parameter function listed before the true
  // initializer, so the deployment matches on the second candidate.
  test.each<
    [
      string,
      string,
      AbiType | undefined,
      { candidates: number; encodedFields: number },
      { limit: string; candidatesExamined: number; encodedFields: number },
    ]
  >([
    [
      "a candidate limit",
      "set_authorized",
      undefined,
      { candidates: 1, encodedFields: 65_536 },
      { limit: "candidates", candidatesExamined: 1, encodedFields: 1 },
    ],
    [
      "an encoded field limit",
      "set_authorized",
      undefined,
      { candidates: 256, encodedFields: 1 },
      { limit: "encodedFields", candidatesExamined: 2, encodedFields: 1 },
    ],
    [
      "an encoded field limit after a negative declared length",
      "set_authorized_delay",
      { kind: "string", length: -1 },
      { candidates: 256, encodedFields: 0 },
      { limit: "encodedFields", candidatesExamined: 2, encodedFields: 0 },
    ],
  ])(
    "stops the initializer search at %s",
    async (_, marked, markedParameterType, limits, stoppedAt) => {
      const deployment = await deploy(authArtifactJson, [admin]);
      const stored = withInitializerMarker(authArtifactJson, [marked]);
      const markedFunction = stored.functions.find((fn) => fn.name === marked);
      if (!markedFunction) {
        throw new Error(`Auth has no ${marked} function`);
      }
      if (markedParameterType) {
        markedFunction.abi.parameters[0].type = markedParameterType;
      }

      await expect(
        verify(deployment, stored, [admin], limits),
      ).resolves.toEqual({ isVerified: false, stoppedAt });
      await expect(verify(deployment, stored, [admin])).resolves.toEqual({
        isVerified: true,
        initializer: "constructor",
      });
    },
  );

  test("rejects the current class id when it differs from the original class id", async () => {
    const deployment = await deploy(publicChecksArtifactJson, []);

    await expect(
      verify(
        { ...deployment, contractClassId: Fr.ZERO.toString() },
        publicChecksArtifactJson,
        [],
      ),
    ).resolves.toEqual({ isVerified: false });
  });
});
