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
  e2e: { runs-on: ubuntu-latest, if: "needs.changes.outputs.run == 'true'" }
  gated: { runs-on: ubuntu-latest, if: "needs.changes.outputs.other == 'true'" }
  docs: { runs-on: ubuntu-latest }
  commitlint: { runs-on: ubuntu-latest, if: "github.event_name == 'pull_request'" }
  release: { runs-on: ubuntu-latest, if: "github.event_name == 'push'" }
  bare: { runs-on: ubuntu-latest }
  extra: { runs-on: ubuntu-latest, if: "github.event_name == 'pull_request' && github.actor != 'bot'" }
  audit: { runs-on: ubuntu-latest }
  status:
    name: demo-status
    if: always() && success()
    needs: [build, test, e2e, gated, lint, docs, commitlint, release, bare, extra]
    steps:
      - env:
          RESULTS: |
            \${{ needs.build.result }}|success|success
            test|\${{ needs.test.result }}|\${{ needs.test.result }}
            e2e|\${{ needs.e2e.result }}|\${{ needs.changes.outputs.run == 'true' && 'success' || 'skipped' }}
            gated|\${{ needs.gated.result }}|\${{ needs.changes.outputs.run == 'true' && 'success' || 'skipped' }}
            lint|\${{ needs.lint.result }}|\${{ needs.lint['result'] }}
            lint|\${{ needs.lint.result }}|\${{ 'failure' }}
            \${{ '' }}|\${{ needs.docs.result }}|success
            commitlint|\${{ needs.commitlint.result }}|\${{ github.event_name == 'pull_request' && 'success' || 'skipped' }}
            release|\${{ needs.release.result }}|\${{ github.event_name == 'pull_request' && 'success' || 'skipped' }}
            bare|\${{ needs.bare.result }}|\${{ github.event_name == 'pull_request' && 'success' || 'skipped' }}
            extra|\${{ needs.extra.result }}|\${{ github.event_name == 'pull_request' && 'success' || 'skipped' }}
        continue-on-error: true
        run: bash .github/scripts/check-job-results.sh
  ignored-status:
    if: always()
    needs: [build, lint, test, e2e, gated, docs, commitlint, release, bare, extra]
    steps:
      - run: bash .github/scripts/check-job-results.sh || true
`;
    expect(statusJobViolations("demo.yml", source, ["audit", "gone"])).toEqual([
      expect.stringContaining("advisory job gone does not exist"),
      expect.stringContaining("demo-status must have exactly if: always()"),
      expect.stringContaining("check step sets if or continue-on-error"),
      expect.stringContaining("demo-status needs build but no RESULTS row"),
      expect.stringContaining("demo-status needs test but no RESULTS row"),
      expect.stringContaining("demo-status needs gated but no RESULTS row"),
      expect.stringContaining("demo-status needs lint but no RESULTS row"),
      expect.stringContaining("demo-status needs docs but no RESULTS row"),
      expect.stringContaining("demo-status needs release but no RESULTS row"),
      expect.stringContaining("demo-status needs bare but no RESULTS row"),
      expect.stringContaining("demo-status needs extra but no RESULTS row"),
      expect.stringContaining("ignored-status has no step that runs exactly"),
    ]);
  });
});
