import { type Heartbeat } from "@chicmoz-pkg/message-bus";
import { getDb as db } from "@chicmoz-pkg/postgres-helper";
import {
  ChicmozL2ContractInstanceUpdatedEvent,
  ContractStandard,
  type ChicmozL2ContractClassRegisteredEvent,
  type ChicmozL2ContractInstanceDeployedEvent,
  type ChicmozL2ContractInstanceVerifiedDeploymentArgumnetsSchema,
  type ChicmozL2PrivateFunctionBroadcastedEvent,
  type ChicmozL2UtilityFunctionBroadcastedEvent,
} from "@chicmoz-pkg/types";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  l2ContractClassRegistered,
  l2ContractInstanceDeployed,
  l2ContractInstanceUpdate,
  l2ContractInstanceVerifiedDeploymentArguments,
  l2PrivateFunction,
  l2UtilityFunction,
} from "../../../database/schema/l2contract/index.js";
import { l2TxPublicCallRequest } from "../../../database/schema/l2public-call/index.js";
import {
  buildSelectorMap,
  selectorMapValueToFunctionName,
} from "../../../../utils/resolve-artifact-names.js";
import { logger } from "../../../../logger.js";
import { type DbTx } from "../utils.js";

export const storeContractInstanceDeployed = async (
  instance: ChicmozL2ContractInstanceDeployedEvent,
  executor: ReturnType<typeof db> = db(),
): Promise<void> => {
  const { publicKeys, ...rest } = instance;
  await executor
    .insert(l2ContractInstanceDeployed)
    .values({ ...publicKeys, ...rest });
};

export const storeContractInstanceUpdated = async (
  instance: ChicmozL2ContractInstanceUpdatedEvent,
  executor: ReturnType<typeof db> = db(),
): Promise<void> => {
  await executor.insert(l2ContractInstanceUpdate).values({ ...instance });
};

export const storeContractInstanceVerifiedDeploymentArguments = async (
  verifiedDeploymentArguments: ChicmozL2ContractInstanceVerifiedDeploymentArgumnetsSchema,
): Promise<void> => {
  await db()
    .insert(l2ContractInstanceVerifiedDeploymentArguments)
    .values({ ...verifiedDeploymentArguments })
    .onConflictDoUpdate({
      target: l2ContractInstanceVerifiedDeploymentArguments.address,
      set: {
        salt: verifiedDeploymentArguments.salt,
        deployer: verifiedDeploymentArguments.deployer,
        publicKeysString: verifiedDeploymentArguments.publicKeysString,
        constructorArgs: verifiedDeploymentArguments.constructorArgs,
      },
    });
};

export const storeContractClass = async (
  contractClass: ChicmozL2ContractClassRegisteredEvent,
  executor: ReturnType<typeof db> = db(),
): Promise<void> => {
  await executor.insert(l2ContractClassRegistered).values({
    ...contractClass,
  });
};

export type BlockContracts = {
  classes: ChicmozL2ContractClassRegisteredEvent[];
  instancesDeployed: ChicmozL2ContractInstanceDeployedEvent[];
  instancesUpdated: ChicmozL2ContractInstanceUpdatedEvent[];
};

/**
 * Stores a block's contract rows inside its transaction, each in a savepoint:
 * a row that fails (a duplicate, or an instance whose class was never
 * stored) is logged and skipped without aborting the block; a failed
 * heartbeat, taken before each row, aborts it.
 */
export const storeBlockContracts = async (
  dbTx: DbTx,
  { classes, instancesDeployed, instancesUpdated }: BlockContracts,
  heartbeat: Heartbeat,
): Promise<void> => {
  const each = async <T>(
    rows: T[],
    label: (row: T) => string,
    write: (row: T, executor: DbTx) => Promise<void>,
  ) => {
    for (const row of rows) {
      await heartbeat();
      try {
        await dbTx.transaction((savepoint) => write(row, savepoint));
      } catch (e) {
        if ((e as { code?: string }).code === "23505") {
          logger.warn(`DB Duplicate: ${label(row)}`);
        } else {
          logger.error(
            `Failed to store ${label(row)}: ${(e as Error).stack ?? String(e)}`,
          );
        }
      }
    }
  };
  await each(
    classes,
    (c) => `contractClass ${c.contractClassId}`,
    storeContractClass,
  );
  await each(
    instancesDeployed,
    (i) => `contractInstanceDeployed ${i.address}`,
    storeContractInstanceDeployed,
  );
  await each(
    instancesUpdated,
    (i) => `contractInstanceUpdated ${i.address}`,
    storeContractInstanceUpdated,
  );
};

