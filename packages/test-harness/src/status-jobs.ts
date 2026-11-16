import { parse } from "yaml";
import { z } from "zod";

const RESULTS_SCRIPT = ".github/scripts/check-job-results.sh";

const workflowSchema = z.object({
  jobs: z.record(
    z.object({
      name: z.string().optional(),
      if: z.union([z.string(), z.boolean()]).optional(),
      needs: z.union([z.string(), z.array(z.string())]).optional(),
      steps: z
        .array(
          z.object({
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

/**
 * Ways a `*-status` job (by id or display name) in one workflow can pass while
 * a gating job of the same workflow has not succeeded: it does not wait for
 * that job, it is skipped when a dependency fails (a skipped required check
 * counts as passed), or `check-job-results.sh` never sees that job's result.
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
    const needs =
      typeof job.needs === "string" ? [job.needs] : (job.needs ?? []);

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
    if (!String(job.if ?? "").includes("always()")) {
      violations.push(
        `${label} lacks if: always(), so it is skipped, and passes, when a job it needs fails`,
      );
    }
    const step = job.steps?.find((s) => s.run?.includes(RESULTS_SCRIPT));
    if (step === undefined) {
      violations.push(`${label} does not run ${RESULTS_SCRIPT}`);
      continue;
    }
    const results = step.env?.RESULTS;
    for (const need of needs) {
      const line = new RegExp(
        `\\$\\{\\{\\s*needs\\.${escapeRegExp(need)}\\.result\\s*\\}\\}`,
      );
      if (typeof results !== "string" || !line.test(results)) {
        violations.push(
          `${label} needs ${need} but its RESULTS never checks needs.${need}.result`,
        );
      }
    }
  }
  return violations;
};
