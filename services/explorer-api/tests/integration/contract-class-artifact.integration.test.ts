import { loadContractArtifact } from "@aztec-labs/aztec.js/abi";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  classPath,
  rawArtifact,
  readClassRow,
  seedClass,
} from "./support/contracts.js";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";

describe("contract class artifact uploads", () => {
  let api: ExplorerApiForTest;

  beforeAll(async () => {
    api = await startExplorerApiForTest();
  });

  afterAll(async () => {
    await api?.close();
  });

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
});
