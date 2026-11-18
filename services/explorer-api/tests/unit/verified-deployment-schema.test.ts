import { generateSchema } from "@anatine/zod-openapi";
import {
  CONSTRUCTOR_ARGS_MAX,
  chicmozL2ContractInstanceVerifiedDeploymentArgumentsSchema,
} from "@chicmoz-pkg/types";
import { describe, expect, it } from "vitest";

const constructorArgs =
  chicmozL2ContractInstanceVerifiedDeploymentArgumentsSchema.shape
    .constructorArgs;

describe("verified deployment constructorArgs", () => {
  it("rejects an oversized array with the max issue first and a bounded issue count", () => {
    const result = constructorArgs.safeParse(
      Array<number>(CONSTRUCTOR_ARGS_MAX * 4).fill(0),
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe("too_big");
    expect(result.error?.issues.length).toBeLessThanOrEqual(
      CONSTRUCTOR_ARGS_MAX + 2,
    );
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
    expect(generateSchema(constructorArgs)).toStrictEqual({
      type: ["array"],
      items: { type: ["string"] },
      maxItems: CONSTRUCTOR_ARGS_MAX,
    });
  });
});
