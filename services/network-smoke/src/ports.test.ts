import { describe, expect, it } from "vitest";
import { parseEphemeralFloor, parsePorts, portBelow } from "./ports.js";

describe("ports", () => {
  it("rejects a websocket health port that is not ws + 1", () => {
    expect(() =>
      parsePorts("20001,20002,20003,20004,20005,20006,20008"),
    ).toThrow("wsHealth must be ws + 1");
  });

  it("rejects a port given twice", () => {
    expect(() =>
      parsePorts("20001,20001,20003,20004,20005,20006,20007"),
    ).toThrow("distinct");
  });

  it("reads the ephemeral floor, and ignores one that leaves no room below it", () => {
    expect(parseEphemeralFloor("32768\t60999\n")).toBe(32768);
    expect(parseEphemeralFloor("10005\t60999\n")).toBeUndefined();
  });

  it("keeps every port of a span inside 10000 and below the floor", () => {
    expect(portBelow(32768, 2, () => 0)).toBe(10_000);
    // The highest draw leaves room for ws + 1 below the floor.
    expect(portBelow(32768, 2, () => 0.999_999_9)).toBe(32766);
  });
});
