import { L2Block } from "@aztec-labs/aztec.js/block";
import { ContractClassPublishedEvent } from "@aztec-labs/protocol-contracts/class-registry";
import {
  ContractInstancePublishedEvent,
  ContractInstanceUpdatedEvent,
} from "@aztec-labs/protocol-contracts/instance-registry";
import {
  chicmozL2ContractClassRegisteredEventSchema,
  chicmozL2ContractInstanceDeployedEventSchema,
  ChicmozL2ContractInstanceUpdatedEvent,
  chicmozL2ContractInstanceUpdatedEventSchema,
  type ChicmozL2ContractClassRegisteredEvent,
  type ChicmozL2ContractInstanceDeployedEvent,
} from "@chicmoz-pkg/types";
import { z } from "zod";
import { logger } from "../../../logger.js";
import { type BlockContracts } from "../../../svcs/database/controllers/l2contract/store.js";

const AZTEC_CONTRACT_CLASS_VERSION = 1;

const toLegacyConcatPoint = (value: { toString: () => string }) => {
  const hex = value.toString();
  return hex.length === 66 ? `0x${hex.slice(2)}${"0".repeat(64)}` : hex;
};

const parseObjs = <ParsedType, AztecType>(
  blockHash: string,
  objs: AztecType[],
  parseFn: (obj: AztecType, blockHash?: string) => ParsedType,
) => {
  const parsedObjs: ParsedType[] = [];
  for (const obj of objs) {
    try {
      const parsed = parseFn(obj, blockHash);
      parsedObjs.push(parsed);
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      logger.error(`Failed to parse object: ${e}`);
      logger.error((e as Error).stack);
    }
  }
  return parsedObjs;
};

// NOTE: reference for parsing in aztec-packages: yarn-project/archiver/src/archiver/archiver.ts
export const parseBlockContracts = async (
  b: L2Block,
  blockHash: string,
): Promise<BlockContracts> => {
  const privateLogs = b.body.txEffects.flatMap(
    (txEffect) => txEffect.privateLogs,
  );

  const publicLogs = b.body.txEffects.flatMap(
    (txEffect) => txEffect.publicLogs,
  );

  // TODO: link contract instances & contract classes to blocks & txs: https://github.com/aztlan-labs/chicmoz/issues/285

  const contractInstanceDeployed = privateLogs
    .filter((log) =>
      ContractInstancePublishedEvent.isContractInstancePublishedEvent(log),
    )
    .map((log) => ContractInstancePublishedEvent.fromLog(log))
    .map((e) => e.toContractInstance());

  const contractInstanceUpdated = publicLogs
    .filter((log) =>
      ContractInstanceUpdatedEvent.isContractInstanceUpdatedEvent(log),
    )
    .map((log) => ContractInstanceUpdatedEvent.fromLog(log))
    .map((e) => e.toContractInstanceUpdate());

  const contractClassLogs = b.body.txEffects
    .flatMap((txEffect) => (txEffect ? [txEffect.contractClassLogs] : []))
    .flat();

  const contractClassRegisteredEvents = contractClassLogs
    .filter((log) =>
      ContractClassPublishedEvent.isContractClassPublishedEvent(log),
    )
    .map((log) => ContractClassPublishedEvent.fromLog(log));

  const contractClasses = await Promise.all(
    contractClassRegisteredEvents.map((e) => e.toContractClassPublic()),
  );

  if (contractClasses.length > 0) {
    logger.info(
      `📜 Parsing and storing ${contractClasses.length} contract classes`,
    );
  }
  if (contractInstanceDeployed.length > 0) {
    logger.info(
      `📖 Parsing and storing ${contractInstanceDeployed.length} contract instances deployed`,
    );
  }
  if (contractInstanceUpdated.length > 0) {
    logger.info(
      `⬆️ Parsing and storing ${contractInstanceUpdated.length} contract instances updated`,
    );
  }

  const contractClassesWithId = contractClasses.map((contractClass) => {
    return {
      ...contractClass,
      contractClassId: contractClass.id,
    };
  });

  const parsedContractClasses: ChicmozL2ContractClassRegisteredEvent[] =
    parseObjs(blockHash, contractClassesWithId, (contractClass, blockHash) =>
      chicmozL2ContractClassRegisteredEventSchema.parse({
        ...contractClass,
        blockHash,
        contractClassId: contractClass.contractClassId.toString(),
        artifactHash: contractClass.artifactHash.toString(),
        privateFunctionsRoot: contractClass.privateFunctionsRoot.toString(),
      } as ChicmozL2ContractClassRegisteredEvent),
    );
  const parsedContractInstancesDeployed: ChicmozL2ContractInstanceDeployedEvent[] =
    parseObjs(
      blockHash,
      contractInstanceDeployed,
      (contractInstance, blockHash) =>
        chicmozL2ContractInstanceDeployedEventSchema.parse({
          ...contractInstance,
          blockHash,
          // Aztec v5 separates contract-instance version from contract-class
          // version. This DB column is used to join against the contract class
          // table, whose protocol version is currently fixed at 1.
          version: AZTEC_CONTRACT_CLASS_VERSION,
          address: contractInstance.address.toString(),
          salt: contractInstance.salt.toString(),
          currentContractClassId:
            contractInstance.currentContractClassId.toString(),
          originalContractClassId:
            contractInstance.originalContractClassId.toString(),
          initializationHash: contractInstance.initializationHash.toString(),
          immutablesHash: contractInstance.immutablesHash.toString(),
          deployer: contractInstance.deployer.toString(),
          publicKeys: {
            masterNullifierPublicKey:
              toLegacyConcatPoint(contractInstance.publicKeys.npkMHash),
            masterIncomingViewingPublicKey:
              contractInstance.publicKeys.ivpkM.toString(),
            masterOutgoingViewingPublicKey:
              toLegacyConcatPoint(contractInstance.publicKeys.ovpkMHash),
            masterTaggingPublicKey:
              toLegacyConcatPoint(contractInstance.publicKeys.tpkMHash),
          },
        } as ChicmozL2ContractInstanceDeployedEvent),
    );
  const parsedContractInstanceUpdate: ChicmozL2ContractInstanceUpdatedEvent[] =
    parseObjs(blockHash, contractInstanceUpdated, (contractInstance) =>
      chicmozL2ContractInstanceUpdatedEventSchema.parse({
        ...contractInstance,
        timestampOfChange: z.number().parse(contractInstance.timestampOfChange),
        blockHash,
        address: contractInstance.address.toString(),
        prevContractClassId: contractInstance.prevContractClassId.toString(),
        newContractClassId: contractInstance.newContractClassId.toString(),
      } as ChicmozL2ContractInstanceUpdatedEvent),
    );
  return {
    classes: parsedContractClasses,
    instancesDeployed: parsedContractInstancesDeployed,
    instancesUpdated: parsedContractInstanceUpdate,
  };
};
