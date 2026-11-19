import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";

describe("request validation errors", () => {
  let api: ExplorerApiForTest;

  beforeAll(async () => {
    api = await startExplorerApiForTest();
  });

  afterAll(async () => {
    await api?.close();
  });

  // A number bound: an issue carrying a bigint bound cannot be serialized.
  it("answers 400 with the schema error envelope and its issues", async () => {
    const res = await api.request.get(
      "/l1/contract-events/hourly-counts?hours=0",
    );

    expect({ status: res.status, body: res.body as unknown }).toEqual({
      status: 400,
      body: {
        message: "Schema validation error",
        errors: [
          {
            code: "too_small",
            exact: false,
            inclusive: true,
            message: "Number must be greater than or equal to 1",
            minimum: 1,
            path: ["query", "hours"],
            type: "number",
          },
        ],
      },
    });
  });
});
