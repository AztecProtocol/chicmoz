import { BlockNumber } from "@aztec-labs/foundation/branded-types";
import { L2Block } from "@aztec-labs/stdlib/block";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { openAttestedReader } from "../../src/svcs/poller/network-client/attested-reads.js";
import { NodeCheckError } from "../../src/svcs/poller/network-client/block-stream-source.js";
import {
  type Chain,
  FakeNode,
  ROLLUP_VERSION,
  emptyBlock,
  genesisChain,
  grow,
  respond,
} from "./support/chain.js";

vi.mock("../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../src/events/emitted/index.js", () => ({
  onChainInfo: vi.fn(),
  onL2RpcNodeAlive: vi.fn(),
  onL2RpcNodeError: vi.fn(),
  onL2RpcNodeInfo: vi.fn(),
}));

let chain: Chain;

beforeAll(async () => {
  chain = await grow(await genesisChain(), 4);
});

const nodeAt = (finalized: number) => {
  const node = new FakeNode("x", chain);
  node.tiers = { checkpointed: 4, proven: 3, finalized };
  return node;
};

describe("openAttestedReader", () => {
  it("reads the node's tips and version before its blocks, with the caller's heartbeat between the two, and marks a block finalized only at or below its finalized tip", async () => {
    const node = nodeAt(2);
    const reader = await openAttestedReader(node.rpc, ROLLUP_VERSION, () => {
      node.calls.push("heartbeat");
      return Promise.resolve();
    });

    const [two, three] = [await reader.getBlock(2), await reader.getBlock(3)];

    expect(node.calls).toEqual([
      "getChainTips",
      "heartbeat",
      "getNodeInfo",
      "getBlock",
      "getBlock",
    ]);
    expect(await two?.block.hash()).toEqual(await chain.blocks[2].hash());
    expect([two?.finalized, three?.finalized]).toEqual([true, false]);
    expect(reader.tips.proposed.number).toBe(4);
  });

  it.each([
    {
      on: "a node of another rollup version",
      nodeVersion: ROLLUP_VERSION + 1,
      blockVersion: ROLLUP_VERSION,
      streamVersion: ROLLUP_VERSION,
    },
    {
      on: "a block of another rollup version",
      nodeVersion: ROLLUP_VERSION,
      blockVersion: ROLLUP_VERSION + 1,
      streamVersion: ROLLUP_VERSION,
    },
    {
      on: "a stream that follows no version yet",
      nodeVersion: ROLLUP_VERSION,
      blockVersion: ROLLUP_VERSION,
      streamVersion: undefined,
    },
  ])(
    "marks no block finalized on $on",
    async ({ nodeVersion, blockVersion, streamVersion }) => {
      const node = nodeAt(4);
      node.rollupVersion = nodeVersion;
      const block = await emptyBlock(1, chain.blocks[0], blockVersion);
      node.getBlockOverride = () => respond(block, true);
      const reader = await openAttestedReader(node.rpc, streamVersion);

      expect((await reader.getBlock(1))?.finalized).toBe(false);
    },
  );

  it.each([
    {
      answer: "another block than the one asked",
      serve: () => respond(chain.blocks[3], true),
    },
    {
      answer: "a body that does not match its header",
      serve: async () => ({
        ...(await respond(chain.blocks[2], true)),
        body: (await L2Block.random(BlockNumber(2), { txsPerBlock: 1 })).body,
      }),
    },
  ])("throws when the node answers with $answer", async ({ serve }) => {
    const node = nodeAt(2);
    node.getBlockOverride = serve;
    const reader = await openAttestedReader(node.rpc, ROLLUP_VERSION);

    await expect(reader.getBlock(2)).rejects.toThrow(NodeCheckError);
  });
});
