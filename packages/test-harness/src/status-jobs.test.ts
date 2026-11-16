import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./repo.js";
import { statusJobViolations } from "./status-jobs.js";

/** Per workflow file, jobs that report but must never block a merge. */
const ADVISORY_JOBS: Record<string, readonly string[]> = {
  "quality.yml": ["dependency-audit"],
};

const WORKFLOWS = path.join(REPO_ROOT, ".github", "workflows");

describe("aggregate status jobs", () => {
  it("wait for and check every gating job of their workflow", () => {
    const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
    expect(
      files.flatMap((f) =>
        statusJobViolations(
          f,
          readFileSync(path.join(WORKFLOWS, f), "utf8"),
          ADVISORY_JOBS[f],
        ),
      ),
    ).toEqual([]);
  });

  it("flag a missing need, a skippable status job and an unchecked result", () => {
    const source = `
jobs:
  build: { runs-on: ubuntu-latest }
  lint: { runs-on: ubuntu-latest }
  audit: { runs-on: ubuntu-latest }
  status:
    name: demo-status
    needs: [build]
    steps:
      - env:
          RESULTS: "lint|\${{ needs.lint.result }}|success"
        run: bash .github/scripts/check-job-results.sh
`;
    expect(statusJobViolations("demo.yml", source, ["audit", "gone"])).toEqual([
      expect.stringContaining("advisory job gone does not exist"),
      expect.stringContaining("demo-status does not need lint"),
      expect.stringContaining("demo-status lacks if: always()"),
      expect.stringContaining(
        "needs build but its RESULTS never checks needs.build.result",
      ),
    ]);
  });
});
