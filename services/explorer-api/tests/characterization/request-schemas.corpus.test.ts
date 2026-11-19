import { type SafeParser, canonicalParse } from "@chicmoz/test-harness";
import { describe, expect, it, vi } from "vitest";

// The deployment-verification body schema depends on NODE_ENV, which
// @chicmoz-pkg/types reads when it is first imported.
vi.stubEnv("NODE_ENV", "test");
const routes = await import(
  "../../src/svcs/http-server/routes/paths_and_validation.js"
);

const HASH = `0x${"ab".repeat(32)}`;
const ETH = `0x${"cd".repeat(20)}`;
const UUID_V4 = "3f1b8a6e-2c4d-4e8f-9a1b-7c6d5e4f3a2b";

const deploymentArguments = {
  salt: HASH,
  deployer: HASH,
  publicKeysString: "0x01",
  constructorArgs: ["0x1", "2"],
};

// Each request exercises a coercion, a default or an absent optional key:
// where a zod major changes what a handler receives.
const cases: Array<[string, SafeParser, unknown]> = [
  [
    "block by height coerces a decimal height",
    routes.getBlockByHeightOrHashSchema,
    { params: { heightOrHash: "12" } },
  ],
  [
    "block by hash keeps the hex string",
    routes.getBlockByHeightOrHashSchema,
    { params: { heightOrHash: HASH } },
  ],
  [
    "blocks coerce from and to",
    routes.getBlocksSchema,
    { query: { from: "1", to: "10" } },
  ],
  [
    "blocks leave an absent range absent",
    routes.getBlocksSchema,
    { query: {} },
  ],
  [
    "blocks refuse a negative from",
    routes.getBlocksSchema,
    { query: { from: "-1" } },
  ],
  [
    "ui blocks take a status filter without a range",
    routes.getUiBlocksSchema,
    { query: { status: "proven" } },
  ],
  [
    "tx effect coerces height and index",
    routes.getTxEffectByBlockHeightAndIndexSchema,
    { params: { blockHeight: "5", txEffectIndex: "0" } },
  ],
  [
    "public call requests keep one absent address absent",
    routes.getPublicCallRequestsSchema,
    { query: { contractAddress: "0x01" } },
  ],
  [
    "contract instance reads includeArtifactJson=false as true",
    routes.getContractInstanceSchema,
    { params: { address: HASH }, query: { includeArtifactJson: "false" } },
  ],
  [
    "contract instances coerce every query key",
    routes.getContractInstancesSchema,
    {
      query: {
        fromHeight: "1",
        toHeight: "9",
        offset: "0",
        limit: "10",
        verified: "true",
        protocol: "0",
      },
    },
  ],
  [
    "contract class coerces the version",
    routes.getContractClassSchema,
    { params: { contractClassId: HASH, version: "1" }, query: {} },
  ],
  [
    "contract classes take an empty query",
    routes.getContractClassesSchema,
    { query: {} },
  ],
  [
    "private function coerces the selector",
    routes.getContractClassPrivateFunctionSchema,
    { params: { contractClassId: HASH, functionSelector: "123" } },
  ],
  [
    "standard artifact takes a name of its version",
    routes.postContrctClassStandardArtifactSchema,
    {
      params: { contractClassId: HASH, version: "1" },
      body: { version: "4.2.0-aztecnr-rc.2", name: "token" },
    },
  ],
  [
    "standard artifact refuses a name of no standard",
    routes.postContrctClassStandardArtifactSchema,
    {
      params: { contractClassId: HASH, version: "1" },
      body: { version: "4.2.0-aztecnr-rc.2", name: "not-a-standard" },
    },
  ],
  [
    "class artifact upload keeps the artifact string",
    routes.postContrctClassArtifactSchema,
    {
      params: { contractClassId: HASH, version: "1" },
      query: {},
      body: { stringifiedArtifactJson: "{}" },
    },
  ],
  [
    "deployment verification without metadata",
    routes.postVerifiedContractInstanceSchema,
    {
      params: { address: HASH },
      query: {},
      body: { verifiedDeploymentArguments: deploymentArguments },
    },
  ],
  [
    "deployment verification with metadata, null dates and notes",
    routes.postVerifiedContractInstanceSchema,
    {
      params: { address: HASH },
      query: {},
      body: {
        verifiedDeploymentArguments: {
          ...deploymentArguments,
          stringifiedArtifactJson: "{}",
        },
        deployerMetadata: {
          contractIdentifier: "token",
          details: "d",
          creatorName: "c",
          creatorContact: "c@example.org",
          appUrl: "https://example.org",
          repoUrl: "https://github.com/example/token",
          reviewedAt: null,
          contractType: null,
          aztecScanNotes: {
            name: "n",
            origin: "o",
            comment: "c",
            category: null,
            uploadedAt: "2026-01-01T00:00:00Z",
          },
        },
      },
    },
  ],
  [
    "search turns a decimal phrase into a bigint",
    routes.getSearchSchema,
    { query: { q: "42" } },
  ],
  [
    "search prefixes a bare hex phrase",
    routes.getSearchSchema,
    { query: { q: "ab" } },
  ],
  [
    "public log search coerces the index",
    routes.getSearchPublicLogsSchema,
    { query: { frLogEntry: HASH, index: "3" } },
  ],
  [
    "hourly counts default hours to 24",
    routes.getL1ContractEventsHourlyCountsSchema,
    { query: {} },
  ],
  [
    "hourly counts coerce hours",
    routes.getL1ContractEventsHourlyCountsSchema,
    { query: { hours: "48" } },
  ],
  [
    "validators page defaults limit and offset",
    routes.getL1L2ValidatorsPaginatedSchema,
    { query: {} },
  ],
  [
    "rpc node by name",
    routes.getRpcNodeSchema,
    { params: { rpcNodeName: "node-1" } },
  ],
  [
    "fee juice deposits by address",
    routes.getFeeJuicePortalDepositsByAddressSchema,
    { params: { address: "0xab" } },
  ],
  [
    "contract instances with notes take an empty query",
    routes.getContractInstancesWithAztecScanNotesSchema,
    { query: {} },
  ],
  [
    "source verification request leaves gitRef and subPath absent",
    routes.postVerifySourceSchema,
    {
      params: { contractClassId: HASH, version: "2" },
      body: { githubUrl: "https://github.com/example/token" },
    },
  ],
  [
    "source verification job takes an RFC 4122 job id",
    routes.getVerifySourceJobSchema,
    { params: { contractClassId: HASH, version: "1", jobId: UUID_V4 } },
  ],
  [
    "governance proposals coerce the range and default the page",
    routes.getGovernanceProposalsSchema,
    { query: { state: "Active", from: "1", to: "5" } },
  ],
  [
    "governance votes coerce support and default the page",
    routes.getGovernanceProposalVotesSchema,
    { params: { proposalId: "1" }, query: { support: "false" } },
  ],
  [
    "governance signals coerce the round to bigint",
    routes.getGovernanceSignalsSchema,
    { query: { round: "3", payloadAddress: ETH } },
  ],
  [
    "governance signals by round coerce the round",
    routes.getGovernanceSignalsByRoundSchema,
    { params: { round: "7" } },
  ],
  [
    "governance configurations default the page",
    routes.getGovernanceConfigurationsSchema,
    { query: {} },
  ],
  [
    "governance proposer history defaults the page",
    routes.getGovernanceProposerHistorySchema,
    { query: {} },
  ],
];

describe("request schemas", () => {
  it.each(cases)("%s", (_, schema, request) => {
    expect(canonicalParse(schema, request)).toMatchSnapshot();
  });

  // Each case pins today's outcome for an input zod 4 treats differently.
  describe("known changes", () => {
    it("accepts a job id without the RFC 4122 variant bits (.uuid() check)", () => {
      const jobId = "11111111-1111-1111-1111-111111111111";

      expect(
        canonicalParse(routes.getVerifySourceJobSchema, {
          params: { contractClassId: HASH, version: "1", jobId },
        }),
      ).toEqual({ params: { contractClassId: HASH, jobId, version: 1 } });
    });

    it("throws a SyntaxError, not a validation error, for a non-numeric bigint path value (coerce.bigint)", () => {
      expect(() =>
        routes.getGovernanceSignalsByRoundSchema.safeParse({
          params: { round: "abc" },
        }),
      ).toThrow(SyntaxError);
    });

    it("accepts offset=Infinity on a contract list route (non-finite numbers)", () => {
      expect(
        canonicalParse(routes.getContractInstancesSchema, {
          query: { offset: "Infinity" },
        }),
      ).toEqual({ query: { offset: { $number: "Infinity" } } });
    });
  });
});
