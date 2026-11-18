import { type NoirCompiledContract } from "@aztec-labs/aztec.js/abi";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { isFunctionListBoundToOutputs } from "./function-list.js";

const packageRequire = createRequire(import.meta.url);

// noir-contracts.js includes Lending, with a compiler-added public function;
// the aztec-standards artifacts (the standard route's) write labels in
// `outputs` with a leading underscore.
const bundledArtifactDirs = [
  "@aztec-labs/noir-contracts.js/artifacts/token_contract-Token",
  "@defi-wonderland/aztec-standards-v410/target/token_contract-Token.json",
  "@defi-wonderland/aztec-standards-v420/target/token_contract-Token.json",
].map((artifact) => dirname(packageRequire.resolve(artifact)));

test("every bundled artifact's function list matches its outputs", () => {
  const files = bundledArtifactDirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => join(dir, file)),
  );
  expect(files.length).toBeGreaterThan(bundledArtifactDirs.length);

  const refused = files.filter(
    (file) =>
      !isFunctionListBoundToOutputs(
        JSON.parse(readFileSync(file, "utf8")) as NoirCompiledContract,
      ),
  );

  expect(refused).toEqual([]);
});
