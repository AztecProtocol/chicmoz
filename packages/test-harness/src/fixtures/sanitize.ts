import { isIP } from "node:net";

/** The only ENR a fixture may hold: a real ENR encodes the node's IP address. */
export const REDACTED_ENR = "enr:-redacted";
export const REDACTED_HOST = "rpc.example";
const DOC_IPV4 = "192.0.2.1";
const DOC_IPV6 = "2001:db8::1";

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", REDACTED_HOST]);
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const ENR_PATTERN = /enr:-[A-Za-z0-9_-]+/g;
const SHARED_KEY_SEGMENT = "temporary-api-key";
const SAFE_KEY = /^[A-Za-z0-9_$]{1,64}$/;
// A cloud host name spells its private address ("ip-10-0-0-5"), a private-zone name an internal host;
// a home path names a machine's user.
const HOST_IDENTITY = [
  /\bip-\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}\b/,
  /\b[a-z0-9-]+\.(internal|local|localdomain|lan|corp|home)\b/i,
  /\/(home|mnt|Users)\//,
];
const SECRET_LAST_WORD = new Set(["secret", "password", "passphrase", "mnemonic"]);
const SECRET_LAST_PAIR = new Set(["api key", "private key", "access token", "auth token", "refresh token"]);
const QUERY_PARAM = /[?&]([^=&#\s]+)=/g;
const SECRET_SEGMENT = /(^|[-_])(api[-_]?key|secret|password|private[-_]?key|mnemonic)([-_]|$)/i;

const decoded = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// A separated secret word anywhere (`api_key_value`), or a camelCase one last
// (`clientSecret`); `secretHash` is neither.
export const isSecretName = (name: string): boolean => {
  if (SECRET_SEGMENT.test(name)) {
    return true;
  }
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const last = words[words.length - 1] ?? "";
  return (
    SECRET_LAST_WORD.has(last) ||
    SECRET_LAST_PAIR.has(words.slice(-2).join(" ")) ||
    last === "apikey"
  );
};

const isAllowedIp = (ip: string): boolean => {
  const version = isIP(ip);
  if (version === 6) {
    const lower = ip.toLowerCase();
    return lower === "::1" || lower.startsWith("2001:db8:");
  }
  return (
    version === 4 &&
    (
    ip.startsWith("127.") ||
    ip === "0.0.0.0" ||
    ip.startsWith("192.0.2.") ||
    ip.startsWith("198.51.100.") ||
    ip.startsWith("203.0.113."))
  );
};

// Hex and "::" appear in ordinary text ("dep::aztec" yields "::a"), so an IPv6
// needs two non-empty groups; an IPv4 with a port is split again on ":", and
// one ending a sentence loses its period.
const ipTokens = (s: string): string[] =>
  s.split(/[^0-9a-fA-F:.]+/).flatMap((raw) => {
    const t = raw.replace(/^\.+|\.+$/g, "");
    if (isIP(t) === 4) {
      return [t];
    }
    if (isIP(t) === 6) {
      return t.split(":").filter(Boolean).length >= 2 ? [t] : [];
    }
    return t.includes(".") ? t.split(":").filter((p) => isIP(p) === 4) : [];
  });

// undefined for an unparseable URL or one carrying credentials: neither is publishable.
const urlHost = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    return parsed.username || parsed.password
      ? undefined
      : parsed.host.replace(/:\d+$/, "");
  } catch {
    return undefined;
  }
};

const isAllowedHost = (host: string): boolean =>
  ALLOWED_HOSTS.has(host) ||
  host.endsWith(".example") ||
  isAllowedIp(host.replace(/^\[|\]$/g, ""));

const sanitizeString = (s: string): string => {
  const withoutEnrs = s.replace(ENR_PATTERN, REDACTED_ENR);
  // Only scheme and host survive: a path or query can carry a key.
  const withoutUrls = withoutEnrs.replace(URL_PATTERN, (url) => {
    const host = urlHost(url);
    return host !== undefined && isAllowedHost(host)
      ? new URL(url).origin
      : `http://${REDACTED_HOST}`;
  });
  return ipTokens(withoutUrls).reduce(
    (acc, ip) =>
      isAllowedIp(ip)
        ? acc
        : acc.split(ip).join(isIP(ip) === 6 ? DOC_IPV6 : DOC_IPV4),
    withoutUrls,
  );
};

// Bytes, dates and class instances are leaves: walking them would turn them into `{}`.
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null);

/**
 * Copy of `value` that is safe to commit: ENRs replaced, IPs outside loopback
 * and the documentation ranges replaced, URLs to other hosts replaced whole
 * (their path may carry a key), and secret-named keys dropped. Host names and
 * home paths are not rewritten; {@link findLeaks} rejects them instead.
 */
export const sanitize = (value: unknown): unknown => {
  if (typeof value === "string") {
    return sanitizeString(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !isSecretName(k))
        .map(([k, v]) => [sanitizeString(k), sanitize(v)]),
    );
  }
  return value;
};

export type Leak = { path: string; reason: string };

const stringLeaks = (value: string, path: string, identity: readonly string[]): Leak[] => {
  const reasons: string[] = [];
  if ((value.match(ENR_PATTERN) ?? []).some((enr) => enr !== REDACTED_ENR)) {
    reasons.push("ENR record");
  }
  if (value.includes(SHARED_KEY_SEGMENT)) {
    reasons.push("shared API key path");
  }
  for (const url of value.match(URL_PATTERN) ?? []) {
    const host = urlHost(url);
    if (host === undefined || !isAllowedHost(host)) {
      reasons.push("URL to a host outside the allowlist");
    } else if (url !== new URL(url).origin) {
      reasons.push("URL with a path or query");
    }
  }
  if ([...value.matchAll(QUERY_PARAM)].some(([, name]) => isSecretName(decoded(name ?? "")))) {
    reasons.push("secret-named query parameter");
  }
  if (ipTokens(value).some((ip) => !isAllowedIp(ip))) {
    reasons.push("IP address");
  }
  if (HOST_IDENTITY.some((p) => p.test(value)) || identity.some((id) => value.includes(id))) {
    reasons.push("host name or local path");
  }
  return reasons.map((reason) => ({ path, reason }));
};

/**
 * Everything in a parsed fixture that must not be published: what
 * {@link sanitize} would change, the shared key's path segment, cloud host
 * names, home paths, and any of `identity` (the recording machine's host name,
 * user and paths). Reasons never quote the offending value, so a failing check
 * does not print it.
 */
export const findLeaks = (
  value: unknown,
  path = "$",
  identity: readonly string[] = [],
): Leak[] => {
  if (typeof value === "string") {
    return stringLeaks(value, path, identity);
  }
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findLeaks(v, `${path}[${i}]`, identity));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v], i) => {
      // Keys come from the recorded data too: one that is flagged or not a plain name is shown by position only.
      const flagged = isSecretName(k) || stringLeaks(k, "", identity).length > 0;
      const child = SAFE_KEY.test(k) && !flagged ? `${path}.${k}` : `${path}.<key ${i}>`;
      return [
        ...(isSecretName(k) ? [{ path: child, reason: "secret-named key" }] : []),
        ...stringLeaks(k, `${child} (key)`, identity),
        ...findLeaks(v, child, identity),
      ];
    });
  }
  return [];
};
