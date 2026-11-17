import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";

// A route behind the global JSON parser (64kb in the test app).
const path = `/l2/contract-classes/0x${"0".repeat(64)}/versions/1/verify-source`;
const body = { githubUrl: "https://github.com/example/repo" };

describe("request body parsing", () => {
  let api: ExplorerApiForTest;

  beforeAll(async () => {
    api = await startExplorerApiForTest();
  });

  afterAll(async () => {
    await api?.close();
  });

  it("hands a parsed JSON body to the route", async () => {
    const res = await api.request.post(path).send(body);
    // The class lookup runs only after the body passed validation.
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Contract class not found" });
  });

  it("rejects malformed JSON in the parser", async () => {
    const res = await api.request
      .post(path)
      .set("Content-Type", "application/json")
      .send('{"githubUrl":');
    // The error middleware has no case for parse errors; an unparsed body would fail validation with 400.
    expect(res.status).toBe(500);
  });

  it("rejects a JSON body over the limit", async () => {
    const res = await api.request
      .post(path)
      .send({ ...body, padding: "x".repeat(65 * 1024) });
    expect(res.status).toBe(413);
  });
});
