const GITHUB_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "www.github.com",
]);

/** Hosts a governance proposal's forum link may point to. */
export const GOVERNANCE_FORUM_HOSTS: ReadonlySet<string> = new Set([
  "forum.aztec.network",
  "gov.aztec.network",
]);

// Owner and repo use GitHub's own name alphabets, so they are safe to put
// back into an API path.
const GITHUB_PR_PATH =
  /^\/([A-Za-z0-9-]{1,39})\/([\w.-]{1,100})\/pull\/([1-9]\d{0,9})(?:\/.*)?$/;

export type GovernanceGithubPrRef = {
  org: string;
  repo: string;
  number: number;
  /** Canonical `https://github.com/<org>/<repo>/pull/<number>`. */
  url: string;
};

const parseHttpsUrl = (value: string): URL | null => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "https:" ? url : null;
};

/**
 * The normalized href of `value` when it is an https URL whose hostname is
 * exactly one of {@link GOVERNANCE_FORUM_HOSTS}; null otherwise.
 */
export const parseGovernanceForumUrl = (value: string): string | null => {
  const url = parseHttpsUrl(value);
  return url && GOVERNANCE_FORUM_HOSTS.has(url.hostname) ? url.href : null;
};

/**
 * The pull request `value` names when it is an https github.com URL whose path
 * starts `/<org>/<repo>/pull/<number>`; null otherwise.
 */
export const parseGithubPrUrl = (
  value: string,
): GovernanceGithubPrRef | null => {
  const url = parseHttpsUrl(value);
  if (!url || !GITHUB_HOSTS.has(url.hostname)) {
    return null;
  }
  const match = GITHUB_PR_PATH.exec(url.pathname);
  if (!match) {
    return null;
  }
  const [, org, repo, number] = match;
  return {
    org,
    repo,
    number: Number(number),
    url: `https://github.com/${org}/${repo}/pull/${number}`,
  };
};
