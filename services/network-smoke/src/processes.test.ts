import { describe, expect, it } from "vitest";
import { carriesMarker, ownerAlive, pgrpOf } from "./processes.js";

describe("run ownership", () => {
  it("reads the process group past a comm holding spaces and parentheses", () => {
    expect(pgrpOf("4242 (node (vitest 1)) S 4000 4100 4100 0 -1")).toBe(4100);
  });

  it("refuses a process without this run's exact marker", () => {
    const run = "ns0123456789";
    expect(carriesMarker(`PATH=/bin\0NETWORK_SMOKE_RUN=${run}\0`, run)).toBe(
      true,
    );
    expect(carriesMarker("PATH=/bin\0", run)).toBe(false);
    expect(
      carriesMarker(`NETWORK_SMOKE_RUN=${run}0\0`, run),
      "another run whose id starts with this one",
    ).toBe(false);
  });

  it("treats a reused owner pid as a dead owner", () => {
    const owner = { ownerPid: 4242, ownerStart: "1000" };
    expect(ownerAlive(owner, () => "1000")).toBe(true);
    expect(ownerAlive(owner, () => "2000")).toBe(false);
    expect(ownerAlive(owner, () => undefined)).toBe(false);
  });
});
