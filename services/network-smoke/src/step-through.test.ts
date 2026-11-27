import { describe, expect, it } from "vitest";
import { type PruneFacts, type StateRead } from "./script-control.js";
import { type StepTimes, stepThrough } from "./step-through.js";

// State 1 serves the shorter chain, tip 12, and state 2 the replacement.
const prune: PruneFacts = {
  pruneAt: 1,
  shorterSteps: 1,
  endAt: 2,
  dead: [13, 14, 15, 16].map((height) => ({ height, hash: `0x${height}` })),
  final: [],
  movedTx: { hash: "0x00", deadHeight: 14, finalHeight: 13 },
};

const TIPS: StateRead = { method: "getChainTips", at: 0 };
const block = (height: number): StateRead => ({
  method: "getBlock",
  height,
  at: 0,
});
const WALK = [block(16), block(15), block(14), block(13)];
const named = (reads: StateRead[]) =>
  reads.map((r) => ("height" in r ? r.height : r.method));

/**
 * A node whose listener makes `reads` in state 1, one more on each status
 * read, each stamped when it shows. Logs every status read, view and step.
 */
const fakeNode = (reads: StateRead[]) => {
  const log: { event: "status" | "view" | "step"; at: number }[] = [];
  let current = 0;
  let shown: StateRead[] = [];
  const control = {
    status: () => {
      log.push({ event: "status", at: Date.now() });
      const next = current === 1 ? reads[shown.length] : undefined;
      if (next) {
        shown = [...shown, { ...next, at: Date.now() }];
      }
      return Promise.resolve({ current, stateReads: shown });
    },
    step: () => {
      current++;
      shown = [];
      const at = Date.now();
      log.push({ event: "step", at });
      return Promise.resolve({ current, at });
    },
  };
  const view = () => {
    log.push({ event: "view", at: Date.now() });
    return Promise.resolve({ current, shown });
  };
  return { control, view, log };
};

const TIMES: StepTimes = {
  stepMs: 100,
  holdMs: 0,
  holdLimitMs: 5_000,
  pollMs: 1,
};

describe("stepping through a shorter chain", () => {
  it("opens its window at the listener's first tip read and closes it as the node moves on, after the next pass's walk", async () => {
    const reads = [TIPS, TIPS, ...WALK, TIPS, TIPS, TIPS, block(16)];
    const { control, view, log } = fakeNode(reads);
    const short = await stepThrough(control, prune, {
      beforePrune: () => Promise.resolve(),
      view,
      times: TIMES,
    });

    const [stepIn, stepOut] = log.filter((e) => e.event === "step");
    expect(
      short?.start,
      "the start view, once the listener read the tip",
    ).toEqual({
      current: 1,
      shown: [expect.objectContaining({ method: "getChainTips" })],
    });
    expect(short?.from, "the window opens at that read").toBe(
      short?.start.shown[0].at,
    );
    expect(short?.from).toBeGreaterThanOrEqual(stepIn.at);
    expect(
      named(short?.end?.shown ?? []),
      "the end view, after the next pass's walk",
    ).toEqual(named(reads));
    expect(short?.to, "the window closes as the node moves on").toBe(
      stepOut.at,
    );
    const beforeOut = log[log.indexOf(stepOut) - 1];
    expect(beforeOut.event, "nothing between the end view and the step").toBe(
      "view",
    );
    expect(stepOut.at - beforeOut.at).toBeLessThan(TIMES.stepMs / 2);
    expect(short?.unhandled).toEqual([]);
  });

  it("runs afterPrune once, while the node serves the prune's first state, and onEnd once at its last", async () => {
    const replacedAtOnce: PruneFacts = { ...prune, shorterSteps: 0, endAt: 3 };
    const { control, view } = fakeNode([]);
    const seenAt: number[] = [];
    const endedAt: number[] = [];
    await stepThrough(control, replacedAtOnce, {
      beforePrune: () => Promise.resolve(),
      afterPrune: async () => {
        seenAt.push((await control.status()).current);
      },
      onEnd: async () => {
        endedAt.push((await control.status()).current);
      },
      view,
      times: TIMES,
    });
    expect(seenAt).toEqual([replacedAtOnce.pruneAt]);
    expect(endedAt).toEqual([replacedAtOnce.endAt]);
  });

  it("runs onEnd when the step after beforePrune fails, and fails with that step's error", async () => {
    const { control, view } = fakeNode([]);
    const ran: string[] = [];
    const refused = new Error("step refused");
    await expect(
      stepThrough({ ...control, step: () => Promise.reject(refused) }, prune, {
        beforePrune: () => {
          ran.push("beforePrune");
          return Promise.resolve();
        },
        afterPrune: () => {
          ran.push("afterPrune");
          return Promise.resolve();
        },
        onEnd: () => {
          ran.push("onEnd");
          return Promise.resolve();
        },
        view,
        times: TIMES,
      }),
    ).rejects.toBe(refused);
    expect(ran).toEqual(["beforePrune", "onEnd"]);
  });

  it("names a state no pass handled once its hold runs out", async () => {
    const { control, view } = fakeNode(
      Array.from({ length: 1_000 }, () => TIPS),
    );
    const short = await stepThrough(control, prune, {
      beforePrune: () => Promise.resolve(),
      view,
      times: { ...TIMES, holdLimitMs: 200 },
    });
    expect(short?.unhandled).toEqual([1]);
    expect(short?.start.shown).toHaveLength(1);
  });
});
