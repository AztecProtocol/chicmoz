import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { settleAll } from "./wait.js";

const execFileAsync = promisify(execFile);

const TOOLCHAIN_SRC = fileURLToPath(new URL("../toolchain/", import.meta.url));
const ENTRY = join(
  "node_modules",
  "@aztec-labs",
  "aztec",
  "dest",
  "bin",
  "index.js",
);
const REGISTRY = "https://registry.npmjs.org/";

export type Toolchain = { aztecEntry: string; anvil: string; forge: string };

type LockEntry = { integrity?: string; resolved?: string; link?: boolean };

const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;

/**
 * `npm ci` skips the digest check for an entry without a parseable
 * `integrity`, and a `link` entry installs from the local disk.
 */
const checkLock = (lock: string) => {
  const { packages } = JSON.parse(lock) as {
    packages: Record<string, LockEntry>;
  };
  const bad = Object.entries(packages)
    .filter(([path]) => path !== "")
    .filter(
      ([, entry]) =>
        entry.link !== undefined ||
        !SHA512.test(entry.integrity ?? "") ||
        !entry.resolved?.startsWith(REGISTRY),
    )
    .map(([path]) => path);
  if (bad.length > 0) {
    throw new Error(
      `toolchain/package-lock.json: entries without one sha512 integrity and a ${REGISTRY} URL: ${bad.join(", ")}`,
    );
  }
};

const installAztec = async (
  toolchainDir: string,
  runId: string,
  log: string,
) => {
  const manifest = readFileSync(join(TOOLCHAIN_SRC, "package.json"), "utf8");
  const lock = readFileSync(join(TOOLCHAIN_SRC, "package-lock.json"), "utf8");
  checkLock(lock);
  const hash = createHash("sha256")
    .update(manifest)
    .update(lock)
    .digest("hex")
    .slice(0, 12);
  const dir = join(toolchainDir, `aztec-${hash}`);
  if (existsSync(join(dir, ENTRY))) {
    return join(dir, ENTRY);
  }
  const tmp = `${dir}.tmp-${runId}`;
  mkdirSync(tmp, { recursive: true });
  try {
    // The bytes checked and hashed above, not a second read of the checkout.
    writeFileSync(join(tmp, "package.json"), manifest);
    writeFileSync(join(tmp, "package-lock.json"), lock);
    // No install scripts run; see NODE_BACKEND where the node starts.
    const { stdout, stderr } = await execFileAsync(
      "npm",
      ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: tmp, maxBuffer: 64 * 1024 * 1024, timeout: 600_000 },
    );
    writeFileSync(log, stdout + stderr);
    // Never publish a tree without the entry point under this lock's name:
    // every later run would reuse it.
    if (!existsSync(join(tmp, ENTRY))) {
      throw new Error(`npm ci finished without ${ENTRY}; see ${log}`);
    }
    try {
      renameSync(tmp, dir);
    } catch (e) {
      // A concurrent run installed the same lock first; use its copy.
      if (!existsSync(join(dir, ENTRY))) {
        throw e;
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return join(dir, ENTRY);
};

const findBinary = (name: string, binDir?: string) => {
  const dirs = binDir ? [binDir] : (process.env.PATH ?? "").split(delimiter);
  for (const dir of dirs.filter(Boolean)) {
    const path = resolve(dir, name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      continue;
    }
  }
  throw new Error(
    `${name} not found ${binDir ? `in ${binDir}` : "on PATH"}; install foundry or set FOUNDRY_BIN_DIR`,
  );
};

/** Absolute paths, so the version checked is the binary later launched. */
const pinnedFoundry = async (binDir?: string) => {
  const version = readFileSync(
    join(TOOLCHAIN_SRC, "foundry-version"),
    "utf8",
  ).trim();
  const binaries = {
    anvil: findBinary("anvil", binDir),
    forge: findBinary("forge", binDir),
  };
  for (const path of Object.values(binaries)) {
    const { stdout } = await execFileAsync(path, ["--version"], {
      timeout: 30_000,
    });
    if (/ Version: (\S+)/.exec(stdout)?.[1] !== version) {
      throw new Error(
        `${path} is not foundry ${version} (toolchain/foundry-version): ${stdout.split("\n")[0]}`,
      );
    }
  }
  return binaries;
};

export const prepareToolchain = async ({
  toolchainDir,
  foundryBinDir,
  runId,
  log,
}: {
  toolchainDir: string;
  foundryBinDir?: string;
  runId: string;
  log: string;
}): Promise<Toolchain> => {
  const aztecEntry = installAztec(toolchainDir, runId, log);
  const foundry = pinnedFoundry(foundryBinDir);
  await settleAll([aztecEntry, foundry]);
  return { aztecEntry: await aztecEntry, ...(await foundry) };
};
