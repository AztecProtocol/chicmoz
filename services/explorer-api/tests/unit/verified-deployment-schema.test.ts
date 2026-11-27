import {
  CONSTRUCTOR_ARGS_MAX,
  chicmozL2ContractInstanceVerifiedDeploymentArgumentsSchema,
} from "@chicmoz-pkg/types";
import { describe, expect, it } from "vitest";
import { toOpenApiSchema } from "../../src/svcs/http-server/routes/controllers/utils/openapi-schema.js";

const constructorArgs =
  chicmozL2ContractInstanceVerifiedDeploymentArgumentsSchema.shape
    .constructorArgs;

describe("verified deployment constructorArgs", () => {
  it("rejects an oversized array with the max issue first and a bounded issue count", () => {
    const result = constructorArgs.safeParse(Array<number>(100_000).fill(0));

    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.code).toBe("too_big");
  });

  it("refuses an oversized array without reading any element", () => {
    let reads = 0;
    const count = (key: string | symbol) => {
      if (typeof key === "string" && /^\d+$/.test(key)) {
        reads++;
      }
    };
    const args = new Proxy(Array<string>(CONSTRUCTOR_ARGS_MAX + 1).fill("1"), {
      get: (target, key, receiver) => {
        count(key);
        return Reflect.get(target, key, receiver) as unknown;
      },
      getOwnPropertyDescriptor: (target, key) => {
        count(key);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    expect(constructorArgs.safeParse(args).success).toBe(false);
    expect(reads).toBe(0);
  });

  it("accepts up to the cap and parses to string[]", () => {
    expect(constructorArgs.parse(["0x1", "2"])).toEqual(["0x1", "2"]);
    expect(
      constructorArgs.safeParse(Array<string>(CONSTRUCTOR_ARGS_MAX).fill("1"))
        .success,
    ).toBe(true);
    expect(
      constructorArgs.safeParse(
        Array<string>(CONSTRUCTOR_ARGS_MAX + 1).fill("1"),
      ).success,
    ).toBe(false);
  });

  it("documents an array of strings with maxItems in OpenAPI", () => {
    expect(toOpenApiSchema(constructorArgs, "input")).toStrictEqual({
      type: "array",
      items: { type: "string" },
      maxItems: CONSTRUCTOR_ARGS_MAX,
    });
  });
});
