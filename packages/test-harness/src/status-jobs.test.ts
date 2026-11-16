import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./repo.js";
import { statusJobViolations } from "./status-jobs.js";

/** Per workflow file, jobs that report but must never block a merge. */
const ADVISORY_JOBS: Record<string, readonly string[]> = {
  "quality.yml": ["dependency-audit"],
};

const WORKFLOWS = join(REPO_ROOT, ".github", "workflows");

describe("aggregate status jobs", () => {
  it("wait for and check every gating job of their workflow", () => {
    const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
    expect(
      files.flatMap((f) =>
        statusJobViolations(
          f,
          readFileSync(join(WORKFLOWS, f), "utf8"),
          ADVISORY_JOBS[f],
        ),
      ),
    ).toEqual([]);
  });

  it("flag every way a status job can pass over a failed job", () => {
    const source = `
jobs:
  build: { runs-on: ubuntu-latest }
  lint: { runs-on: ubuntu-latest }
  test: { runs-on: ubuntu-latest }
  e2e: { runs-on: ubuntu-latest }
  audit: { runs-on: ubuntu-latest }
  status:
    name: demo-status
    if: always() && success()
    needs: [build, test, e2e, lint]
    steps:
      - env:
          RESULTS: |
            \${{ needs.build.result }}|success|success
            test|\${{ needs.test.result }}|\${{ needs.test.result }}
            e2e|\${{ needs.e2e.result }}|\${{ needs.changes.outputs.run == 'true' && 'success' || 'skipped' }}
            lint|\${{ needs.lint.result }}|\${{ needs.lint['result'] }}
            lint|\${{ needs.lint.result }}|\${{ 'failure' }}
        continue-on-error: true
        run: bash .github/scripts/check-job-results.sh
  ignored-status:
    if: always()
    needs: [build, lint, test, e2e]
    steps:
      - run: bash .github/scripts/check-job-results.sh || true
`;
    expect(statusJobViolations("demo.yml", source, ["audit", "gone"])).toEqual([
      expect.stringContaining("advisory job gone does not exist"),
      expect.stringContaining("demo-status must have exactly if: always()"),
      expect.stringContaining("check step sets if or continue-on-error"),
      expect.stringContaining("demo-status needs build but no RESULTS row"),
      expect.stringContaining("demo-status needs test but no RESULTS row"),
      expect.stringContaining("demo-status needs lint but no RESULTS row"),
      expect.stringContaining("ignored-status has no step that runs exactly"),
    ]);
  });
});
