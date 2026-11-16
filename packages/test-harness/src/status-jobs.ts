import { parse } from "yaml";
import { z } from "zod";

const RESULTS_RUN = "bash .github/scripts/check-job-results.sh";

const condition = z.union([z.string(), z.boolean()]).optional();
const workflowSchema = z.object({
  jobs: z.record(
    z.object({
      name: z.string().optional(),
      if: condition,
      "continue-on-error": z.unknown().optional(),
      needs: z.union([z.string(), z.array(z.string())]).optional(),
      steps: z
        .array(
          z.object({
            if: condition,
            "continue-on-error": z.unknown().optional(),
            run: z.string().optional(),
            env: z.record(z.unknown()).optional(),
          }),
        )
        .optional(),
    }),
  ),
});

const isStatusName = (name: string | undefined) =>
  name?.endsWith("-status") ?? false;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const unwrapExpression = (value: unknown) =>
  String(value ?? "")
    .trim()
    .replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1");

/**
 * Splits RESULTS the way check-job-results.sh reads it (`IFS='|' read -r
 * name actual expected`): no trimming, and `expected` takes the remainder.
 * The script skips a row with an empty name, so a name must be literal: an
 * expression could render empty.
 */
const parseResultRows = (results: string) =>
  results.split("\n").flatMap((line) => {
    const [name = "", actual = "", ...rest] = line.split("|");
    return name === "" || name.includes("${{")
      ? []
      : [{ name, actual, expected: rest.join("|") }];
  });

const GATED_EXPECTATION =
  /^\$\{\{ needs\.[\w-]+\.outputs\.[\w-]+ == 'true' && 'success' \|\| 'skipped' \}\}$/;

/** `success`, `skipped`, or a gate output choosing one; any looser expression can evaluate to the result it is compared with. */
const isFixedExpectation = (expected: string) =>
  expected === "success" ||
  expected === "skipped" ||
  GATED_EXPECTATION.test(expected);

/**
 * Ways a `*-status` job (by id or display name) in one workflow can pass while
 * a gating job of the same workflow has not succeeded: it does not wait for
 * that job; it is skipped when a dependency fails (a skipped required check
 * counts as passed); its check step can be skipped or its failure ignored; or
 * check-job-results.sh never compares that job's result with a fixed outcome.
 * `advisory` names jobs that must not gate; each must exist.
 */
export const statusJobViolations = (
  file: string,
  source: string,
  advisory: readonly string[] = [],
): string[] => {
  const { jobs } = workflowSchema.parse(parse(source));
  const ids = Object.keys(jobs);
  const isStatus = (id: string) =>
    isStatusName(id) || isStatusName(jobs[id].name);
  const violations: string[] = [];

  for (const id of advisory) {
    if (!ids.includes(id)) {
      violations.push(
        `${file}: advisory job ${id} does not exist; remove it from the allowlist`,
      );
    }
  }
  for (const id of ids.filter(isStatus)) {
    const job = jobs[id];
    const label = `${file}: ${job.name ?? id}`;
    const needs = typeof job.needs === "string" ? [job.needs] : job.needs ?? [];

    for (const other of ids) {
      if (
        !isStatus(other) &&
        !advisory.includes(other) &&
        !needs.includes(other)
      ) {
        violations.push(
          `${label} does not need ${other}, so it can pass before ${other} ends`,
        );
      }
    }
    if (unwrapExpression(job.if) !== "always()") {
      violations.push(
        `${label} must have exactly if: always(); otherwise it is skipped, and passes, when a job it needs fails`,
      );
    }
    if (job["continue-on-error"] !== undefined) {
      violations.push(
        `${label} sets continue-on-error, so its failure is ignored`,
      );
    }

    const step = job.steps?.find((s) => s.run?.trim() === RESULTS_RUN);
    if (step === undefined) {
      violations.push(`${label} has no step that runs exactly: ${RESULTS_RUN}`);
      continue;
    }
    if (step.if !== undefined || step["continue-on-error"] !== undefined) {
      violations.push(
        `${label}: its check step sets if or continue-on-error, so it can be skipped or ignored`,
      );
    }
    const rows =
      typeof step.env?.RESULTS === "string"
        ? parseResultRows(step.env.RESULTS)
        : [];
    for (const need of needs) {
      const actual = new RegExp(
        `^\\$\\{\\{\\s*needs\\.${escapeRegExp(need)}\\.result\\s*\\}\\}$`,
      );
      const checked = rows.some(
        (row) => actual.test(row.actual) && isFixedExpectation(row.expected),
      );
      if (!checked) {
        violations.push(
          `${label} needs ${need} but no RESULTS row has actual \${{ needs.${need}.result }} and a fixed expected value`,
        );
      }
    }
  }
  return violations;
};
