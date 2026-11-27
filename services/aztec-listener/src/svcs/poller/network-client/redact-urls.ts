import { AZTEC_RPC_URLS } from "../../../environment.js";

// A node's URL can carry a key in its userinfo, path or query. The last
// character class keeps a trailing colon or period out of the match. Node
// prints an ES module's stack frames as file URLs, which name no node.
const URL_PATTERN =
  /\b(?!file:)[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*[^\s"'<>.,:;)]/gi;

// Below this, a path segment or query value is redacted only as part of its
// URL, so a segment like `v1` does not blank every line.
const MIN_PART = 8;

const decoded = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

// The pattern stops at an apostrophe, which a path can hold, and an error can
// name any one part of a URL alone.
const partsOf = (configured: string) => {
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return [configured];
  }
  const { href, host, hostname, pathname, search, username, password } = url;
  const pieces = [
    ...pathname.split("/"),
    ...search
      .slice(1)
      .split("&")
      .map((p) => p.slice(p.indexOf("=") + 1)),
    ...url.searchParams.values(),
  ]
    .flatMap((p) => [p, decoded(p)])
    .filter((p) => p.length >= MIN_PART);
  return [
    configured,
    href,
    host,
    hostname,
    pathname.length > 1 ? pathname : "",
    search,
    username,
    decoded(username),
    password,
    decoded(password),
    ...pieces,
  ];
};

/**
 * Replaces with `<url>` each part of the `configured` URLs, longest first,
 * then any other URL but a file URL.
 */
export const urlRedactor = (configured: string[]) => {
  const parts = [...new Set(configured.flatMap(partsOf))]
    .filter((p) => p.length > 0)
    .sort((a, b) => b.length - a.length);
  // Case-sensitive, so a host such as `gateway` leaves the offline marker
  // `Bad Gateway` whole. An error names a part as configured or as `URL`
  // normalized it, and `parts` holds both.
  const exact =
    parts.length === 0
      ? undefined
      : new RegExp(
          parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
          "g",
        );
  return (text: string) =>
    (exact === undefined ? text : text.replace(exact, "<url>")).replace(
      URL_PATTERN,
      "<url>",
    );
};

/** `text` with the node pool's URLs and any other URL but a file URL redacted. */
export const redactUrls = urlRedactor(AZTEC_RPC_URLS.map(({ url }) => url));

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
