import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  mockTxsController,
  mockMessageBus,
  mockLogger,
  createMockL2Block,
  createMockDbTx,
  resetAllMocks,
} from "../mocks/index.js";

// Mock the dependencies
vi.mock("../../src/svcs/database/index.js", () => ({
  txsController: mockTxsController,
}));

vi.mock("../../src/svcs/message-bus/index.js", () => ({
  publishMessage: mockMessageBus.publishMessage,
  publishKeyedMessage: mockMessageBus.publishKeyedMessage,
}));

vi.mock("../../src/logger.js", () => ({
  logger: mockLogger,
}));

// Import the actual function after setting up mocks
import { onOrderedBlock } from "../../src/events/emitted/index.js";

describe("onOrderedBlock", () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it("sends the block under the network's key with its pass's tip, and promotes its pending txs to proposed", async () => {
    mockTxsController.getTxs.mockResolvedValue([
      createMockDbTx("tx-1", "pending"),
      createMockDbTx("tx-3", "suspected_dropped"),
    ]);

    await onOrderedBlock(
      // @ts-expect-error - Mock object doesn't implement full L2Block interface
      createMockL2Block(100, ["tx-1", "tx-2"]),
      104,
    );

    expect(mockMessageBus.publishKeyedMessage).toHaveBeenCalledWith(
      "NEW_BLOCK_EVENT",
      "SANDBOX",
      {
        block: Buffer.from("mock-block-100").toString("hex"),
        statusHint: "proposed",
        blockNumber: 100,
        ordered: { tip: 104 },
      },
    );
    expect(mockMessageBus.publishMessage).not.toHaveBeenCalled();
    expect(mockTxsController.storeOrUpdate).toHaveBeenCalledTimes(1);
    expect(mockTxsController.storeOrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: "tx-1" }),
      "proposed",
    );
  });
});
