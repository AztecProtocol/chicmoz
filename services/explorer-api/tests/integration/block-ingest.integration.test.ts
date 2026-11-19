import { deliver, listFixtures, loadFixture } from "@chicmoz/test-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";

// Local-network blocks only: one database serves one rollup version. Every
// expected value is what the node reported when the block was recorded.
const recorded = listFixtures("local-network", "l2-block").map(
  (name) => loadFixture("local-network", "l2-block", name).data,
);

describe("recorded blocks through the block handler", () => {
  let api: ExplorerApiForTest;

  beforeAll(async () => {
    api = await startExplorerApiForTest();
    const { blockHandler } = await import(
      "../../src/events/received/on-block/index.js"
    );
    for (const { hex, expected } of recorded) {
      await deliver(blockHandler, {
        block: hex,
        blockNumber: expected.height,
        statusHint: "proposed",
      });
    }
  });

  afterAll(async () => {
    await api?.close();
  });

  it.each(recorded.map(({ expected }) => ({ label: `block ${expected.height}`, ...expected })))(
    "$label is served with the node's hash, archive and txs, and each tx by its hash",
    async ({ height, hash, archiveRoot, txHashes }) => {
      const block = await api.request.get(`/l2/blocks/${height}`);
      expect(block.status).toBe(200);
      expect(JSON.parse(block.text)).toMatchObject({
        hash,
        height: String(height),
        archive: { root: archiveRoot },
        body: { txEffects: txHashes.map((txHash) => ({ txHash })) },
      });
      for (const txHash of txHashes) {
        const tx = await api.request.get(`/l2/tx-effects/${txHash}`);
        expect(tx.status).toBe(200);
        expect(JSON.parse(tx.text)).toMatchObject({ txHash, blockHash: hash, blockHeight: String(height) });
      }
    },
  );

  it("links each published class and deployed instance to the block that carries it", async () => {
    const classes = recorded.flatMap(({ expected }) =>
      expected.contractClassIds.map((id) => ({ id, blockHash: expected.hash })),
    );
    const instances = recorded.flatMap(({ expected }) =>
      expected.contractInstanceAddresses.map((address) => ({ address, blockHash: expected.hash })),
    );
    expect(classes.length).toBeGreaterThan(0);
    expect(instances.length).toBeGreaterThan(0);
    for (const { id, blockHash } of classes) {
      const res = await api.request.get(`/l2/contract-classes/${id}`);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.text)).toMatchObject([{ contractClassId: id, blockHash }]);
    }
    for (const { address, blockHash } of instances) {
      const res = await api.request.get(`/l2/contract-instances/${address}`);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.text)).toMatchObject({ address, blockHash });
    }
  });
});
