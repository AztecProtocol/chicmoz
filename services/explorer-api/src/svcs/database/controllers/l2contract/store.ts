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
  type HexString,
} from "@chicmoz-pkg/types";
import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { type PgColumn } from "drizzle-orm/pg-core";
import {
  l2ContractClassRegistered,
  l2ContractInstanceDeployed,
  l2ContractInstanceUpdate,
  l2ContractInstanceVerifiedDeploymentArguments,
  l2PrivateFunction,
  l2UtilityFunction,
} from "../../../database/schema/l2contract/index.js";
import { l2TxPublicCallRequest } from "../../../database/schema/l2public-call/index.js";
import { l2Block } from "../../schema/index.js";
import {
  buildSelectorMap,
  selectorMapValueToFunctionName,
} from "../../../../utils/resolve-artifact-names.js";
import { logger } from "../../../../logger.js";
import { type DbTx } from "../utils.js";

/**
 * A contract row's rule on a key conflict: it moves to `incoming` from a
 * block off the chain, and its own block writes it again; another canonical
 * block keeps it.
 */
const movesTo = (
  executor: ReturnType<typeof db>,
  owner: PgColumn,
  incoming: HexString,
): SQL =>
  sql`${eq(owner, incoming)} OR ${exists(
    executor
      .select({ one: sql`1` })
      .from(l2Block)
      .where(and(eq(l2Block.hash, owner), isNotNull(l2Block.orphan_timestamp))),
  )}`;

/**
 * Stores a deployment, or moves it as `movesTo` allows. Only its block
 * changes: the arguments verified for the address, and its deployer metadata,
 * stay. False when another canonical block keeps it.
 */
export const storeContractInstanceDeployed = async (
  instance: ChicmozL2ContractInstanceDeployedEvent,
  executor: ReturnType<typeof db> = db(),
): Promise<boolean> => {
  const { publicKeys, ...rest } = instance;
  const stored = await executor
    .insert(l2ContractInstanceDeployed)
    .values({ ...publicKeys, ...rest })
    .onConflictDoUpdate({
      target: l2ContractInstanceDeployed.address,
      set: { blockHash: rest.blockHash },
      setWhere: movesTo(
        executor,
        l2ContractInstanceDeployed.blockHash,
        rest.blockHash,
      ),
    })
    .returning({ address: l2ContractInstanceDeployed.address });
  return stored.length > 0;
};

/**
 * Stores an update, or moves it with its new block's values as `movesTo`
 * allows. False when another canonical block keeps it.
 */
export const storeContractInstanceUpdated = async (
  instance: ChicmozL2ContractInstanceUpdatedEvent,
  executor: ReturnType<typeof db> = db(),
): Promise<boolean> => {
  const {
    blockHash,
    prevContractClassId,
    newContractClassId,
    timestampOfChange,
  } = instance;
  const stored = await executor
    .insert(l2ContractInstanceUpdate)
    .values({ ...instance })
    .onConflictDoUpdate({
      target: l2ContractInstanceUpdate.address,
      set: {
        blockHash,
        prevContractClassId,
        newContractClassId,
        timestampOfChange,
      },
      setWhere: movesTo(
        executor,
        l2ContractInstanceUpdate.blockHash,
        blockHash,
      ),
    })
    .returning({ address: l2ContractInstanceUpdate.address });
  return stored.length > 0;
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

/**
 * Stores a class, or moves it as `movesTo` allows. Only its block changes:
 * the artifact and source verified for the class stay. False when another
 * canonical block keeps it.
 */
export const storeContractClass = async (
  contractClass: ChicmozL2ContractClassRegisteredEvent,
  executor: ReturnType<typeof db> = db(),
): Promise<boolean> => {
  const stored = await executor
    .insert(l2ContractClassRegistered)
    .values({ ...contractClass })
    .onConflictDoUpdate({
      target: [
        l2ContractClassRegistered.contractClassId,
        l2ContractClassRegistered.version,
      ],
      set: { blockHash: contractClass.blockHash },
      setWhere: movesTo(
        executor,
        l2ContractClassRegistered.blockHash,
        contractClass.blockHash,
      ),
    })
    .returning({ contractClassId: l2ContractClassRegistered.contractClassId });
  return stored.length > 0;
};

export type BlockContracts = {
  classes: ChicmozL2ContractClassRegisteredEvent[];
  instancesDeployed: ChicmozL2ContractInstanceDeployedEvent[];
  instancesUpdated: ChicmozL2ContractInstanceUpdatedEvent[];
};

/**
 * Stores a canonical block's contract rows, each in a savepoint: a row that
 * fails is logged and skipped, and a failed heartbeat aborts the block.
 */
export const storeBlockContracts = async (
  dbTx: DbTx,
  { classes, instancesDeployed, instancesUpdated }: BlockContracts,
  heartbeat: Heartbeat,
): Promise<void> => {
  const each = async <T>(
    rows: T[],
    label: (row: T) => string,
    write: (row: T, executor: DbTx) => Promise<boolean>,
  ) => {
    for (const row of rows) {
      await heartbeat();
      try {
        if (!(await dbTx.transaction((savepoint) => write(row, savepoint)))) {
          logger.warn(
            `${label(row)} stays with the canonical block that holds it`,
          );
        }
      } catch (e) {
        logger.error(
          `Failed to store ${label(row)}: ${(e as Error).stack ?? String(e)}`,
        );
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
