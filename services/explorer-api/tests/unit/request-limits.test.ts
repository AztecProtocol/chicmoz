import { describe, expect, it } from "vitest";
import * as routes from "../../src/svcs/http-server/routes/paths_and_validation.js";

type QuerySchema = { safeParse(input: unknown): { success: boolean } };

// The approved ceilings are written out, so a raised or removed bound fails
// here; each schema is the one its route parses.
const queryCaps: Array<[string, string, number, QuerySchema, object]> = [
  [
    "hourly counts",
    "hours",
    168,
    routes.getL1ContractEventsHourlyCountsSchema,
    {},
  ],
  [
    "validators page",
    "limit",
    1000,
    routes.getL1L2ValidatorsPaginatedSchema,
    {},
  ],
  [
    "governance proposals",
    "limit",
    100,
    routes.getGovernanceProposalsSchema,
    {},
  ],
  [
    "governance proposal votes",
    "limit",
    100,
    routes.getGovernanceProposalVotesSchema,
    { params: { proposalId: "1" } },
  ],
  [
    "governance proposal signals",
    "limit",
    100,
    routes.getGovernanceProposalSignalsSchema,
    { params: { proposalId: "1" } },
  ],
  ["governance signals", "limit", 100, routes.getGovernanceSignalsSchema, {}],
  [
    "governance configurations",
    "limit",
    100,
    routes.getGovernanceConfigurationsSchema,
    {},
  ],
  [
    "governance proposer history",
    "limit",
    100,
    routes.getGovernanceProposerHistorySchema,
    {},
  ],
];

describe("request limits", () => {
  it.each(queryCaps)(
    "%s accepts %s at %i and refuses one more",
    (_, key, cap, schema, request) => {
      const withValue = (value: number) =>
        schema.safeParse({ ...request, query: { [key]: String(value) } })
          .success;

      expect([withValue(cap), withValue(cap + 1)]).toEqual([true, false]);
    },
  );

  it("deployment verification accepts 4,096 constructor arguments and refuses 4,097", () => {
    const withCount = (count: number) =>
      routes.postVerifiedContractInstanceSchema.safeParse({
        params: { address: `0x${"ab".repeat(32)}` },
        query: {},
        body: {
          verifiedDeploymentArguments: {
            salt: `0x${"ab".repeat(32)}`,
            deployer: `0x${"ab".repeat(32)}`,
            publicKeysString: "0x01",
            constructorArgs: Array<string>(count).fill("1"),
          },
        },
      }).success;

    expect([withCount(4096), withCount(4097)]).toEqual([true, false]);
  });
});
