import {
  ChicmozL2CheckpointTip,
  ChicmozL2TipBlock,
  ChicmozL2Tips,
  chicmozL2TipsSchema,
  jsonStringify,
} from "@chicmoz-pkg/types";
import { type L2Tips } from "@aztec-labs/stdlib/block";
import { L2_TIPS_HEARTBEAT_INTERVAL_MS } from "../../../environment.js";
import { onL2Tips } from "../../../events/emitted/index.js";

type RawTipBlock = { number: { valueOf?: () => unknown } | number | bigint; hash: unknown };
type RawCheckpointTip = {
  block: RawTipBlock;
  checkpoint: { number: { valueOf?: () => unknown } | number | bigint; hash: unknown };
};
type RawL2Tips = {
  proposed: RawTipBlock;
  proposedCheckpoint?: RawCheckpointTip;
  checkpointed: RawCheckpointTip;
  proven: RawCheckpointTip;
  finalized: RawCheckpointTip;
};

let lastPublishedTips: string | undefined;
let lastPublishedAt = 0;

const toSafeNumber = (value: { valueOf?: () => unknown } | number | bigint) => {
  const maybeValue =
    typeof value === "object" && value?.valueOf
      ? value.valueOf()
      : value;
  const numberValue = Number(maybeValue);
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) {
    throw new Error(`Invalid L2 tip number ${String(maybeValue)}`);
  }
  return numberValue;
};

const normalizeTipBlock = (tip: RawTipBlock): ChicmozL2TipBlock => ({
  number: toSafeNumber(tip.number),
  hash: String(tip.hash) as `0x${string}`,
});

const normalizeCheckpointTip = (
  tip: RawCheckpointTip,
): ChicmozL2CheckpointTip => ({
  block: normalizeTipBlock(tip.block),
  checkpoint: {
    number: toSafeNumber(tip.checkpoint.number),
    hash: String(tip.checkpoint.hash) as `0x${string}`,
  },
});

const normalizeTips = (tips: RawL2Tips): ChicmozL2Tips =>
  chicmozL2TipsSchema.parse({
    proposed: normalizeTipBlock(tips.proposed),
    proposedCheckpoint: tips.proposedCheckpoint
      ? normalizeCheckpointTip(tips.proposedCheckpoint)
      : undefined,
    checkpointed: normalizeCheckpointTip(tips.checkpointed),
    proven: normalizeCheckpointTip(tips.proven),
    finalized: normalizeCheckpointTip(tips.finalized),
  });

/** Publishes `raw` unless it equals the last tips published and the heartbeat is not due. */
export const publishTipsIfDue = async (raw: L2Tips) => {
  const tips = normalizeTips(raw as unknown as RawL2Tips);
  const serialized = jsonStringify(tips);
  const heartbeatDue = Date.now() - lastPublishedAt >= L2_TIPS_HEARTBEAT_INTERVAL_MS;
  if (serialized === lastPublishedTips && !heartbeatDue) {
    return;
  }
  await onL2Tips(tips);
  lastPublishedTips = serialized;
  lastPublishedAt = Date.now();
};
