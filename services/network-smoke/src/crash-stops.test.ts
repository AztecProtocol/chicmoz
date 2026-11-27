import { describe, expect, it } from "vitest";
import { apiStateAtStop, killService } from "./crash-stops.js";

describe("killing a stopped service", () => {
  it("kills nothing past the stop's deadline, and otherwise ends the service's sessions after the kill", async () => {
    const calls: string[] = [];
    const lock = {
      endSessions: (name: string) => {
        calls.push(`end the sessions of ${name}`);
        return Promise.resolve();
      },
    };
    const services = {
      kill: (name: string) => {
        calls.push(`kill ${name}`);
        return Promise.resolve();
      },
    };
    expect(
      await killService(lock, services, "explorer-api", Date.now() - 1),
    ).toMatch(/past its 15 s deadline, so explorer-api was not killed$/);
    expect(calls, "past the deadline").toEqual([]);
    expect(
      await killService(lock, services, "explorer-api", Date.now() + 60_000),
    ).toBeUndefined();
    expect(calls, "before it").toEqual([
      "kill explorer-api",
      "end the sessions of explorer-api",
    ]);
  });
});

describe("the API's state at its stop", () => {
  const atStop = {
    canonical: { replacing: true, dead: [false, false] },
    sent: [{ partition: 1, from: 32, to: 33 }],
    committed: { blockHandler: [32] },
  };

  it("is the kill's only while the block group itself, and no other, is before the record", () => {
    expect(apiStateAtStop(atStop, 2), "the block group before it").toBe(true);
    expect(
      apiStateAtStop({ ...atStop, committed: { renamedHandler: [32] } }, 2),
      "another group in its place",
    ).toBe(false);
    expect(
      apiStateAtStop(
        { ...atStop, committed: { blockHandler: [32], otherHandler: [32] } },
        2,
      ),
      "a second group on the partition",
    ).toBe(false);
    expect(
      apiStateAtStop({ ...atStop, committed: { blockHandler: [33] } }, 2),
      "the block group past it",
    ).toBe(false);
  });
});
