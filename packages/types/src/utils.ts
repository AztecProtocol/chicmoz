/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from "zod";

// Utility function to recursively apply .partial() to a Zod schema
export function deepPartial(schema: z.ZodType<any, any>): z.ZodType<any, any> {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const newShape: Record<string, z.ZodType<any, any>> = {};

    for (const key in shape) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      newShape[key] = deepPartial(shape[key]);
    }

    return z.object(newShape).partial();
  } else if (schema instanceof z.ZodArray) {
    return z.array(deepPartial(schema.element as z.ZodType));
  } else if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable
  ) {
    return deepPartial(schema.unwrap() as z.ZodType).optional();
  } else {
    return schema.optional();
  }
}