export const addArtifactData = async ({
  contractClassId,
  version,
  artifactJson,
  contractName,
  standardData,
}: {
  contractClassId: string;
  version: number;
  artifactJson: string;
  contractName?: string;
  standardData?: ContractStandard;
}): Promise<{ written: boolean; selectorMap: Record<string, string> }> => {
  const selectorMap = await buildSelectorMap(artifactJson);

  // Only the first artifact is kept; callers re-read the row when nothing
  // was written.
  const written = await db()
    .update(l2ContractClassRegistered)
    .set({
      artifactJson,
      artifactContractName: contractName ?? null,
      selectorMap,
      standardContractType: standardData?.name ?? null,
      standardContractVersion: standardData?.version ?? null,
    })
    .where(
      and(
        eq(l2ContractClassRegistered.contractClassId, contractClassId),
        eq(l2ContractClassRegistered.version, version),
        isNull(l2ContractClassRegistered.artifactJson),
      ),
    )
    .returning({ contractClassId: l2ContractClassRegistered.contractClassId });

  return { written: written.length > 0, selectorMap };
};

export const storePrivateFunction = async (
  privateFunctionBroadcast: ChicmozL2PrivateFunctionBroadcastedEvent,
): Promise<void> => {
  const { privateFunction, ...rest } = privateFunctionBroadcast;
  await db()
    .insert(l2PrivateFunction)
    .values({
      ...rest,
      privateFunction_selector_value: privateFunction.selector.value,
      privateFunction_metadataHash: privateFunction.metadataHash,
      privateFunction_vkHash: privateFunction.vkHash,
      privateFunction_bytecode: privateFunction.bytecode,
    });
};

export const storeUtilityFunction = async (
  utilityFunctionBroadcast: ChicmozL2UtilityFunctionBroadcastedEvent,
): Promise<void> => {
  const { utilityFunction, ...rest } = utilityFunctionBroadcast;
  await db()
    .insert(l2UtilityFunction)
    .values({
      ...rest,
      utilityFunction_selector_value: utilityFunction.selector.value,
      utilityFunction_metadataHash: utilityFunction.metadataHash,
      utilityFunction_bytecode: utilityFunction.bytecode,
    });
};

/**
 * Backfills contractName and functionName on all tx_public_call_request rows
 * that are associated with instances of the given contract class and are still
 * missing contractName OR functionName. Called after a new artifact is uploaded
 * so that previously indexed call requests get human-readable names retroactively.
 *
 * Uses the pre-built selectorMap (computed by addArtifactData) for O(1) lookups
 * instead of re-parsing the artifact JSON for each row.
 */
export const backfillPublicCallRequestNames = async ({
  contractClassId,
  version,
  selectorMap,
  contractName,
}: {
  contractClassId: string;
  version: number;
  selectorMap: Record<string, string>;
  contractName: string | undefined;
}): Promise<void> => {
  // Find all contract instance addresses belonging to this class
  const instances = await db()
    .select({ address: l2ContractInstanceDeployed.address })
    .from(l2ContractInstanceDeployed)
    .where(
      and(
        eq(l2ContractInstanceDeployed.currentContractClassId, contractClassId),
        eq(l2ContractInstanceDeployed.version, version),
      ),
    );

  if (instances.length === 0) {
    return;
  }

  const instanceAddresses = instances.map((i) => i.address);

  // Fetch rows missing contractName OR functionName, filtered by the relevant contract addresses in SQL
  const candidateRows = await db()
    .select({
      txHash: l2TxPublicCallRequest.txHash,
      calldataHash: l2TxPublicCallRequest.calldataHash,
      contractAddress: l2TxPublicCallRequest.contractAddress,
      functionSelector: l2TxPublicCallRequest.functionSelector,
    })
    .from(l2TxPublicCallRequest)
    .where(
      and(
        inArray(l2TxPublicCallRequest.contractAddress, instanceAddresses),
        or(
          isNull(l2TxPublicCallRequest.contractName),
          isNull(l2TxPublicCallRequest.functionName),
        ),
      ),
    );

  if (candidateRows.length === 0) {
    return;
  }

  // Update each row using the pre-built selectorMap — O(1) per row, no artifact parsing
  await Promise.all(
    candidateRows.map((row) => {
      const selectorEntry = row.functionSelector
        ? selectorMap[row.functionSelector]
        : undefined;
      const functionName =
        selectorEntry !== undefined
          ? selectorMapValueToFunctionName(selectorEntry)
          : null;

      return db()
        .update(l2TxPublicCallRequest)
        .set({ contractName: contractName ?? null, functionName })
        .where(
          and(
            eq(l2TxPublicCallRequest.txHash, row.txHash),
            eq(l2TxPublicCallRequest.calldataHash, row.calldataHash),
          ),
        );
    }),
  );

  logger.info(
    `🔎 Backfilled artifact names for ${candidateRows.length} public call request(s) (classId: ${contractClassId})`,
  );
};
