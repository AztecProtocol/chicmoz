import { describe, expect, it } from "vitest";
import {
  type BlockEventSource,
  type BlockStoreFacts,
  type TxOwner,
  planBlockStore,
} from "../../src/svcs/database/controllers/l2block/store-plan.js";

const VERSION = 4248422647;
const PROVEN_TIP = 104_539;
const LIVE_PROPOSED: BlockEventSource = { live: true, proven: false };
const LIVE_PROVEN: BlockEventSource = { live: true, proven: true };
const CATCHUP_PROPOSED: BlockEventSource = { live: false, proven: false };
const CATCHUP_PROVEN: BlockEventSource = { live: false, proven: true };

const facts = (overrides: Partial<BlockStoreFacts> = {}): BlockStoreFacts => ({
  existing: null,
  sameHeightActive: [],
  txOwners: [],
  provenTip: PROVEN_TIP,
  ...overrides,
});
const owner = (overrides: Partial<TxOwner> = {}): TxOwner => ({
  txHash: "0x2ba1",
  blockHash: "0x2c3d",
  blockHeight: 103_172n,
  rollupVersion: VERSION,
  isOrphaned: false,
  ...overrides,
});
const plan = (height: bigint, source: BlockEventSource, f: BlockStoreFacts) =>
  planBlockStore({ height, rollupVersion: VERSION }, source, f);

const ABOVE_TIP = 104_560n;
const BELOW_TIP = 103_158n;

describe("empty height", () => {
  it.each([LIVE_PROPOSED, LIVE_PROVEN, CATCHUP_PROPOSED, CATCHUP_PROVEN])(
    "any block fills it (%o)",
    (source) => {
      expect(plan(BELOW_TIP, source, facts())).toEqual({
        action: "insert",
        replace: null,
        deleteOwners: [],
      });
    },
  );

  it("keeps a block that is already stored and active", () => {
    expect(
      plan(
        BELOW_TIP,
        CATCHUP_PROPOSED,
        facts({ existing: { isOrphaned: false } }),
      ),
    ).toEqual({ action: "keep" });
  });
});

describe("a different active block at the same height", () => {
  const sameHeight = facts({ sameHeightActive: ["0xstale"] });

  it("is replaced by a live block above the proven tip, with the blocks above it", () => {
    expect(plan(ABOVE_TIP, LIVE_PROPOSED, sameHeight)).toMatchObject({
      action: "insert",
      replace: { hashes: ["0xstale"], descendantsAbove: ABOVE_TIP },
    });
  });

  it("is never replaced by a proposed block at a proven height (live or not)", () => {
    for (const source of [LIVE_PROPOSED, CATCHUP_PROPOSED]) {
      expect(plan(BELOW_TIP, source, sameHeight)).toMatchObject({
        action: "skip",
      });
    }
  });

  it("is not replaced by a proposed catch-up above the proven tip either", () => {
    expect(plan(ABOVE_TIP, CATCHUP_PROPOSED, sameHeight)).toMatchObject({
      action: "skip",
    });
  });

  it("is replaced by a proven block at a proven height, without touching the blocks above", () => {
    for (const source of [LIVE_PROVEN, CATCHUP_PROVEN]) {
      expect(plan(BELOW_TIP, source, sameHeight)).toMatchObject({
        action: "insert",
        replace: { hashes: ["0xstale"], descendantsAbove: null },
      });
    }
  });
});

