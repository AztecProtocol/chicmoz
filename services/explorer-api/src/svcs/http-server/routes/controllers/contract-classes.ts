import {
  ARTIFACT_REFUSED_MESSAGE,
  type ArtifactVerification,
  verifyArtifactPayload,
} from "@chicmoz-pkg/contract-verification";
import { NotFoundError } from "@chicmoz-pkg/error-middleware";
import { setEntry } from "@chicmoz-pkg/redis-helper";
import {
  type ChicmozL2ContractClassRegisteredEvent,
  type ContractStandard,
  jsonStringify,
} from "@chicmoz-pkg/types";
import asyncHandler from "express-async-handler";
import { OpenAPIObject } from "openapi3-ts/oas31";
import { CACHE_TTL_SECONDS } from "../../../../environment.js";
import { logger } from "../../../../logger.js";
import {
  getAllProtocolContractClasses,
  getProtocolContractByClassId,
} from "../../../../utils/protocol-contracts.js";
import { controllers as db } from "../../../database/index.js";
import {
  getContractClassesByCurrentClassIdSchema,
  getContractClassesSchema,
  getContractClassSchema,
  postContrctClassArtifactSchema,
} from "../paths_and_validation.js";
import {
  contractClassResponse,
  contractClassResponseArray,
  dbWrapper,
} from "./utils/index.js";
import { NoirCompiledContract } from "@aztec-labs/aztec.js/abi";


const artifactRefusalText = {
  CLASS_ID_MISMATCH: "Incorrect artifact",
  NOT_COMPILER_OUTPUT: "Artifact must be the raw aztec compile output",
} as const;

export const NOT_COMPILER_OUTPUT_TEXT = artifactRefusalText.NOT_COMPILER_OUTPUT;

const badArtifactMessages: string[] = [
  "Missing artifact json",
  ...Object.values(artifactRefusalText),
  ARTIFACT_REFUSED_MESSAGE,
];

/** True for the errors `verifyArtifact` throws for a bad upload (a 400). */
export const isBadArtifactMessage = (message: string) =>
  badArtifactMessages.includes(message);

const contractClassKeys = (
  contractClassId: string,
  version: number,
  includeArtifactJson?: boolean,
) => [
  "l2",
  "contract-classes",
  contractClassId,
  version,
  includeArtifactJson ? "with-artifact" : "without-artifact",
];

export const openapi_GET_L2_REGISTERED_CONTRACT_CLASS: OpenAPIObject["paths"] =
  {
    "/l2/contract-classes/{classId}/versions/{version}": {
      get: {
        tags: ["L2", "contract-classes"],
        summary:
          "Get registered contract class by contract class id and version",
        parameters: [
          {
            name: "classId",
            in: "path",
            required: true,
            schema: {
              type: "string",
            },
          },
          {
            name: "version",
            in: "path",
            required: true,
            schema: {
              type: "string",
            },
          },
          {
            name: "includeArtifactJson",
            in: "query",
            schema: {
              type: "boolean",
            },
          },
        ],
        responses: contractClassResponse,
      },
    },
  };

export const GET_L2_REGISTERED_CONTRACT_CLASS = asyncHandler(
  async (req, res) => {
    const { contractClassId, version } =
      getContractClassSchema.parse(req).params;
    const { includeArtifactJson } = getContractClassSchema.parse(req).query;
    const protocolContractClass = getProtocolContractByClassId(contractClassId);
    if (protocolContractClass) {
      res.status(200).json(protocolContractClass);
      return;
    }
    const contractClass = await dbWrapper.get(
      contractClassKeys(contractClassId, version, includeArtifactJson),
      () =>
        db.l2Contract.getL2RegisteredContractClass(
          contractClassId,
          version,
          includeArtifactJson,
        ),
    );
    res.status(200).json(JSON.parse(contractClass));
  },
);

