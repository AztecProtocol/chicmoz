// A node's URL can carry a key in its userinfo, path or query. The last
// character class keeps a trailing colon or period out of the match. Node
// prints an ES module's stack frames as file URLs, which name no node.
const URL_PATTERN =
  /\b(?!file:)[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*[^\s"'<>.,:;)]/gi;

/** `text` with each URL replaced by `<url>`, but for a file URL. */
export const redactUrls = (text: string) => text.replace(URL_PATTERN, "<url>");

/**
 * `e` with the URLs in its message and stack redacted, in place, so that its
 * class stays; anything else thrown becomes an Error.
 */
export const redactError = (e: unknown): Error => {
  if (!(e instanceof Error)) {
    return new Error(redactUrls(String(e)));
  }
  e.message = redactUrls(e.message);
  if (e.stack !== undefined) {
    e.stack = redactUrls(e.stack);
  }
  return e;
};
