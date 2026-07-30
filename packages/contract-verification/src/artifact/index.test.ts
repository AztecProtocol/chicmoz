import { getContractClassFromArtifact } from "@aztec/aztec.js/contracts";
import { loadContractArtifact } from "@aztec/aztec.js/abi";
import publicChecksArtifactJson from "@aztec/noir-contracts.js/artifacts/public_checks_contract-PublicChecks" with { type: "json" };
import { ChicmozL2ContractClassRegisteredEvent } from "@chicmoz-pkg/types";
import { describe, expect, test } from "vitest";
import { generateVerifyArtifactPayload, verifyArtifactPayload } from "./index.js";

describe("v5 artifact verification", () => {
  test("verifies an official Aztec v5 artifact", async () => {
    const contractClass = await getContractClassFromArtifact(
      loadContractArtifact(publicChecksArtifactJson),
    );
    const storedClass = {
      packedBytecode: contractClass.packedBytecode,
    } as ChicmozL2ContractClassRegisteredEvent;

    const result = await verifyArtifactPayload(
      generateVerifyArtifactPayload(publicChecksArtifactJson),
      storedClass,
    );

    expect(result).toEqual({
      isMatchingByteCode: true,
      artifactContractName: publicChecksArtifactJson.name,
    });
  });

  test("rejects a different packed bytecode", async () => {
    const result = await verifyArtifactPayload(
      generateVerifyArtifactPayload(publicChecksArtifactJson),
      { packedBytecode: Buffer.from([0]) } as ChicmozL2ContractClassRegisteredEvent,
    );

    expect(result.isMatchingByteCode).toBe(false);
  });
});
