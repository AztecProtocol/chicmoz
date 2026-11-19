import { loadContractArtifact } from "@aztec-labs/aztec.js/abi";
import ecdsaKAccountArtifactJson from "@aztec-labs/noir-contracts.js/artifacts/ecdsa_k_account_contract-EcdsaKAccount" with { type: "json" };
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ARTIFACT_REFUSED_MESSAGE,
  checkArtifactShape,
  loadArtifactJson,
  loadStoredArtifactJson,
} from "./load-artifact.js";

const bundledArtifactsDir = dirname(
  createRequire(import.meta.url).resolve(
    "@aztec-labs/noir-contracts.js/artifacts/token_contract-Token",
  ),
);

const withNodes = (count: number) => new Array<number>(count - 1).fill(0);

const withDepth = (depth: number) => {
  let value: unknown = [];
  for (let level = 1; level < depth; level++) {
    value = [value];
  }
  return value;
};

const withKeyLength = (length: number) => ({ ["k".repeat(length)]: 0 });

const refusal = new Error(ARTIFACT_REFUSED_MESSAGE);

describe("artifact limits", () => {
  test("every bundled noir-contracts.js artifact is within the limits and loads", () => {
    const files = readdirSync(bundledArtifactsDir).filter((file) =>
      file.endsWith(".json"),
    );
    expect(files.length).toBeGreaterThan(0);

    const refused = files.filter((file) => {
      try {
        loadArtifactJson(readFileSync(join(bundledArtifactsDir, file), "utf8"));
        return false;
      } catch {
        return true;
      }
    });

    expect(refused).toEqual([]);
  });

  // The approved ceilings are written out, so a raised limit fails here.
  test.each([
    ["node count", withNodes(120_000), withNodes(120_001)],
    ["depth", withDepth(64), withDepth(65)],
    ["key length", withKeyLength(128), withKeyLength(129)],
  ])(
    "accepts JSON at the %s limit and refuses it one over",
    (_, atLimit, overLimit) => {
      expect(() => checkArtifactShape(atLimit)).not.toThrow();
      expect(() => checkArtifactShape(overLimit)).toThrow(refusal);
    },
  );

  test("loads stored JSON that is over the limits and refuses it as an upload", () => {
    // Serialized again after the SDK loaded it, bytecode is arrays of numbers.
    const stored = JSON.stringify(
      loadContractArtifact(ecdsaKAccountArtifactJson),
    );

    expect(loadStoredArtifactJson(stored).name).toBe("EcdsaKAccount");
    expect(() => checkArtifactShape(JSON.parse(stored))).toThrow(refusal);
    expect(() => loadArtifactJson(stored)).toThrow(refusal);
  });

  test.each([
    ["text that is not JSON", "{"],
    ["JSON the SDK cannot load", "{}"],
  ])("refuses %s with the same message", (_, json) => {
    expect(() => loadArtifactJson(json)).toThrow(refusal);
  });
});
