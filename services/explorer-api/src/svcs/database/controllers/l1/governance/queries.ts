import { eq, desc, and, asc, gte, isNull, or } from "drizzle-orm";
import { getDb as db } from "@chicmoz-pkg/postgres-helper";
import {
  governanceProposalMetadataSchema,
  type ProposalState,
} from "@chicmoz-pkg/types";
import {
  l1GovernanceProposalsTable,
  l1GovernanceVotesTable,
  l1GovernanceSignalsTable,
  l1GovernancePayloadRoundsTable,
  l1GovernanceConfigurationsTable,
  l1GovernanceProposerHistoryTable,
} from "../../../schema/l1/governance.js";
import { oncePerL1Log } from "../once-per-log.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const oncePerVoteLog = () =>
  oncePerL1Log(l1GovernanceVotesTable, ["l1TransactionHash", "l1LogIndex"]);
const oncePerSignalLog = () =>
  oncePerL1Log(l1GovernanceSignalsTable, ["l1TransactionHash", "l1LogIndex"]);

const { forum_link: forumLinkSchema, github_pr: githubPrSchema } =
  governanceProposalMetadataSchema.shape;

/**
 * Flatten metadata JSONB into top-level fields expected by the API schema / UI.
 * Stored links that fail the response schema's link rules come back as null,
 * both flattened and inside `metadata`.
 */
export const flattenProposalMetadata = <T extends { metadata: unknown }>(
  row: T,
): Omit<T, "metadata" | "title" | "forum_link" | "github_pr" | "votesCast"> & {
  metadata: Record<string, unknown> | null;
  title: string | null;
  forum_link: string | null;
  github_pr: unknown;
  votesCast: bigint;
} => {
  const stored =
    typeof row.metadata === "object" &&
    row.metadata !== null &&
    !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : null;
  const forumLink = forumLinkSchema.parse(stored?.forum_link) ?? null;
  const githubPr = githubPrSchema.parse(stored?.github_pr) ?? null;
  const voteRow = row as T & { summedYea: bigint | string; summedNay: bigint | string };
  return {
    ...row,
    metadata: stored && { ...stored, forum_link: forumLink, github_pr: githubPr },
    title: (stored?.title as string | undefined) ?? null,
    forum_link: forumLink,
    github_pr: githubPr,
    votesCast: BigInt(voteRow.summedYea) + BigInt(voteRow.summedNay),
  };
};

// ── Proposals ────────────────────────────────────────────────────────────────

export const getProposals = async (params?: {
  state?: ProposalState;
  from?: number;
  to?: number;
  offset?: number;
  limit?: number;
}) => {
  const { state, offset = 0, limit = 20 } = params ?? {};

  const conditions = [];
  if (state) {
    conditions.push(eq(l1GovernanceProposalsTable.state, state));
  }

  const rows = await db()
    .select()
    .from(l1GovernanceProposalsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(l1GovernanceProposalsTable.createdAt))
    .limit(limit)
    .offset(offset);

  return rows.map(flattenProposalMetadata);
};

export const getProposalById = async (proposalId: string) => {
  const results = await db()
    .select()
    .from(l1GovernanceProposalsTable)
    .where(eq(l1GovernanceProposalsTable.proposalId, proposalId))
    .limit(1);

  const row = results[0];
  return row ? flattenProposalMetadata(row) : null;
};

export const getProposalsMissingUri = async ({
  limit,
  lookbackDays,
}: {
  limit: number;
  lookbackDays: number;
}) => {
  const createdAfter = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;

  return await db()
    .select({
      proposalId: l1GovernanceProposalsTable.proposalId,
      proposalAddress: l1GovernanceProposalsTable.payloadAddress,
      l1BlockNumber: l1GovernanceProposalsTable.l1BlockNumber,
    })
    .from(l1GovernanceProposalsTable)
    .where(
      and(
        isNull(l1GovernanceProposalsTable.uri),
        gte(l1GovernanceProposalsTable.createdAt, createdAfter),
      ),
    )
    .orderBy(asc(l1GovernanceProposalsTable.createdAt))
    .limit(limit);
};

export const getProposalVotes = async (
  proposalId: string,
  params?: {
    support?: boolean;
    offset?: number;
    limit?: number;
  },
) => {
  const { support, offset = 0, limit = 50 } = params ?? {};

  const conditions = [
    eq(l1GovernanceVotesTable.proposalId, proposalId),
    oncePerVoteLog(),
  ];
  if (support !== undefined) {
    conditions.push(eq(l1GovernanceVotesTable.support, support));
  }

  return await db()
    .select()
    .from(l1GovernanceVotesTable)
    .where(and(...conditions))
    .orderBy(desc(l1GovernanceVotesTable.l1BlockNumber))
    .limit(limit)
    .offset(offset);
};

