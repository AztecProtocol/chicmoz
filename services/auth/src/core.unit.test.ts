import { Logger } from "@chicmoz-pkg/logger-server";
import { describe, expect, test } from "vitest";
import { Core } from "./core.js";
import { DB } from "./database/db.js";
import { RateLimitDb } from "./database/rate-limit.js";

describe("core unit tests", () => {
  // extractApiKey touches none of the dependencies.
  const core = new Core({
    logger: {} as Logger,
    db: {} as DB,
    rateLimitDb: {} as RateLimitDb,
  });

  describe("extractApiKey", () => {
    test("success; multiple sub-paths", () => {
      const url = "/v1/4aedfbf7-4d0f-4033-9bc8-50443d5be2cd/latest/height";

      const [found, apiKey] = core.extractApiKey(url);
      expect(apiKey).toStrictEqual("4aedfbf7-4d0f-4033-9bc8-50443d5be2cd");
      expect(found).toStrictEqual(true);
    });

    test("success; no sub-path", () => {
      const url = "/v1/4aedfbf7-4d0f-4033-9bc8-50443d5be2cd/";

      const [found, apiKey] = core.extractApiKey(url);
      expect(apiKey).toStrictEqual("4aedfbf7-4d0f-4033-9bc8-50443d5be2cd");
      expect(found).toStrictEqual(true);
    });

    test("success; one sub-path", () => {
      const url = "/v1/4aedfbf7-4d0f-4033-9bc8-50443d5be2cd/latest";

      const [found, apiKey] = core.extractApiKey(url);
      expect(apiKey).toStrictEqual("4aedfbf7-4d0f-4033-9bc8-50443d5be2cd");
      expect(found).toStrictEqual(true);
    });

    test("success; no end slash", () => {
      const url = "/v1/4aedfbf7-4d0f-4033-9bc8-50443d5be2cd";

      const [found, apiKey] = core.extractApiKey(url);
      expect(apiKey).toStrictEqual("4aedfbf7-4d0f-4033-9bc8-50443d5be2cd");
      expect(found).toStrictEqual(true);
    });

    test("success; v1 in api key", () => {
      const url = "/v1/v1edfbv1-4d0f-4033-9bc8-50443d5be2v1/latest";

      const [found, apiKey] = core.extractApiKey(url);
      expect(apiKey).toStrictEqual("v1edfbv1-4d0f-4033-9bc8-50443d5be2v1");
      expect(found).toStrictEqual(true);
    });
  });
});
