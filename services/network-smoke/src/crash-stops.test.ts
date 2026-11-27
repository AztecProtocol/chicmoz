import { describe, expect, it } from "vitest";
import { apiStateAtStop, killService, stopHold } from "./crash-stops.js";

describe("killing a stopped service", () => {
  const stopped = ({
    kill = () => Promise.resolve(),
    endSessions = () => Promise.resolve([]),
  }: {
    kill?: () => Promise<void>;
    endSessions?: () => Promise<number[]>;
  }) => {
    const calls: string[] = [];
    const hold = stopHold({
      waiters: () => Promise.resolve([]),
      endSessions: (name) => {
        calls.push(`end the sessions of ${name}`);
        return endSessions();
      },
      release: () => {
        calls.push("release the lock");
        return Promise.resolve();
      },
    });
    const services = {
      kill: (name: string) => {
        calls.push(`kill ${name}`);
        return kill();
      },
    };
    return { hold, services, calls };
  };

  it("kills nothing past the stop's deadline, and otherwise ends the service's sessions after the kill", async () => {
    const { hold, services, calls } = stopped({});
    expect(
      await killService(hold, services, "explorer-api", Date.now() - 1),
    ).toMatch(/past its 15 s deadline, so explorer-api was not killed$/);
    expect(calls, "past the deadline").toEqual([]);
    expect(
      await killService(hold, services, "explorer-api", Date.now() + 60_000),
    ).toBeUndefined();
    await hold.release();
    expect(calls, "before it").toEqual([
      "kill explorer-api",
      "end the sessions of explorer-api",
      "release the lock",
    ]);
  });

  const failures: [string, Parameters<typeof stopped>[0]][] = [
    [
      "a failed kill",
      { kill: () => Promise.reject(new Error("kill explorer-api: 409")) },
    ],
    [
      "a failed cleanup",
      { endSessions: () => Promise.reject(new Error("Connection terminated")) },
    ],
    [
      "a cleanup that leaves a session",
      { endSessions: () => Promise.resolve([1700]) },
    ],
  ];

  it.each(failures)("keeps the lock held after %s", async (_, failing) => {
    const { hold, services, calls } = stopped(failing);
    await expect(
      killService(hold, services, "explorer-api", Date.now() + 60_000),
    ).rejects.toThrow("the lock stays held");
    await hold.release();
    expect(calls).not.toContain("release the lock");
    expect(hold.kept()).toBeDefined();
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
