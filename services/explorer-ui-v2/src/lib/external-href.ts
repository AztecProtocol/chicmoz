/**
 * `value` as a normalized href when it is an absolute http(s) URL; undefined
 * otherwise, so a stored link with any other scheme never reaches an `<a href>`.
 */
export const toExternalHref = (
  value: string | null | undefined,
): string | undefined => {
  if (!value) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  return url.protocol === "https:" || url.protocol === "http:"
    ? url.href
    : undefined;
};
