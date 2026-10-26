export const normalizeUrl = (url: string): string => {
  const trimmed = url.trim();
  const fixedSingleSlashScheme = trimmed.replace(
    /^([a-z][a-z\d+.-]*:)\/(?!\/)/i,
    "$1//",
  );
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(fixedSingleSlashScheme);
  const absoluteUrl = hasScheme
    ? fixedSingleSlashScheme
    : `${window.location.protocol}//${fixedSingleSlashScheme}`;

  return absoluteUrl.replace(/\/$/, "");
};

export const withCurrentPath = (baseUrl: string): string => {
  const path = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return `${normalizeUrl(baseUrl)}${path}`;
};
