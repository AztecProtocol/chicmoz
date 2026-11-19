import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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

/** `npm ci` skips the digest check for an entry without `integrity`. */
const checkLock = (lock: string) => {
  const { packages } = JSON.parse(lock) as {
    packages: Record<string, LockEntry>;
  };
  const bad = Object.entries(packages)
    .filter(([path, entry]) => path !== "" && !entry.link)
    .filter(
      ([, entry]) =>
        !entry.integrity?.startsWith("sha512-") ||
        !entry.resolved?.startsWith(REGISTRY),
    )
    .map(([path]) => path);
  if (bad.length > 0) {
    throw new Error(
      `toolchain/package-lock.json: entries without a sha512 integrity or a ${REGISTRY} URL: ${bad.join(", ")}`,
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
    copyFileSync(
      join(TOOLCHAIN_SRC, "package.json"),
      join(tmp, "package.json"),
    );
    copyFileSync(
      join(TOOLCHAIN_SRC, "package-lock.json"),
      join(tmp, "package-lock.json"),
    );
    // No install scripts run. bcrypto, the one dependency that needs its
    // native build, runs on its pure-JS backend instead (NODE_BACKEND=js).
    const { stdout, stderr } = await execFileAsync(
      "npm",
      ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: tmp, maxBuffer: 64 * 1024 * 1024, timeout: 600_000 },
    );
    writeFileSync(log, stdout + stderr);
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
    const path = join(dir, name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // not here
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
    const { stdout } = await execFileAsync(path, ["--version"]);
    if (!stdout.includes(`Version: ${version}`)) {
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
  const [aztecEntry, foundry] = await Promise.all([
    installAztec(toolchainDir, runId, log),
    pinnedFoundry(foundryBinDir),
  ]);
  return { aztecEntry, ...foundry };
};
