import { describe, expect, it } from "vitest";
import { settle } from "./explorer-reads.js";

/** Reads that count up to the expected state 3 and stay there, or never reach it. */
const steps = (reaches: boolean) => {
  const log: string[] = [];
  let reads = 0;
  const run = settle(
    () => {
      reads++;
      log.push(`read ${reads}`);
      return Promise.resolve({ state: reaches ? Math.min(reads, 3) : 0 });
    },
    {
      want: { state: 3 },
      timeoutMs: 200,
      intervalMs: 20,
      cacheMs: 10,
      consumedThrough: () => {
        log.push("consumed");
        return Promise.resolve();
      },
    },
  );
  return { log, run };
};

describe("settle", () => {
  it("waits for the expected state, then for the consumers, then reads once more", async () => {
    const { log, run } = steps(true);
    expect(await run).toEqual({ value: { state: 3 }, met: true, held: true });
    expect(log).toEqual(["read 1", "read 2", "read 3", "consumed", "read 4"]);
  });

  it("still waits for the consumers and reads once more when the expected state never shows", async () => {
    const { log, run } = steps(false);
    expect(await run).toEqual({ value: { state: 0 }, met: false, held: false });
    expect(log.length, "reads until the time ran out").toBeGreaterThan(3);
    expect(log.slice(-2)).toEqual(["consumed", `read ${log.length - 1}`]);
  });
});
