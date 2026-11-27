import { describe, expect, it } from "vitest";
import { serviceControl, startServiceControl } from "./service-control.js";

/** Records each action it is asked for. */
const recorded = () => {
  const calls: string[] = [];
  const record = (action: string) => (name: string) => {
    calls.push(`${action} ${name}`);
    return Promise.resolve();
  };
  return { calls, actions: { kill: record("kill"), start: record("start") } };
};

describe("the runner's service control", () => {
  it("kills and restarts only the run's services, and never starts one that runs", async () => {
    const { calls, actions } = recorded();
    const control = await startServiceControl({
      port: 0,
      names: ["aztec-listener"],
      actions,
      signal: new AbortController().signal,
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

  it("refuses every action once the run tears down, on a control started after that too", async () => {
    const { calls, actions } = recorded();
    const teardown = new AbortController();
    const start = () =>
      startServiceControl({
        port: 0,
        names: ["aztec-listener"],
        actions,
        signal: teardown.signal,
      });
    const control = await start();
    try {
      await serviceControl(control.url).kill("aztec-listener");
      teardown.abort();
      await expect(
        serviceControl(control.url).start("aztec-listener"),
      ).rejects.toThrow();
      const late = await start();
      try {
        await expect(
          serviceControl(late.url).kill("aztec-listener"),
        ).rejects.toThrow("409 the run is tearing down");
      } finally {
        await late.close();
      }
      expect(calls).toEqual(["kill aztec-listener"]);
    } finally {
      await control.close();
    }
  });
});