describe("blocks already holding the incoming block's txs", () => {
  it("an active block at another height is deleted by a proven block", () => {
    for (const source of [LIVE_PROVEN, CATCHUP_PROVEN]) {
      expect(plan(BELOW_TIP, source, facts({ txOwners: [owner()] }))).toEqual({
        action: "insert",
        replace: null,
        deleteOwners: ["0x2c3d"],
      });
    }
  });

  it("an active block at another height makes any proposed block skip, with no writes", () => {
    for (const source of [LIVE_PROPOSED, CATCHUP_PROPOSED]) {
      expect(
        plan(BELOW_TIP, source, facts({ txOwners: [owner()] })),
      ).toMatchObject({ action: "skip" });
    }
  });

  it("an orphaned block is deleted only by a proven block", () => {
    const orphaned = facts({ txOwners: [owner({ isOrphaned: true })] });
    expect(plan(ABOVE_TIP, LIVE_PROPOSED, orphaned)).toMatchObject({
      action: "skip",
    });
    expect(plan(ABOVE_TIP, CATCHUP_PROVEN, orphaned)).toMatchObject({
      action: "insert",
      deleteOwners: ["0x2c3d"],
    });
  });

  it("a live block may delete the blocks its own replacement orphans", () => {
    // After a prune the new block at H re-includes txs of the old blocks at
    // H and above; those are orphaned by the replacement itself.
    const plannedFacts = facts({
      sameHeightActive: ["0xold-h"],
      txOwners: [
        owner({ blockHash: "0xold-h", blockHeight: ABOVE_TIP }),
        owner({
          txHash: "0xabcd",
          blockHash: "0xold-h+1",
          blockHeight: ABOVE_TIP + 1n,
        }),
      ],
    });
    expect(plan(ABOVE_TIP, LIVE_PROPOSED, plannedFacts)).toEqual({
      action: "insert",
      replace: { hashes: ["0xold-h"], descendantsAbove: ABOVE_TIP },
      deleteOwners: ["0xold-h", "0xold-h+1"],
    });
  });

  it("but not a holder the replacement does not orphan (other rollup version)", () => {
    const plannedFacts = facts({
      sameHeightActive: ["0xold-h"],
      txOwners: [owner({ blockHeight: ABOVE_TIP + 1n, rollupVersion: 1 })],
    });
    expect(plan(ABOVE_TIP, LIVE_PROPOSED, plannedFacts)).toMatchObject({
      action: "skip",
    });
  });
});

describe("an orphaned copy of the incoming block", () => {
  const orphanedCopy = facts({ existing: { isOrphaned: true } });

  it("is reactivated by a proven block", () => {
    expect(plan(BELOW_TIP, CATCHUP_PROVEN, orphanedCopy)).toEqual({
      action: "unOrphan",
      replace: null,
    });
  });

  it("is reactivated by a live block at an unproven, empty height", () => {
    expect(plan(ABOVE_TIP, LIVE_PROPOSED, orphanedCopy)).toEqual({
      action: "unOrphan",
      replace: null,
    });
  });

  it.each([
    ["a proposed catch-up", ABOVE_TIP, CATCHUP_PROPOSED, orphanedCopy],
    ["a live block at a proven height", BELOW_TIP, LIVE_PROPOSED, orphanedCopy],
    [
      "a live block while another block is active there",
      ABOVE_TIP,
      LIVE_PROPOSED,
      facts({ existing: { isOrphaned: true }, sameHeightActive: ["0xother"] }),
    ],
  ])("is not reactivated by %s", (_name, height, source, f) => {
    expect(plan(height, source, f)).toMatchObject({ action: "skip" });
  });

  it("is reactivated by a proven block that replaces the active block there", () => {
    expect(
      plan(
        BELOW_TIP,
        LIVE_PROVEN,
        facts({
          existing: { isOrphaned: true },
          sameHeightActive: ["0xother"],
        }),
      ),
    ).toEqual({
      action: "unOrphan",
      replace: { hashes: ["0xother"], descendantsAbove: null },
    });
  });
});

describe("unknown proven tip", () => {
  it("treats every height as unproven", () => {
    expect(
      plan(
        BELOW_TIP,
        LIVE_PROPOSED,
        facts({ provenTip: 0, sameHeightActive: ["0xstale"] }),
      ),
    ).toMatchObject({ action: "insert", replace: { hashes: ["0xstale"] } });
  });
});
