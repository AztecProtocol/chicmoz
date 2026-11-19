import {
  FIXTURE_SOURCES,
  canonicalJson,
  listFixtures,
  loadFixture,
} from "@chicmoz/test-harness";
import { describe, expect, it } from "vitest";
import { blockFromBuffer, parseBlock } from "../src/parse-block.js";

const blocks = FIXTURE_SOURCES.flatMap((source) =>
  listFixtures(source, "l2-block").map((name) => ({ source, name })),
);

// The node reports only a few of these fields, so a change to any other one
// (tree snapshots, fees, log fields, a key turning undefined or a bigint
// turning a number) shows only against the full recorded output.
describe("parseBlock on recorded block bytes", () => {
  it.each(blocks)(
    "$source/$name still parses to its recorded output",
    async ({ source, name }) => {
      const { data } = loadFixture(source, "l2-block", name);
      const parsed = await parseBlock(blockFromBuffer(data.hex));
      await expect(canonicalJson(parsed)).toMatchFileSnapshot(
        `__snapshots__/parse-block/${source}-${name}.json.snap`,
      );
    },
  );
});
