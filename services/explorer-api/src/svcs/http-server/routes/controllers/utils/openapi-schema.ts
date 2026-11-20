import { type SchemaObject } from "openapi3-ts/oas31";
import { z } from "zod";

type Override = NonNullable<z.core.ToJSONSchemaParams["override"]>;

const baseParams = {
  // OpenAPI 3.1 schema objects are JSON Schema draft 2020-12.
  target: "draft-2020-12",
  // A z.custom() or a transform output has no JSON Schema; it is documented as {}.
  unrepresentable: "any",
} as const;

// Keeps what the document has always said: dates and bigints as their wire
// formats, a transformed field as the input it accepts, and response objects
// open to new fields.
const keepDocumentedMeaning =
  (io: "input" | "output"): Override =>
  ({ zodSchema, jsonSchema }) => {
    const def = zodSchema._zod.def;
    if (def.type === "date") {
      jsonSchema.type = "string";
      jsonSchema.format = "date-time";
    }
    if (def.type === "bigint") {
      jsonSchema.type = "integer";
      jsonSchema.format = "int64";
    }
    // The output side of a transform is {} plus the pipe's own metadata.
    if (
      io === "output" &&
      def.type === "pipe" &&
      def.out._zod.def.type === "transform"
    ) {
      Object.assign(jsonSchema, {
        ...toJsonSchema(def.in, "input"),
        ...jsonSchema,
      });
    }
    // Output mode closes every stripping object; only .strict() refuses extra keys.
    if (
      def.type === "object" &&
      def.catchall === undefined &&
      jsonSchema.additionalProperties === false
    ) {
      delete jsonSchema.additionalProperties;
    }
    // Not a JSON Schema format; the pattern zod emits beside it carries the rule.
    if (jsonSchema.format === "starts_with") {
      delete jsonSchema.format;
    }
  };

const toJsonSchema = (
  schema: z.core.$ZodType,
  io: "input" | "output",
): z.core.JSONSchema.BaseSchema => {
  const jsonSchema = z.toJSONSchema(schema, {
    ...baseParams,
    io,
    override: keepDocumentedMeaning(io),
  });
  delete jsonSchema.$schema;
  return jsonSchema;
};

/**
 * OpenAPI 3.1 schema object for a zod schema's request ("input") or response
 * ("output") side. Throws when the result holds a `$ref` or `$defs` (from a
 * `.meta({ id })` or a recursive schema): embedded in the document, `#` would
 * point at the document root.
 */
export const toOpenApiSchema = (
  schema: z.ZodType,
  io: "input" | "output",
): SchemaObject => {
  const jsonSchema = toJsonSchema(schema, io);
  if (/"\$(ref|defs)":/.test(JSON.stringify(jsonSchema))) {
    throw new Error("OpenAPI schema holds a reference it cannot resolve");
  }
  return jsonSchema as SchemaObject;
};
