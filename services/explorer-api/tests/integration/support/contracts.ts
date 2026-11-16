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
import { type ContractStandard } from "@chicmoz-pkg/types";
import { and, eq } from "drizzle-orm";
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

/** Same class id, other text: the compiler's file map is not part of the id. */
export const variant = (
  artifact: NoirCompiledContract,
): NoirCompiledContract => ({ ...structuredClone(artifact), file_map: {} });

/** Stores an artifact straight into Postgres, as an earlier upload left it; the cache stays cold. */
export const seedStoredArtifact = async (
  seeded: SeededClass,
  artifact: NoirCompiledContract,
  standardData?: ContractStandard,
) => {
  const { controllers } = await import("../../../src/svcs/database/index.js");
  await controllers.l2Contract.addArtifactData({
    ...seeded,
    artifactJson: JSON.stringify(artifact),
    contractName: artifact.name,
    standardData,
  });
};

// The block listener's encoding of the 32-byte key hashes (on-block/contracts.ts).
const toLegacyConcatPoint = (value: { toString: () => string }) => {
  const hex = value.toString();
  return hex.length === 66 ? `0x${hex.slice(2)}${"0".repeat(64)}` : hex;
};

/**
 * Registers an instance of an initializerless artifact as the block listener
 * does, and returns the arguments that verify its deployment. `atAddress`
 * stores the row under another address, which those arguments do not lead to.
 */
export const seedInstance = async (
  artifact: NoirCompiledContract,
  { atAddress }: { atAddress?: string } = {},
) => {
  const instance = await getContractInstanceFromInstantiationParams(
    loadContractArtifact(artifact),
    { constructorArgs: [], deployer: AztecAddress.ZERO, salt: Fr.random() },
  );
  const address = atAddress ?? instance.address.toString();
  const { controllers } = await import("../../../src/svcs/database/index.js");
  await controllers.l2Contract.storeContractInstanceDeployed({
    address,
    blockHash: await seedBlock(),
    version: 1,
    salt: instance.salt.toString(),
    currentContractClassId: instance.currentContractClassId.toString(),
    originalContractClassId: instance.originalContractClassId.toString(),
    initializationHash: instance.initializationHash.toString(),
    immutablesHash: instance.immutablesHash.toString(),
    deployer: instance.deployer.toString(),
    publicKeys: {
      masterNullifierPublicKey: toLegacyConcatPoint(instance.publicKeys.npkMHash),
      masterIncomingViewingPublicKey: instance.publicKeys.ivpkM.toString(),
      masterOutgoingViewingPublicKey: toLegacyConcatPoint(instance.publicKeys.ovpkMHash),
      masterTaggingPublicKey: toLegacyConcatPoint(instance.publicKeys.tpkMHash),
    },
  });
  return {
    address,
    deploymentArguments: {
      publicKeysString: instance.publicKeys.toString(),
      salt: instance.salt.toString(),
      deployer: instance.deployer.toString(),
      constructorArgs: [] as string[],
    },
  };
};

/** Another valid address no seeded row has. */
export const unusedAddress = async (artifact: NoirCompiledContract) =>
  (
    await getContractInstanceFromInstantiationParams(
      loadContractArtifact(artifact),
      { constructorArgs: [], deployer: AztecAddress.ZERO, salt: Fr.random() },
    )
  ).address.toString();

export const readDeploymentArguments = async (address: string) => {
  const { getDb } = await import("@chicmoz-pkg/postgres-helper");
  const { l2ContractInstanceVerifiedDeploymentArguments: t } = await import(
    "../../../src/svcs/database/schema/l2contract/index.js"
  );
  const rows = await getDb().select().from(t).where(eq(t.address, address));
  return rows[0];
};

export const instancePath = (address: string) =>
  `/l2/contract-instances/${address}`;

export const classPath = ({ contractClassId, version }: SeededClass) =>
  `/l2/contract-classes/${contractClassId}/versions/${version}`;
