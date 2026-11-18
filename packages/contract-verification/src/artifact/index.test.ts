import {
  loadContractArtifact,
  type NoirCompiledContract,
} from "@aztec-labs/aztec.js/abi";
import { getContractClassFromArtifact } from "@aztec-labs/aztec.js/contracts";
import escrowArtifactJson from "@aztec-labs/noir-contracts.js/artifacts/escrow_contract-Escrow" with { type: "json" };
import publicChecksArtifactJson from "@aztec-labs/noir-contracts.js/artifacts/public_checks_contract-PublicChecks" with { type: "json" };
import { type ChicmozL2ContractClassRegisteredEvent } from "@chicmoz-pkg/types";
import { describe, expect, test } from "vitest";
import {
  generateVerifyArtifactPayload,
  verifyArtifactPayload,
} from "./index.js";

const copy = (json: unknown) => structuredClone(json) as NoirCompiledContract;

const functionNamed = (artifact: NoirCompiledContract, name: string) => {
  const fn = artifact.functions.find((f) => f.name === name);
  if (!fn) {
    throw new Error(`${artifact.name} has no function ${name}`);
  }
  return fn;
};

// The registered class as the block listener stores it.
const registeredClassOf = async (artifact: NoirCompiledContract) => {
  const contractClass = await getContractClassFromArtifact(
    loadContractArtifact(artifact),
  );
  return {
    contractClassId: contractClass.id.toString(),
    version: contractClass.version,
    artifactHash: contractClass.artifactHash.toString(),
    privateFunctionsRoot: contractClass.privateFunctionsRoot.toString(),
    packedBytecode: contractClass.packedBytecode,
  } as ChicmozL2ContractClassRegisteredEvent;
};

// Each changes exactly one input of the class id: the private functions
// root, the artifact hash, the public bytecode commitment.
const otherClassIdCases: Array<
  [string, () => { original: unknown; upload: NoirCompiledContract }]
> = [
  [
    "another private function's verification key",
    () => {
      const upload = copy(escrowArtifactJson);
      functionNamed(upload, "constructor").verification_key = functionNamed(
        upload,
        "withdraw",
      ).verification_key;
      return { original: escrowArtifactJson, upload };
    },
  ],
  [
    "another contract name",
    () => {
      const upload = copy(publicChecksArtifactJson);
      upload.name = `${upload.name}Renamed`;
      return { original: publicChecksArtifactJson, upload };
    },
  ],
  [
    "other public bytecode",
    () => {
      const upload = copy(publicChecksArtifactJson);
      const dispatch = functionNamed(upload, "public_dispatch");
      const bytecode = Buffer.from(dispatch.bytecode, "base64");
      bytecode[bytecode.length - 1] ^= 1;
      dispatch.bytecode = bytecode.toString("base64");
      return { original: publicChecksArtifactJson, upload };
    },
  ],
];

// Each keeps the class id: the class id is compared first.
const functionListCases: Array<
  [string, () => { original: unknown; upload: NoirCompiledContract }]
> = [
  [
    "another public function name",
    () => {
      const upload = copy(publicChecksArtifactJson);
      functionNamed(upload, "check_timestamp").name = "check_time";
      return { original: publicChecksArtifactJson, upload };
    },
  ],
  [
    "another parameter label",
    () => {
      const upload = copy(escrowArtifactJson);
      const recipient = functionNamed(upload, "withdraw").abi.parameters.find(
        (param) => param.name === "recipient",
      );
      if (!recipient) {
        throw new Error("Escrow withdraw has no recipient parameter");
      }
      recipient.name = "to";
      return { original: escrowArtifactJson, upload };
    },
  ],
  [
    "another parameter type of a public function",
    () => {
      const upload = copy(publicChecksArtifactJson);
      functionNamed(upload, "check_block_number").abi.parameters[1].type = {
        kind: "field",
      };
      return { original: publicChecksArtifactJson, upload };
    },
  ],
  [
    "a function removed from the list",
    () => {
      const upload = copy(publicChecksArtifactJson);
      upload.functions = upload.functions.filter(
        (fn) => fn.name !== "check_timestamp",
      );
      return { original: publicChecksArtifactJson, upload };
    },
  ],
  [
    "a function added to the list",
    () => {
      const upload = copy(publicChecksArtifactJson);
      upload.functions.push({
        ...functionNamed(upload, "check_timestamp"),
        name: "check_timestamp_again",
      });
      return { original: publicChecksArtifactJson, upload };
    },
  ],
  [
    "a function renamed to a compiler-added name",
    () => {
      const upload = copy(publicChecksArtifactJson);
      functionNamed(upload, "check_block_number").name =
        "__emit_public_init_nullifier";
      return { original: publicChecksArtifactJson, upload };
    },
  ],
];

const notCompilerOutputCases: Array<
  [string, (registered: ChicmozL2ContractClassRegisteredEvent) => string]
> = [
  [
    "an artifact loaded by the SDK",
    () => JSON.stringify(loadContractArtifact(copy(publicChecksArtifactJson))),
  ],
  [
    "precomputed hash fields",
    (registered) =>
      JSON.stringify({
        ...copy(publicChecksArtifactJson),
        artifactHash: registered.artifactHash,
      }),
  ],
  [
    "a function carrying functionType",
    () => {
      const upload = copy(publicChecksArtifactJson);
      const fn = functionNamed(upload, "check_timestamp");
      fn.custom_attributes = ["abi_private"];
      fn.abi.return_type = {
        abi_type: { kind: "boolean" },
        visibility: "public",
      };
      return JSON.stringify({
        ...upload,
        functions: upload.functions.map((f) =>
          f === fn ? { ...f, functionType: "public" } : f,
        ),
      });
    },
  ],
  ["a JSON value that is not an object", () => "null"],
];

describe("artifact verification", () => {
  test("accepts raw compiler output whose class id matches the registered class", async () => {
    const registered = await registeredClassOf(copy(publicChecksArtifactJson));

    const result = await verifyArtifactPayload(
      generateVerifyArtifactPayload(copy(publicChecksArtifactJson)),
      registered,
    );

    expect(result).toEqual({
      isMatchingClassId: true,
      artifactContractName: publicChecksArtifactJson.name,
      artifactJson: JSON.stringify(publicChecksArtifactJson),
    });
  });

  test.each(otherClassIdCases)(
    "refuses an artifact whose class id differs from the registered class (%s)",
    async (_, build) => {
      const { original, upload } = build();
      const registered = await registeredClassOf(copy(original));

      const result = await verifyArtifactPayload(
        generateVerifyArtifactPayload(upload),
        registered,
      );

      expect(result).toEqual({
        isMatchingClassId: false,
        reason: "CLASS_ID_MISMATCH",
      });
    },
  );

  test.each(functionListCases)(
    "refuses an artifact whose function list differs from its outputs (%s)",
    async (_, build) => {
      const { original, upload } = build();
      const registered = await registeredClassOf(copy(original));

      const result = await verifyArtifactPayload(
        generateVerifyArtifactPayload(upload),
        registered,
      );

      expect(result).toEqual({
        isMatchingClassId: false,
        reason: "FUNCTION_LIST_MISMATCH",
      });
    },
  );

  test.each(notCompilerOutputCases)(
    "refuses an artifact that is not raw compiler output (%s)",
    async (_, build) => {
      const registered = await registeredClassOf(copy(publicChecksArtifactJson));

      const result = await verifyArtifactPayload(
        { stringifiedArtifactJson: build(registered) },
        registered,
      );

      expect(result).toEqual({
        isMatchingClassId: false,
        reason: "NOT_COMPILER_OUTPUT",
      });
    },
  );
});
