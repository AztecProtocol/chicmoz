import { chicmozL1GovernanceProposalSchema } from "@chicmoz-pkg/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { flattenProposalMetadata } from "../../src/svcs/database/controllers/l1/governance/queries.js";
import { resolvePayloadMetadata } from "../../src/svcs/metadata-resolver/index.js";

vi.mock("../../src/logger.js", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("@chicmoz-pkg/postgres-helper", () => ({ getDb: vi.fn() }));

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const offHostPrUrl = "https://example.com/AztecProtocol/governance/pull/7";

const githubPr = {
  org: "AztecProtocol",
  repo: "governance",
  number: 7,
  title: "Upgrade",
  merged: true,
  url: "https://github.com/AztecProtocol/governance/pull/7",
};

describe("resolvePayloadMetadata links", () => {
  it("links a GitHub pull request URI and the first forum-host link in its body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          title: "Upgrade",
          merged: true,
          body: "See https://forum.aztec.network.example.com/t/x/1 and <https://forum.aztec.network/t/alice's-upgrade/42>.",
        }),
      ),
    );

    const metadata = await resolvePayloadMetadata(
      "https://github.com/AztecProtocol/governance/pull/7/files",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/AztecProtocol/governance/pulls/7",
      expect.anything(),
    );
    expect(metadata.github_pr).toEqual(githubPr);
    expect(metadata.forum_link).toBe(
      "https://forum.aztec.network/t/alice's-upgrade/42",
    );
  });

  it("links a forum-host URI without fetching", async () => {
    const metadata = await resolvePayloadMetadata(
      "https://gov.aztec.network/t/proposal/9",
    );

    expect(metadata.forum_link).toBe("https://gov.aztec.network/t/proposal/9");
    expect(metadata.github_pr).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Each URI contains a GitHub pull-request path or a forum host name but is
  // not an https URL on that host.
  it.each([
    [
      "a pull request path under a non-http scheme",
      "javascript:alert(1)//github.com/AztecProtocol/governance/pull/7",
    ],
    [
      "a pull request path in another host's query",
      "https://example.com/?next=github.com/AztecProtocol/governance/pull/7",
    ],
    [
      "a plain-http pull request URL",
      "http://github.com/AztecProtocol/governance/pull/7",
    ],
    [
      "a forum host name as a subdomain label",
      "https://forum.aztec.network.example.com/t/x/1",
    ],
    [
      "a forum host name in another host's path",
      "https://example.com/discourse/forum.aztec.network",
    ],
    [
      "a forum host name under a non-http scheme",
      "javascript://forum.aztec.network/%0Aalert(1)",
    ],
  ])("stores no link for %s", async (_case, uri) => {
    const metadata = await resolvePayloadMetadata(uri);

    expect(metadata).toEqual({
      title: null,
      github_pr: null,
      forum_link: null,
      description: uri,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("governance proposal response schema", () => {
  const row = {
    proposalId: "1",
    payloadAddress: `0x${"1".repeat(40)}`,
    proposer: null,
    governanceProposerAddress: null,
    state: "Active",
    createdAt: "2026-01-01T00:00:00.000Z",
    summedYea: "0",
    summedNay: "0",
    l1BlockNumber: "1",
    l1BlockHash: "0x01",
    l1BlockTimestamp: "2026-01-01T00:00:00.000Z",
  };

  // Rows stored before links were validated must still load: a rejected link
  // becomes null instead of failing the whole list.
  it("reads a list holding a row with unsafe links, dropping only those links", () => {
    const [stale, current] = z.array(chicmozL1GovernanceProposalSchema).parse([
      {
        ...row,
        forum_link: "javascript:alert(1)",
        github_pr: { ...githubPr, url: offHostPrUrl },
        metadata: {
          forum_link: "https://example.com/discourse",
          github_pr: {
            ...githubPr,
            url: "javascript:alert(1)//github.com/a/b/pull/1",
          },
        },
      },
      {
        ...row,
        proposalId: "2",
        forum_link: "https://forum.aztec.network/t/upgrade/42",
        github_pr: githubPr,
      },
    ]);

    expect(stale.forum_link).toBeNull();
    expect(stale.github_pr).toBeNull();
    expect(stale.metadata).toEqual({ forum_link: null, github_pr: null });
    expect(current.forum_link).toBe("https://forum.aztec.network/t/upgrade/42");
    expect(current.github_pr).toEqual(githubPr);
  });
});

describe("stored proposal links in API responses", () => {
  it("returns a stored link that fails the link rules as null, flattened and in metadata", () => {
    const stored = { title: "Upgrade", description: "Body" };

    const stale = flattenProposalMetadata({
      summedYea: 1n,
      summedNay: 2n,
      metadata: {
        ...stored,
        forum_link: "javascript:alert(1)",
        github_pr: { ...githubPr, url: offHostPrUrl },
      },
    });
    const current = flattenProposalMetadata({
      summedYea: 1n,
      summedNay: 2n,
      metadata: {
        ...stored,
        forum_link: "https://forum.aztec.network/t/upgrade/42",
        github_pr: githubPr,
      },
    });

    expect(stale).toMatchObject({
      title: "Upgrade",
      forum_link: null,
      github_pr: null,
      metadata: { ...stored, forum_link: null, github_pr: null },
      votesCast: 3n,
    });
    expect(current).toMatchObject({
      forum_link: "https://forum.aztec.network/t/upgrade/42",
      github_pr: githubPr,
      metadata: {
        forum_link: "https://forum.aztec.network/t/upgrade/42",
        github_pr: githubPr,
      },
    });
  });
});
