import { type L1GovernanceUriRequestEvent } from "@chicmoz-pkg/message-registry";
import { type PlannedRangeRequest } from "../../svcs/database/controllers/l2block/missing-ranges.js";
import {
  publishL1Message,
  publishMessage,
} from "../../svcs/message-bus/index.js";

export const l2BlockRangeRequest = async (
  planned: PlannedRangeRequest | null,
) => {
  if (planned) {
    await publishMessage("L2_BLOCK_RANGE_REQUEST_EVENT", planned.request);
    // Only once published: a failed publish leaves the gaps unmarked, so the
    // next tick retries them instead of waiting out a backoff for nothing.
    await planned.markRequested();
  }
};

export const l1GovernanceUriRequest = async (
  request: L1GovernanceUriRequestEvent | null,
) => {
  if (request) {
    await publishL1Message("L1_GOVERNANCE_URI_REQUEST_EVENT", request);
  }
};
