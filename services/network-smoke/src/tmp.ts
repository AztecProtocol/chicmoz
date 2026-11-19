import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";

export type TmpDir = { link: string; target: string };

/**
 * Short TMPDIRs that resolve into the run directory. The Aztec node and the
 * wallet put Unix sockets and LMDB stores under TMPDIR, and a socket path over
 * 107 bytes fails with EINVAL; the symlink keeps the path short while every
 * byte of data stays on disk. `runDir` must be absolute.
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

/** Unlinks `link` only while it is this run's symlink to `target`. */
export const removeTmpDir = ({ link, target }: TmpDir) => {
  if (
    lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() &&
    readlinkSync(link) === target
  ) {
    rmSync(link);
  }
  rmSync(target, { recursive: true, force: true });
};