export const openapi_GET_L2_REGISTERED_CONTRACT_CLASSES_ALL_VERSIONS: OpenAPIObject["paths"] =
  {
    "/l2/contract-classes/{classId}": {
      get: {
        tags: ["L2", "contract-classes"],
        summary:
          "Get all versions of registered contract classes by contract class id",
        parameters: [
          {
            name: "classId",
            in: "path",
            required: true,
            schema: {
              type: "string",
            },
          },
        ],
        responses: contractClassResponseArray,
      },
    },
  };

export const GET_L2_REGISTERED_CONTRACT_CLASSES_ALL_VERSIONS = asyncHandler(
  async (req, res) => {
    const { contractClassId } =
      getContractClassesByCurrentClassIdSchema.parse(req).params;
    const includeArtifactJson = false;
    const contractClasses = await dbWrapper.getLatest(
      ["l2", "contract-classes", contractClassId],
      () =>
        db.l2Contract.getL2RegisteredContractClasses({
          contractClassId,
          includeArtifactJson,
        }),
    );
    res.status(200).json(JSON.parse(contractClasses));
  },
);

export const openapi_GET_L2_REGISTERED_CONTRACT_CLASSES: OpenAPIObject["paths"] =
  {
    "/l2/contract-classes": {
      get: {
        tags: ["L2", "contract-classes"],
        summary: "Get latest registered contract classes",
        parameters: [
          {
            name: "verifiedSourceOnly",
            in: "query",
            schema: {
              type: "boolean",
            },
          },
        ],
        responses: contractClassResponseArray,
      },
    },
  };

export const GET_L2_REGISTERED_CONTRACT_CLASSES = asyncHandler(
  async (req, res) => {
    const includeArtifactJson = false;
    const { verifiedSourceOnly, offset, limit, verified, protocol } =
      getContractClassesSchema.parse(req).query;
    const contractClasses = await dbWrapper.getLatest(
      [
        "l2",
        "contract-classes",
        verifiedSourceOnly ? "verified-source" : "all",
        offset,
        limit,
        verified ? "v" : undefined,
        protocol ? "p" : undefined,
      ],
      () =>
        db.l2Contract.getL2RegisteredContractClasses({
          includeArtifactJson,
          verifiedSourceOnly,
          offset,
          limit,
          verified,
          protocol,
        }),
    );
    const parsedClasses = JSON.parse(
      contractClasses,
    ) as ChicmozL2ContractClassRegisteredEvent[];
    // Merge protocol contract classes so they appear in the PROTOCOL filter.
    // Merge when: on the first page (or non-paginated) AND the active filter is
    // NOT "verified" or "verifiedSourceOnly" (those exclude non-verified protocol
    // classes, which would bypass the filter). The "protocol" filter and "all"
    // filter both allow protocol classes.
    const excludesProtocol = verifiedSourceOnly === true || verified === true;
    const isFirstPageOrNonPaginated = offset === undefined || offset === 0;
    const protocolClasses =
      !excludesProtocol && isFirstPageOrNonPaginated
        ? getAllProtocolContractClasses()
        : [];
    // Deduplicate: don't add protocol classes that already exist in the DB results
    const dbClassIds = new Set(parsedClasses.map((c) => c.contractClassId));
    const merged = [
      ...parsedClasses,
      ...protocolClasses.filter((pc) => !dbClassIds.has(pc.contractClassId)),
    ];
    res.status(200).json(merged);
  },
);

export const openapi_POST_L2_REGISTERED_CONTRACT_CLASS_ARTIFACT: OpenAPIObject["paths"] =
  {
    "/l2/contract-classes/{classId}/versions/{version}": {
      post: {
        description:
          "Please check out our SDK for how to verify contract class artifact",
        tags: ["L2", "contract-classes"],
        summary: "Register and verify contract class artifact",
        parameters: [
          {
            name: "classId",
            in: "path",
            required: true,
            schema: {
              type: "string",
            },
          },
          {
            name: "version",
            in: "path",
            required: true,
            schema: {
              type: "string",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  stringifiedArtifactJson: {
                    type: "string",
                  },
                },
              },
            },
          },
        },
        responses: contractClassResponse,
      },
    },
  };

