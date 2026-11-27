import { setTimeout as sleep } from "node:timers/promises";
import {
  type PruneFacts,
  type ScriptStatus,
  type StateRead,
  prefixHandled,
} from "./script-control.js";

type Status = Pick<ScriptStatus, "current" | "stateReads">;

/** The scripted node's control port, as `scriptControl` reads it. */
export type StepControl = {
  status: () => Promise<Status>;
  step: () => Promise<{ current: number; at: number }>;
};

/** How a scenario paces its steps, in ms. */
export type StepTimes = {
  /** Before each step. */
  stepMs: number;
  /** The least each state of the shorter chain is held. */
  holdMs: number;
  /** The most it is held for a pass of the listener to handle it. */
  holdLimitMs: number;
  /** Between two reads of the node's status. */
  pollMs: number;
};

/** What `stepThrough` saw while the node served the shorter chain. */
export type ShortHold<V> = {
  /** When the node answered the listener's first read of the shorter tip; when it moved there, if no read came. */
  from: number;
  /** When the node left the shorter chain. */
  to?: number;
  /** `view` once the listener had read the shorter tip, and just before the node left it. */
  start: V;
  end?: V;
  /** States of the shorter chain that no pass of the listener handled. */
  unhandled: number[];
};

const isTipRead = (r: StateRead) => !("height" in r);

/**
 * Steps the node to the prune's last state; `beforePrune` runs before the
 * prune. Each state of the shorter chain is held until a pass of the listener
 * has handled it, or `holdLimitMs`, and for at least `holdMs`, so the scenario
 * plays the order it names. Returns what it saw of the shorter chain, if the
 * prune has one. Its window opens at the listener's first read of the shorter
 * tip, when the pass that read the old chain has ended and what it sent is
 * stamped before it.
 */
export const stepThrough = async <V>(
  control: StepControl,
  prune: PruneFacts,
  {
    beforePrune,
    view,
    times,
  }: {
    beforePrune: () => Promise<void>;
    view: () => Promise<V>;
    times: StepTimes;
  },
): Promise<ShortHold<V> | undefined> => {
  const target = prune.dead[0].height - 1;
  const lastShort = prune.pruneAt + prune.shorterSteps - 1;
  /** Reads the status until `found` finds something or `deadline` passes. */
  const until = async <T>(
    found: (s: Status) => T | undefined,
    deadline: number,
  ) => {
    for (;;) {
      const hit = found(await control.status());
      if (hit !== undefined || Date.now() >= deadline) {
        return hit;
      }
      await sleep(times.pollMs);
    }
  };
  let { current } = await control.status();
  let short: ShortHold<V> | undefined;
  while (current < prune.endAt) {
    await sleep(times.stepMs);
    if (current + 1 === prune.pruneAt) {
      await beforePrune();
    }
    if (short && current === lastShort) {
      short.end = await view();
    }
    const stepped = await control.step();
    current = stepped.current;
    if (short && current === lastShort + 1) {
      short.to = stepped.at;
    }
    if (current >= prune.pruneAt && current <= lastShort) {
      const steppedAt = Date.now();
      const deadline = steppedAt + times.holdLimitMs;
      const read = await until((s) => s.stateReads.find(isTipRead), deadline);
      short ??= {
        from: read?.at ?? stepped.at,
        start: await view(),
        unhandled: [],
      };
      const handled = await until(
        (s) => (prefixHandled(s.stateReads, target) ? true : undefined),
        deadline,
      );
      if (handled === undefined) {
        short.unhandled.push(current);
      }
      await sleep(Math.max(0, steppedAt + times.holdMs - Date.now()));
    }
  }
  return short;
};
