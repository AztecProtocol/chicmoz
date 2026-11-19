import { lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

export type TmpDir = { link: string; target: string };

/**
 * Short TMPDIRs that resolve into the run directory. The Aztec node and the
 * wallet put Unix sockets under TMPDIR, and a socket path over 107 bytes
 * fails with EINVAL; the symlink keeps the path short while every byte of
 * data stays on disk.
 */
export const tmpDirs = (runId: string, runDir: string) => ({
  node: {
    link: join("/tmp", `${runId}-n`),
    target: join(runDir, "aztec", "tmp"),
  },
  wallet: { link: join("/tmp", `${runId}-w`), target: join(runDir, "tmp") },
});

/** `symlinkSync` fails rather than reuse an existing name. */
export const createTmpDir = ({ link, target }: TmpDir) => {
  mkdirSync(target, { recursive: true });
  symlinkSync(target, link);
  return link;
};

export const removeTmpDir = ({ link, target }: TmpDir) => {
  if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) {
    rmSync(link);
  }
  rmSync(target, { recursive: true, force: true });
};