export type VerifiedArtifact = Extract<
  ArtifactVerification,
  { isMatchingClassId: true }
>;

/** The class row with its artifact, from Postgres: write decisions never read the cache. */
export const readClassWithArtifact = async (
  contractClassId: string,
  version: number,
): Promise<ChicmozL2ContractClassRegisteredEvent> => {
  const contractClass = await db.l2Contract.getL2RegisteredContractClass(
    contractClassId,
    version,
    true,
  );
  if (!contractClass) {
    throw new NotFoundError(
      `Contract class ${contractClassId} version ${version} not found`,
    );
  }
  return contractClass;
};

/**
 * Stores a verified artifact unless the class already has one and returns
 * the class as stored. Only the request that wrote names the class's public
 * calls and refreshes the cache.
 */
export const storeArtifactIfAbsent = async (
  { contractClassId, version }: ChicmozL2ContractClassRegisteredEvent,
  { artifactJson, artifactContractName }: VerifiedArtifact,
  standardData?: ContractStandard,
) => {
  const { written, selectorMap } = await db.l2Contract.addArtifactData({
    contractClassId,
    version,
    artifactJson,
    contractName: artifactContractName,
    standardData,
  });
  const contractClass = await readClassWithArtifact(contractClassId, version);
  if (written) {
    await db.l2Contract.backfillPublicCallRequestNames({
      contractClassId,
      version,
      selectorMap,
      contractName: artifactContractName,
    });
    setEntry(
      contractClassKeys(contractClassId, version, true),
      jsonStringify(contractClass),
      CACHE_TTL_SECONDS,
    ).catch((err) => {
      logger.warn(`Failed to cache contract class: ${err}`);
    });
  }
  return { written, contractClass };
};

export const verifyArtifact = async ({
  contractClassId,
  version,
  stringifiedArtifactJson,
  standardData,
}: {
  contractClassId: string;
  version: number;
  stringifiedArtifactJson: string | NoirCompiledContract;
  standardData?: ContractStandard;
}) => {
  const registeredClass = await readClassWithArtifact(contractClassId, version);
  if (registeredClass.artifactJson) {
    return {
      success: true,
      alreadyExists: true,
      contractClass: registeredClass,
    };
  }

  const artifactJsonString =
    typeof stringifiedArtifactJson === "string"
      ? stringifiedArtifactJson
      : JSON.stringify(stringifiedArtifactJson);

  if (!artifactJsonString) {
    throw new Error("Missing artifact json");
  }

  const verification = await verifyArtifactPayload(
    { stringifiedArtifactJson: artifactJsonString },
    registeredClass,
  );

  if (!verification.isMatchingClassId) {
    throw new Error(artifactRefusalText[verification.reason]);
  }

  const { written, contractClass } = await storeArtifactIfAbsent(
    registeredClass,
    verification,
    standardData,
  );
  return {
    success: true,
    alreadyExists: !written,
    contractClass,
  };
};

export const POST_L2_REGISTERED_CONTRACT_CLASS_ARTIFACT = asyncHandler(
  async (req, res) => {
    const {
      params: { contractClassId, version },
      body,
    } = postContrctClassArtifactSchema.parse(req);

    if (!body.stringifiedArtifactJson) {
      res.status(400).send("Missing artifact json");
      return;
    }

    try {
      const result = await verifyArtifact({
        contractClassId,
        version,
        stringifiedArtifactJson: body.stringifiedArtifactJson,
      });

      if (result.alreadyExists) {
        res.status(200).json(result.contractClass);
      } else {
        res.status(201).json(result.contractClass);
      }
    } catch (error) {
      if (error instanceof Error) {
        if (isBadArtifactMessage(error.message)) {
          res.status(400).send(error.message);
          return;
        }
      }
      throw error;
    }
  },
);
