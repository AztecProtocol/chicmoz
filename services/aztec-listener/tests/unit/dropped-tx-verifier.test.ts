import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DROPPED_TX_AGE_THRESHOLD_MS,
  DROPPED_TX_BLOCK_LOOKBACK,
  DROPPED_TX_VERIFICATION_INTERVAL_MS,
} from "../../src/environment.js";
import { type getTxs } from "../../src/svcs/database/txs.controller.js";
import {
  createMockL2Block,
  mockLogger,
  mockMessageBus,
  mockNetworkClient,
  mockTxsController,
  resetAllMocks,
} from "../mocks/index.js";

vi.mock("../../src/svcs/database/index.js", () => ({
  txsController: mockTxsController,
}));

vi.mock("../../src/svcs/message-bus/index.js", () => ({
  publishMessage: mockMessageBus.publishMessage,
}));

vi.mock("../../src/logger.js", () => ({
  logger: mockLogger,
}));

vi.mock("../../src/svcs/poller/network-client/index.js", () => ({
  getBlock: mockNetworkClient.getBlock,
  getLatestProvenHeight: mockNetworkClient.getLatestProvenHeight,
}));

import {
  start,
  stop,
} from "../../src/svcs/poller/pollers/dropped-tx-verifier.js";

type StoredTx = Awaited<ReturnType<typeof getTxs>>[number];

const RUN_AT = Date.UTC(2026, 0, 1);
const PROVEN_TIP = 100;
const OLDEST_IN_WINDOW = PROVEN_TIP - DROPPED_TX_BLOCK_LOOKBACK + 1;

const suspectedTx = (txHash: `0x${string}`, ageMs: number): StoredTx => ({
  txHash,
  feePayer: "0x01",
  initiator: undefined,
  additionalMsgSenders: undefined,
  birthTimestamp: RUN_AT - ageMs,
  txState: "suspected_dropped",
});

// Fires the verifier once through its interval, with Date.now() === RUN_AT.
const runOnce = async () => {
  start();
  await vi.advanceTimersByTimeAsync(DROPPED_TX_VERIFICATION_INTERVAL_MS);
  stop();
};

describe("dropped tx verifier", () => {
  beforeEach(() => {
    resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(RUN_AT - DROPPED_TX_VERIFICATION_INTERVAL_MS);
    mockTxsController.storeOrUpdate.mockResolvedValue(undefined);
    mockMessageBus.publishMessage.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks old suspected txs proven when a lookback block holds them, dropped otherwise", async () => {
    const inWindow = suspectedTx("0x0a", 2 * DROPPED_TX_AGE_THRESHOLD_MS);
    const beforeWindow = suspectedTx("0x0b", 2 * DROPPED_TX_AGE_THRESHOLD_MS);
    const young = suspectedTx("0x0c", DROPPED_TX_AGE_THRESHOLD_MS / 2);
    mockTxsController.getTxs.mockResolvedValue([inWindow, beforeWindow, young]);
    mockNetworkClient.getLatestProvenHeight.mockResolvedValue(PROVEN_TIP);
    mockNetworkClient.getBlock.mockImplementation((height: number) =>
      Promise.resolve(
        createMockL2Block(
          height,
          height === OLDEST_IN_WINDOW
            ? ["0x0a", "0x0c"]
            : height === OLDEST_IN_WINDOW - 1
              ? ["0x0b"]
              : [],
        ),
      ),
    );

    await runOnce();

    expect(mockTxsController.storeOrUpdate).toHaveBeenCalledTimes(2);
    expect(mockTxsController.storeOrUpdate).toHaveBeenCalledWith(
      inWindow,
      "proven",
    );
    expect(mockTxsController.storeOrUpdate).toHaveBeenCalledWith(
      beforeWindow,
      "dropped",
    );
    expect(mockMessageBus.publishMessage).toHaveBeenCalledTimes(1);
    expect(mockMessageBus.publishMessage).toHaveBeenCalledWith(
      "DROPPED_TXS_EVENT",
      {
        txs: [
          {
            txHash: "0x0b",
            createdAsPendingAt: beforeWindow.birthTimestamp,
            droppedAt: RUN_AT,
            dropReason: "expired",
          },
        ],
      },
    );
  });

  it("writes and publishes nothing when the proven tip cannot be read", async () => {
    mockTxsController.getTxs.mockResolvedValue([
      suspectedTx("0x0a", 2 * DROPPED_TX_AGE_THRESHOLD_MS),
    ]);
    mockNetworkClient.getLatestProvenHeight.mockRejectedValue(
      new Error("node unavailable"),
    );

    await runOnce();

    expect(mockNetworkClient.getBlock).not.toHaveBeenCalled();
    expect(mockTxsController.storeOrUpdate).not.toHaveBeenCalled();
    expect(mockMessageBus.publishMessage).not.toHaveBeenCalled();
  });
});
