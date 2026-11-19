import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";

// A route behind the global JSON parser (the production BODY_LIMIT).
const path = `/l2/contract-classes/0x${"0".repeat(64)}/versions/1/verify-source`;
const body = { githubUrl: "https://github.com/example/repo" };

// The approved ceilings, written out so that a raised limit fails here.
const BODY_LIMIT_BYTES = 64 * 1024;
const ARTIFACT_BODY_LIMIT_BYTES = 50 * 1024 * 1024;

const jsonOfSize = (pad: (filler: string) => unknown, bytes: number) => {
  const filler = "x".repeat(bytes - JSON.stringify(pad("")).length);
  const json = JSON.stringify(pad(filler));
  expect(Buffer.byteLength(json)).toBe(bytes);
  return json;
};
const verifiedDeploymentArguments = {
  salt: `0x${"ab".repeat(32)}`,
  deployer: `0x${"ab".repeat(32)}`,
  publicKeysString: "0x01",
  constructorArgs: [],
};

describe("request body parsing", () => {
  let api: ExplorerApiForTest;

  beforeAll(async () => {
    api = await startExplorerApiForTest();
  });

  afterAll(async () => {
    await api?.close();
  });

  const postJson = (route: string, json: string) =>
    api.request.post(route).set("Content-Type", "application/json").send(json);

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

  it("accepts a JSON body of exactly 64 KiB and refuses one byte more", async () => {
    const atLimit = await postJson(
      path,
      jsonOfSize((padding) => ({ ...body, padding }), BODY_LIMIT_BYTES),
    );
    const overLimit = await postJson(
      path,
      jsonOfSize((padding) => ({ ...body, padding }), BODY_LIMIT_BYTES + 1),
    );

    expect([atLimit.status, overLimit.status]).toEqual([404, 413]);
  });

  // At the limit a valid body passes validation (an unparsed one would get 400)
  // and the route finds no such entity.
  it.each<[string, string, (filler: string) => unknown]>([
    [
      "class artifact upload",
      `/l2/contract-classes/0x${randomBytes(32).toString("hex")}/versions/1`,
      (stringifiedArtifactJson) => ({ stringifiedArtifactJson }),
    ],
    [
      "deployment verification",
      `/l2/contract-instances/0x${randomBytes(32).toString("hex")}`,
      (stringifiedArtifactJson) => ({
        verifiedDeploymentArguments: {
          ...verifiedDeploymentArguments,
          stringifiedArtifactJson,
        },
      }),
    ],
  ])(
    "the %s route accepts a body of exactly 50 MiB and refuses one byte more",
    async (_, route, pad) => {
      const atLimit = await postJson(
        route,
        jsonOfSize(pad, ARTIFACT_BODY_LIMIT_BYTES),
      );
      const overLimit = await postJson(
        route,
        jsonOfSize(pad, ARTIFACT_BODY_LIMIT_BYTES + 1),
      );

      expect([atLimit.status, overLimit.status]).toEqual([404, 413]);
    },
  );
});
