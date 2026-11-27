import { getDb as db } from "@chicmoz-pkg/postgres-helper";
import { HexString, type PublicCallRequest } from "@chicmoz-pkg/types";
import { and, eq } from "drizzle-orm";
import {
  l2ContractClassRegistered,
  l2ContractInstanceDeployed,
} from "../../schema/l2contract/index.js";
import { l2TxPublicCallRequest } from "../../schema/l2public-call/index.js";
import { logger } from "../../../../logger.js";
import { selectorMapValueToFunctionName } from "../../../../utils/resolve-artifact-names.js";
import { deletePublicCall } from "./delete.js";

/**
 * Resolves contractName and functionName for a single public call request
 * by joining through the contract instance → contract class tables.
 * Uses the pre-built selectorMap (stored at artifact upload time) for O(1)
 * function name lookup — no artifact JSON parsing or selector hashing at runtime.
 * Returns null for both if the contract instance or artifact is not found.
 */
const resolveArtifactNames = async (
  contractAddress: string,
  functionSelector: string | undefined,
  executor: ReturnType<typeof db>,
): Promise<{ contractName: string | null; functionName: string | null }> => {
  const rows = await executor
    .select({
      artifactContractName: l2ContractClassRegistered.artifactContractName,
      selectorMap: l2ContractClassRegistered.selectorMap,
    })
    .from(l2ContractInstanceDeployed)
    .leftJoin(
      l2ContractClassRegistered,
      and(
        eq(
          l2ContractInstanceDeployed.currentContractClassId,
          l2ContractClassRegistered.contractClassId,
        ),
        eq(
          l2ContractInstanceDeployed.version,
          l2ContractClassRegistered.version,
        ),
      ),
    )
    .where(eq(l2ContractInstanceDeployed.address, contractAddress))
    .limit(1);

  if (rows.length === 0 || !rows[0].artifactContractName) {
    return { contractName: null, functionName: null };
  }

  const { artifactContractName, selectorMap } = rows[0];

  const selectorEntry =
    functionSelector && selectorMap ? selectorMap[functionSelector] : undefined;
  const functionName =
    selectorEntry !== undefined
      ? selectorMapValueToFunctionName(selectorEntry)
      : null;

  return { contractName: artifactContractName, functionName };
};

export const storePublicCallRequests = async (
  txHash: HexString,
  publicCallRequests: PublicCallRequest[],
  executor: ReturnType<typeof db> = db(),
): Promise<void> => {
  if (publicCallRequests.length === 0) {
    return;
  }

  await deletePublicCall(txHash, executor);

  const values = await Promise.all(
    publicCallRequests.map(async (request) => {
      const { contractName, functionName } = await resolveArtifactNames(
        request.contractAddress,
        request.functionSelector,
        executor,
      );
      return {
        txHash,
        msgSender: request.msgSender,
        contractAddress: request.contractAddress,
        isStaticCall: request.isStaticCall,
        calldataHash: request.calldataHash,
        callType: request.callType,
        functionSelector: request.functionSelector ?? null,
        contractName,
        functionName,
      };
    }),
  );

  // Two calls with one calldata share the key, and a conflict would abort the
  // caller's transaction with it.
  await executor
    .insert(l2TxPublicCallRequest)
    .values(values)
    .onConflictDoNothing();

  logger.info(
    `📋 Stored ${publicCallRequests.length} public call requests for tx: ${txHash}`,
  );
};
