import { Long } from "bson";

/**
 * Canonical form for characterization snapshots: plain JSON with sorted keys,
 * so a snapshot compares values across library versions rather than object
 * identity or key order. Values JSON cannot hold are tagged:
 * `{"$bigint": "<decimal>"}`, `{"$date": "<ISO>"}`, `{"$hex": "<hex>"}` (Buffer
 * and Uint8Array), `{"$long": "<decimal>"}` (signed BSON Long),
 * `{"$number": "NaN"}` (non-finite numbers and -0) and `{"$undefined": true}`
 * for a key present with the value `undefined`, which keeps it distinct from
 * an absent key.
 *
 * Anything else that is not plain data (class instances, functions, symbols,
 * other BSON types, sparse arrays, unsigned Longs) throws, so no value reaches
 * a snapshot in a lossy form.
 */

export type Canonical =
  | null
  | boolean
  | number
  | string
  | Canonical[]
  | { [key: string]: Canonical };

export type CanonicalOptions = {
  /**
   * Keys whose values the database fills (`defaultNow()`, `NOW()`), at any
   * depth: each must hold a valid time (Date, ISO 8601 string or epoch
   * milliseconds) and becomes `{"$dbtime": true}`.
   */
  dbTimeKeys?: readonly string[];
};

const TAGS = new Set([
  "$bigint",
  "$date",
  "$hex",
  "$long",
  "$number",
  "$undefined",
  "$dbtime",
  "$fails",
]);

const ISO_8601 = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}/;

// Date.parse rolls an impossible day ("2026-02-30") into the next month.
const isCalendarDate = (y: number, m: number, d: number) => {
  const day = new Date(Date.UTC(y, m - 1, d));
  return (
    day.getUTCFullYear() === y &&
    day.getUTCMonth() === m - 1 &&
    day.getUTCDate() === d
  );
};

const isValidTime = (value: unknown): boolean => {
  if (value instanceof Date) {
    return !Number.isNaN(value.getTime());
  }
  if (typeof value === "string") {
    const ymd = ISO_8601.exec(value);
    return (
      ymd !== null &&
      isCalendarDate(Number(ymd[1]), Number(ymd[2]), Number(ymd[3])) &&
      !Number.isNaN(Date.parse(value))
    );
  }
  return typeof value === "number" && !Number.isNaN(new Date(value).getTime());
};

const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

const toCanonical = (
  value: unknown,
  dbTimeKeys: ReadonlySet<string>,
  path: string,
): Canonical => {
  if (value === undefined) {
    return { $undefined: true };
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (Object.is(value, -0)) {
      return { $number: "-0" };
    }
    return Number.isFinite(value) ? value : { $number: String(value) };
  }
  if (typeof value === "bigint") {
    return { $bigint: value.toString() };
  }
  if (typeof value !== "object") {
    throw new TypeError(`canonical: ${typeof value} at ${path || "<root>"}`);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError(`canonical: invalid Date at ${path || "<root>"}`);
    }
    return { $date: value.toISOString() };
  }
  if (value instanceof Uint8Array) {
    return { $hex: Buffer.from(value).toString("hex") };
  }
  if (value instanceof Long) {
    if (value.unsigned) {
      throw new TypeError(`canonical: unsigned Long at ${path || "<root>"}`);
    }
    return { $long: value.toString() };
  }
  if (Array.isArray(value)) {
    // Own keys must be exactly the indices: a hole and an extra key would
    // cancel out in a count.
    const keys = Object.keys(value);
    if (
      keys.length !== value.length ||
      keys.some((key, i) => key !== String(i))
    ) {
      throw new TypeError(
        `canonical: sparse array or extra keys at ${path || "<root>"}`,
      );
    }
    const items: Canonical[] = [];
    for (let i = 0; i < value.length; i++) {
      items.push(toCanonical(value[i], dbTimeKeys, `${path}/${i}`));
    }
    return items;
  }
  if (!isPlainObject(value)) {
    throw new TypeError(
      `canonical: ${String(value.constructor?.name)} at ${path || "<root>"}`,
    );
  }
  const out: Record<string, Canonical> = {};
  // defineProperty keeps an own "__proto__" key, which assignment would drop.
  const put = (key: string, item: Canonical) =>
    Object.defineProperty(out, key, {
      value: item,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  for (const key of Object.keys(value).sort()) {
    if (TAGS.has(key)) {
      throw new TypeError(
        `canonical: key ${key} collides with a tag at ${path || "<root>"}`,
      );
    }
    const item = (value as Record<string, unknown>)[key];
    if (dbTimeKeys.has(key)) {
      if (!isValidTime(item)) {
        throw new TypeError(`canonical: ${path}/${key} is not a valid time`);
      }
      put(key, { $dbtime: true });
      continue;
    }
    put(key, toCanonical(item, dbTimeKeys, `${path}/${key}`));
  }
  return out;
};

export const canonical = (
  value: unknown,
  options: CanonicalOptions = {},
): Canonical => toCanonical(value, new Set(options.dbTimeKeys ?? []), "");

/** The part of a zod schema's API `canonicalParse` uses, so any zod copy fits. */
export type SafeParser = {
  safeParse(input: unknown):
    | { success: true; data: unknown }
    | {
        success: false;
        error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }> };
      };
};

/**
 * Parses with `schema` and returns the canonical output, or
 * `{"$fails": [...]}` with the sorted, distinct first path segments of the
 * issues ("" for the root). Issue codes, messages and deeper paths are left
 * out because they differ by design between zod versions.
 */
export const canonicalParse = (
  schema: SafeParser,
  input: unknown,
  options: CanonicalOptions = {},
): Canonical => {
  const result = schema.safeParse(input);
  if (result.success) {
    return canonical(result.data, options);
  }
  const heads = new Set(
    result.error.issues.map((issue) => String(issue.path[0] ?? "")),
  );
  return { $fails: [...heads].sort() };
};

export const canonicalJson = (
  value: unknown,
  options: CanonicalOptions = {},
): string => `${JSON.stringify(canonical(value, options), null, 2)}\n`;
