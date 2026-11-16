import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Repository root: this module sits three directories below it, in `src/` and in `build/` alike. */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export const git = (args: readonly string[]): string =>
  execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
