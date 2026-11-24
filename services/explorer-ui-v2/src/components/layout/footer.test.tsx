import { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// A real Link needs a router; these tests check the version, not the links.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => children,
}));

// The version is read from the env when constants.ts is first imported.
const renderFooter = async (version: string | undefined) => {
  vi.resetModules();
  vi.stubEnv("VITE_L2_NETWORK_ID", "SANDBOX");
  vi.stubEnv("VITE_VERSION_STRING", version);
  const { Footer } = await import("./footer");
  return renderToStaticMarkup(<Footer />);
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Footer", () => {
  it("shows the build version in its own element", async () => {
    expect(await renderFooter("prod-0123456789ab")).toContain(
      'for Aztec · build <span class="footer-version">prod-0123456789ab</span></div>',
    );
  });

  it.each([
    ["unset", undefined],
    ["blank", " "],
  ])("shows no version when it is %s", async (_case, version) => {
    expect(await renderFooter(version)).not.toMatch(/build|version/);
  });
});