export const getProposalSignals = async (
  payloadAddress: string,
  originalPayloadAddress?: string | null,
  params?: {
    offset?: number;
    limit?: number;
  },
) => {
  const { offset = 0, limit = 50 } = params ?? {};
  const addressFilter = originalPayloadAddress
    ? or(
        eq(l1GovernanceSignalsTable.payloadAddress, payloadAddress),
        eq(l1GovernanceSignalsTable.payloadAddress, originalPayloadAddress),
      )
    : eq(l1GovernanceSignalsTable.payloadAddress, payloadAddress);

  return await db()
    .select()
    .from(l1GovernanceSignalsTable)
    .where(and(addressFilter, oncePerSignalLog()))
    .orderBy(desc(l1GovernanceSignalsTable.l1BlockNumber))
    .limit(limit)
    .offset(offset);
};

// ── Signals ──────────────────────────────────────────────────────────────────

export const getSignals = async (params?: {
  payloadAddress?: string;
  round?: bigint;
  signaler?: string;
  offset?: number;
  limit?: number;
}) => {
  const { payloadAddress, round, signaler, offset = 0, limit = 50 } =
    params ?? {};

  const conditions = [oncePerSignalLog()];
  if (payloadAddress) {
    conditions.push(
      eq(l1GovernanceSignalsTable.payloadAddress, payloadAddress),
    );
  }
  if (round !== undefined) {
    conditions.push(eq(l1GovernanceSignalsTable.round, round));
  }
  if (signaler) {
    conditions.push(eq(l1GovernanceSignalsTable.signaler, signaler));
  }

  return await db()
    .select()
    .from(l1GovernanceSignalsTable)
    .where(and(...conditions))
    .orderBy(desc(l1GovernanceSignalsTable.l1BlockNumber))
    .limit(limit)
    .offset(offset);
};

export const getSignalsByRound = async (round: bigint) => {
  return await db()
    .select()
    .from(l1GovernanceSignalsTable)
    .where(and(eq(l1GovernanceSignalsTable.round, round), oncePerSignalLog()))
    .orderBy(desc(l1GovernanceSignalsTable.l1BlockNumber));
};

export const getSignalsByPayload = async (payloadAddress: string) => {
  return await db()
    .select()
    .from(l1GovernanceSignalsTable)
    .where(
      and(
        eq(l1GovernanceSignalsTable.payloadAddress, payloadAddress),
        oncePerSignalLog(),
      ),
    )
    .orderBy(desc(l1GovernanceSignalsTable.l1BlockNumber));
};

// ── Payload Rounds ───────────────────────────────────────────────────────────

export const getPayloadRounds = async () => {
  return await db()
    .select()
    .from(l1GovernancePayloadRoundsTable)
    .orderBy(
      desc(l1GovernancePayloadRoundsTable.round),
      desc(l1GovernancePayloadRoundsTable.signalCount),
    );
};

export const getPayloadRound = async (
  payloadAddress: string,
  round: bigint,
) => {
  const results = await db()
    .select()
    .from(l1GovernancePayloadRoundsTable)
    .where(
      and(
        eq(l1GovernancePayloadRoundsTable.payloadAddress, payloadAddress),
        eq(l1GovernancePayloadRoundsTable.round, round),
      ),
    )
    .limit(1);

  return results[0] ?? null;
};

// ── Configurations ───────────────────────────────────────────────────────────

export const getConfigurations = async (params?: {
  offset?: number;
  limit?: number;
}) => {
  const { offset = 0, limit = 20 } = params ?? {};

  return await db()
    .select()
    .from(l1GovernanceConfigurationsTable)
    .orderBy(desc(l1GovernanceConfigurationsTable.updatedAt))
    .limit(limit)
    .offset(offset);
};

// ── Proposer History ─────────────────────────────────────────────────────────

export const getProposerHistory = async (params?: {
  offset?: number;
  limit?: number;
}) => {
  const { offset = 0, limit = 20 } = params ?? {};

  return await db()
    .select()
    .from(l1GovernanceProposerHistoryTable)
    .orderBy(desc(l1GovernanceProposerHistoryTable.updatedAt))
    .limit(limit)
    .offset(offset);
};
