import {
  FIXTURE_SOURCES,
  listFixtures,
  loadFixture,
} from "@chicmoz/test-harness";
import { describe, expect, it } from "vitest";
import { blockFromBuffer, parseBlock } from "../src/parse-block.js";

// Recorded v6 blocks against what the node itself reported. Hash, archive,
// height and checkpoint coordinates are the node's own values; the counts come
// from the SDK's JSON decoding of the same response, a different path from
// the binary one decoded here.
const blocks = FIXTURE_SOURCES.flatMap((source) =>
  listFixtures(source, "l2-block").map((name) => {
    const { data } = loadFixture(source, "l2-block", name);
    return { label: `${source}/${name}`, ...data };
  }),
);

describe("parseBlock on recorded blocks", () => {
  it.each(blocks)("$label decodes to the node's values", async ({ hex, expected }) => {
    const block = blockFromBuffer(hex);
    expect(Number(block.checkpointNumber)).toBe(expected.checkpointNumber);
    expect(block.indexWithinCheckpoint).toBe(expected.indexWithinCheckpoint);

    const parsed = await parseBlock(block);
    expect(parsed.hash).toBe(expected.hash);
    expect(parsed.height).toBe(BigInt(expected.height));
    expect(parsed.archive.root).toBe(expected.archiveRoot);
    const txs = parsed.body.txEffects;
    expect(txs.map((t) => t.txHash)).toEqual(expected.txHashes);
    const count = (pick: (t: (typeof txs)[number]) => unknown[]) =>
      txs.reduce((n, t) => n + pick(t).length, 0);
    expect({
      txEffects: txs.length,
      noteHashes: count((t) => t.noteHashes),
      nullifiers: count((t) => t.nullifiers),
      l2ToL1Msgs: count((t) => t.l2ToL1Msgs),
      publicDataWrites: count((t) => t.publicDataWrites),
      publicLogs: count((t) => t.publicLogs),
      privateLogs: count((t) => t.privateLogs),
      contractClassLogs: count((t) => t.contractClassLogs),
    }).toEqual(expected.counts);
  });
});
