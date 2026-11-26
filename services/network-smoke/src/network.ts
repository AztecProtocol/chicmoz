import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Ports } from "./ports.js";
import { type ProcessGroups } from "./processes.js";
import { type Toolchain } from "./toolchain.js";

export const L1_CHAIN_ID = 31337;

const LAUNCHER = fileURLToPath(
  new URL("../toolchain/local-network.mjs", import.meta.url),
);

export const startAnvil = (
  groups: ProcessGroups,
  toolchain: Toolchain,
  ports: Ports,
  runDir: string,
) =>
  groups.start(
    "anvil",
    toolchain.anvil,
    [
      "--host",
      "127.0.0.1",
      "--port",
      String(ports.anvil),
      "--chain-id",
      String(L1_CHAIN_ID),
      // The finalized tag trails the head by two slots, so L1 proposals
      // become final within the run.
      "--slots-in-an-epoch",
      "1",
      "--silent",
    ],
    { cwd: runDir, env: {}, tier: 0 },
  );

const nodeEnv = (toolchain: Toolchain, anvilUrl: string, tmp: string) => ({
  PATH: `${dirname(toolchain.forge)}:${process.env.PATH ?? ""}`,
  FORGE_BIN: toolchain.forge,
  ANVIL_BIN: toolchain.anvil,
  // The local network keeps its stores under TMPDIR, not --data-directory.
  TMPDIR: tmp,
  ETHEREUM_HOSTS: anvilUrl,
  L1_CHAIN_ID: String(L1_CHAIN_ID),
  TEST_ACCOUNTS: "true",
  LOG_LEVEL: "info",
  ARCHIVER_POLLING_INTERVAL_MS: "500",
  ARCHIVER_VIEM_POLLING_INTERVAL_MS: "500",
  P2P_BLOCK_CHECK_INTERVAL_MS: "500",
  SEQ_TX_POLLING_INTERVAL_MS: "500",
  WS_BLOCK_CHECK_INTERVAL_MS: "500",
  // The toolchain installs without scripts, so bcrypto has no native build.
  NODE_BACKEND: "js",
});

/**
 * `aztec start --local-network` through the CLI entry point directly: the
 * `aztec` shell wrapper's `start` branch launches an anvil of its own.
 */
export const startAztecNode = (
  groups: ProcessGroups,
  toolchain: Toolchain,
  ports: Ports,
  runDir: string,
  tmp: string,
) => {
  const anvilUrl = `http://127.0.0.1:${ports.anvil}`;
  return groups.start(
    "aztec-node",
    process.execPath,
    [
      "--no-warnings",
      toolchain.aztecEntry,
      "start",
      "--local-network",
      "--port",
      String(ports.aztec),
      "--admin-port",
      String(ports.aztecAdmin),
      "--p2p.p2pPort",
      String(ports.aztecP2p),
      "--l1-rpc-urls",
      anvilUrl,
      "--data-directory",
      join(runDir, "aztec", "data"),
    ],
    {
      cwd: runDir,
      tier: 1,
      env: {
        ...nodeEnv(toolchain, anvilUrl, tmp),
        // Admin auth stays on with a random hash: no key is generated or logged.
        AZTEC_ADMIN_API_KEY_HASH: randomBytes(32).toString("hex"),
      },
    },
  );
};

/**
 * The local network with epoch auto-settle off (`toolchain/local-network.mjs`).
 * The launcher is copied, not linked, into the run directory: Node resolves
 * a linked entry from its real path, where the toolchain's packages are not.
 * Its imports then resolve through the run's link to the toolchain's
 * node_modules, so nothing is written into the shared toolchain directory.
 */
export const startLocalNetwork = (
  groups: ProcessGroups,
  toolchain: Toolchain,
  ports: Ports,
  runDir: string,
  tmp: string,
) => {
  const anvilUrl = `http://127.0.0.1:${ports.anvil}`;
  const dir = join(runDir, "launcher");
  mkdirSync(dir, { recursive: true });
  symlinkSync(toolchain.nodeModules, join(dir, "node_modules"), "dir");
  const entry = join(dir, "local-network.mjs");
  copyFileSync(LAUNCHER, entry);
  return groups.start(
    "aztec-node",
    process.execPath,
    [
      "--no-warnings",
      entry,
      "--port",
      String(ports.aztec),
      "--l1-rpc-urls",
      anvilUrl,
    ],
    { cwd: runDir, tier: 1, env: nodeEnv(toolchain, anvilUrl, tmp) },
  );
};
