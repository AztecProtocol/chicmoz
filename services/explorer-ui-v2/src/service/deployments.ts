import { z } from "zod";

const deploymentStatusSchema = z.enum(["canonical", "live", "archived"]);
export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>;

/**
 * One UI build: a network at one major Aztec version (its own backend stack).
 * `canonical` is the network's current rollup, `live` a previous rollup that
 * is still indexed, `archived` a previous rollup served from stored history.
 */
export type UiDeployment = {
  network: string;
  url: string;
  version: string | null;
  status: DeploymentStatus;
};

export const normalizeNetworkName = (name: string): string =>
  name.trim().toUpperCase();

export const normalizeVersion = (version: string): string =>
  version.trim().toLowerCase();

/**
 * Parses `VITE_CHICMOZ_ALL_UI_URLS`: comma-separated
 * `Network|URL[|version[|status]]` entries, e.g.
 * `Testnet|https://testnet.aztecscan.xyz|v6|canonical,Testnet|https://v5.testnet.aztecscan.xyz|v5|archived`.
 * An entry without a status is canonical. Throws on an unknown status, like
 * the other build-time settings.
 */
export const parseUiDeployments = (raw: string | undefined): UiDeployment[] =>
  (raw ?? "")
    .split(",")
    .map((entry) => entry.split("|").map((part) => part.trim()))
    .filter(([network, url]) => !!network && !!url)
    .map(([network, url, version, status]) => ({
      network: normalizeNetworkName(network),
      url,
      version: version ? normalizeVersion(version) : null,
      status: deploymentStatusSchema.parse(status || "canonical"),
    }));

const versionNumber = (version: string | null): number => {
  const match = version?.match(/\d+/);
  return match ? Number(match[0]) : -1;
};

/** One entry per network, in first-seen order: its canonical deployment. */
export const getNetworkEntries = (
  deployments: UiDeployment[],
): UiDeployment[] => {
  const networks = [...new Set(deployments.map(({ network }) => network))];
  return networks.map(
    (network) =>
      getCanonicalDeployment(deployments, network) ??
      // A network listed without any canonical entry still gets a link.
      deployments.filter((d) => d.network === network)[0],
  );
};

export const getCanonicalDeployment = (
  deployments: UiDeployment[],
  network: string,
): UiDeployment | undefined =>
  deployments.find(
    (d) =>
      d.network === normalizeNetworkName(network) && d.status === "canonical",
  );

/** A network's versioned deployments, newest major version first. */
export const getVersionEntries = (
  deployments: UiDeployment[],
  network: string,
): UiDeployment[] =>
  deployments
    .filter(
      (d) => d.network === normalizeNetworkName(network) && d.version !== null,
    )
    .sort((a, b) => versionNumber(b.version) - versionNumber(a.version));

/** The status of this build; a build not listed counts as canonical. */
export const getDeploymentStatus = (
  deployments: UiDeployment[],
  network: string,
  version: string | null,
): DeploymentStatus =>
  deployments.find(
    (d) =>
      d.network === normalizeNetworkName(network) &&
      version !== null &&
      d.version === normalizeVersion(version),
  )?.status ?? "canonical";
