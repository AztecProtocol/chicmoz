import { canonicalJson } from "@chicmoz/test-harness";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type Spec = {
  paths: Record<
    string,
    Record<
      string,
      {
        requestBody?: { content?: Record<string, { schema?: unknown }> };
        responses?: Record<
          string,
          { content?: Record<string, { schema?: unknown }> }
        >;
      }
    >
  >;
};

// A media entry without a schema documents nothing, like `{}`.
const isEmptySchema = (schema: unknown) =>
  schema === undefined ||
  schema === null ||
  (typeof schema === "object" && Object.keys(schema).length === 0);

const emptyTopLevelSchemas = (spec: Spec) => {
  const found: string[] = [];
  for (const [path, operations] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(operations)) {
      for (const media of Object.values(op.requestBody?.content ?? {})) {
        if (isEmptySchema(media.schema)) {
          found.push(`${method.toUpperCase()} ${path} requestBody`);
        }
      }
      for (const [status, response] of Object.entries(op.responses ?? {})) {
        for (const media of Object.values(response.content ?? {})) {
          if (isEmptySchema(media.schema)) {
            found.push(`${method.toUpperCase()} ${path} ${status}`);
          }
        }
      }
    }
  }
  return found.sort();
};

describe("OpenAPI document", () => {
  let spec: Spec;

  beforeAll(async () => {
    // Schema defaults that call Date.now() are evaluated into the document,
    // and NODE_ENV is read when @chicmoz-pkg/types is first imported.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 0, 1) });
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_API_KEY", "dev-api-key");
    vi.stubEnv("VERSION_STRING", "SNAPSHOT");
    vi.stubEnv("L2_NETWORK_ID", "SANDBOX");
    const { genereateOpenApiSpec } = await import(
      "../../src/svcs/http-server/open-api-spec.js"
    );
    // The route serves the document through res.json().
    spec = JSON.parse(JSON.stringify(genereateOpenApiSpec())) as Spec;
  });

  afterAll(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("matches the committed document under production settings", async () => {
    await expect(canonicalJson(spec)).toMatchFileSnapshot(
      "__snapshots__/open-api-spec.json.snap",
    );
  });

  it("gives every request and response body a non-empty schema", () => {
    expect(emptyTopLevelSchemas(spec)).toEqual([]);
  });

  // A failed generation is logged and replaced by a non-empty placeholder.
  it("documents every response without the generation fallback", () => {
    expect(JSON.stringify(spec)).not.toContain("Schema generation failed");
  });
});
