import {
  loadContractArtifact,
  type NoirCompiledContract,
} from "@aztec-labs/aztec.js/abi";
import { getContractClassFromArtifact } from "@aztec-labs/aztec.js/contracts";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// explorer-api modules read their environment at import, so everything from
// src is imported dynamically, after startExplorerApiForTest().

const require = createRequire(import.meta.url);

/** A fresh copy of a bundled compiler output, e.g. "escrow_contract-Escrow". */
export const rawArtifact = (file: string): NoirCompiledContract =>
  JSON.parse(
    readFileSync(
      require.resolve(`@aztec-labs/noir-contracts.js/artifacts/${file}`),
      "utf8",
    ),
  ) as NoirCompiledContract;

export type SeededClass = { contractClassId: string; version: number };

let nextHeight = 1n;

const seedBlock = async () => {
  const { getDb } = await import("@chicmoz-pkg/postgres-helper");
  const { l2Block } = await import(
    "../../../src/svcs/database/schema/l2block/root.js"
  );
  const hash = `0x${randomBytes(32).toString("hex")}` as const;
  await getDb()
    .insert(l2Block)
    .values({ hash, height: nextHeight++, version: 1 });
  return hash;
};

/** Registers the artifact's class as the block listener does: no artifact. */
export const seedClass = async (
  artifact: NoirCompiledContract,
): Promise<SeededClass> => {
  const contractClass = await getContractClassFromArtifact(
    loadContractArtifact(artifact),
  );
  const { controllers } = await import("../../../src/svcs/database/index.js");
  const seeded = {
    contractClassId: contractClass.id.toString(),
    version: contractClass.version,
  };
  await controllers.l2Contract.storeContractClass({
    ...seeded,
    blockHash: await seedBlock(),
    artifactHash: contractClass.artifactHash.toString(),
    privateFunctionsRoot: contractClass.privateFunctionsRoot.toString(),
    packedBytecode: contractClass.packedBytecode,
  });
  return seeded;
};

/** The class row's upload-dependent columns, read from Postgres. */
export const readClassRow = async ({ contractClassId, version }: SeededClass) => {
  const { getDb } = await import("@chicmoz-pkg/postgres-helper");
  const { and, eq } = await import("drizzle-orm");
  const { l2ContractClassRegistered: t } = await import(
    "../../../src/svcs/database/schema/l2contract/index.js"
  );
  const [row] = await getDb()
    .select({
      artifactJson: t.artifactJson,
      artifactContractName: t.artifactContractName,
      selectorMap: t.selectorMap,
      standardContractType: t.standardContractType,
      standardContractVersion: t.standardContractVersion,
      sourceCode: t.sourceCode,
      sourceCodeUrl: t.sourceCodeUrl,
      sourceCodeCommitHash: t.sourceCodeCommitHash,
    })
    .from(t)
    .where(and(eq(t.contractClassId, contractClassId), eq(t.version, version)));
  if (!row) {
    throw new Error(`no class row for ${contractClassId}@${version}`);
  }
  return row;
};

export const classPath = ({ contractClassId, version }: SeededClass) =>
  `/l2/contract-classes/${contractClassId}/versions/${version}`;
