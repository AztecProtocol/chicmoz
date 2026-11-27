import { describe, expect, it } from "vitest";
import { serviceControl, startServiceControl } from "./service-control.js";

describe("the runner's service control", () => {
  it("kills and restarts only the run's services, and never starts one that runs", async () => {
    const calls: string[] = [];
    const control = await startServiceControl({
      port: 0,
      names: ["aztec-listener"],
      actions: {
        kill: (name) => {
          calls.push(`kill ${name}`);
          return Promise.resolve();
        },
        start: (name) => {
          calls.push(`start ${name}`);
          return Promise.resolve();
        },
      },
    });
    const services = serviceControl(control.url);
    try {
      await expect(services.start("aztec-listener")).rejects.toThrow(
        "kill it before starting it again",
      );
      await expect(services.kill("explorer-api")).rejects.toThrow("404");
      await services.kill("aztec-listener");
      await services.start("aztec-listener");
      await expect(services.start("aztec-listener")).rejects.toThrow("409");
      expect(calls).toEqual(["kill aztec-listener", "start aztec-listener"]);
    } finally {
      await control.close();
    }
  });
});
