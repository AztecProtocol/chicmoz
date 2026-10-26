import { describe, expect, it } from "vitest";
import {
  getDeploymentStatus,
  getNetworkEntries,
  getVersionEntries,
  parseUiDeployments,
} from "./deployments";

const CONFIG = [
  "Mainnet|https://aztecscan.xyz",
  "Testnet|https://v5.testnet.aztecscan.xyz|v5|archived",
  "Testnet|https://testnet.aztecscan.xyz|v6|canonical",
  "Testnet|https://v4.testnet.aztecscan.xyz|V4|live",
].join(",");

describe("parseUiDeployments", () => {
  it("keeps the legacy Name|URL format working as canonical", () => {
    expect(parseUiDeployments("Mainnet|https://aztecscan.xyz")).toEqual([
      {
        network: "MAINNET",
        url: "https://aztecscan.xyz",
        version: null,
        status: "canonical",
      },
    ]);
  });

  it("reads version and status, normalizing case", () => {
    const [, , , v4] = parseUiDeployments(CONFIG);
    expect(v4).toEqual({
      network: "TESTNET",
      url: "https://v4.testnet.aztecscan.xyz",
      version: "v4",
      status: "live",
    });
  });

  it("skips empty entries and throws on an unknown status", () => {
    expect(parseUiDeployments(undefined)).toEqual([]);
    expect(parseUiDeployments(",|,Testnet|")).toEqual([]);
    expect(() => parseUiDeployments("Testnet|https://x|v6|retired")).toThrow();
  });
});

describe("getNetworkEntries", () => {
  it("links each network to its canonical deployment", () => {
    expect(
      getNetworkEntries(parseUiDeployments(CONFIG)).map(({ url }) => url),
    ).toEqual(["https://aztecscan.xyz", "https://testnet.aztecscan.xyz"]);
  });

  it("falls back to a network's first entry when none is canonical", () => {
    const deployments = parseUiDeployments(
      "Devnet|https://v5.devnet.aztecscan.xyz|v5|archived",
    );
    expect(getNetworkEntries(deployments)[0].url).toBe(
      "https://v5.devnet.aztecscan.xyz",
    );
  });
});

describe("getVersionEntries", () => {
  it("lists a network's versions newest first", () => {
    expect(
      getVersionEntries(parseUiDeployments(CONFIG), "Testnet").map(
        ({ version }) => version,
      ),
    ).toEqual(["v6", "v5", "v4"]);
  });

  it("is empty for an unversioned network", () => {
    expect(getVersionEntries(parseUiDeployments(CONFIG), "MAINNET")).toEqual(
      [],
    );
  });
});

describe("getDeploymentStatus", () => {
  const deployments = parseUiDeployments(CONFIG);

  it("finds this build's status", () => {
    expect(getDeploymentStatus(deployments, "TESTNET", "v5")).toBe("archived");
    expect(getDeploymentStatus(deployments, "TESTNET", "V6")).toBe("canonical");
  });

  it("treats an unlisted or unversioned build as canonical", () => {
    expect(getDeploymentStatus(deployments, "TESTNET", null)).toBe("canonical");
    expect(getDeploymentStatus(deployments, "TESTNET", "v9")).toBe("canonical");
  });
});
