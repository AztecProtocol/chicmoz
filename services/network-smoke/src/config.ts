import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "@chicmoz/test-harness";
import { z } from "zod";
import { type Ports, parsePorts } from "./ports.js";

export type Config = {
  dir: string;
  /** One installed Aztec toolchain per lock hash, shared across runs. */
  toolchainDir: string;
  ports?: Ports;
  /** Otherwise `anvil` and `forge` come from PATH. */
  foundryBinDir?: string;
};

const env = z
  .object({
    NETWORK_SMOKE_DIR: z.string().min(1).optional(),
    NETWORK_SMOKE_TOOLCHAIN_DIR: z.string().min(1).optional(),
    NETWORK_SMOKE_PORTS: z.string().min(1).optional(),
    FOUNDRY_BIN_DIR: z.string().min(1).optional(),
    XDG_CACHE_HOME: z.string().min(1).optional(),
  })
  .parse(process.env);

// Absolute, because children run in other working directories and the TMPDIR
// symlinks need an absolute target.
export const readConfig = (): Config => ({
  dir: resolve(env.NETWORK_SMOKE_DIR ?? join(REPO_ROOT, ".network-smoke")),
  toolchainDir: resolve(
    env.NETWORK_SMOKE_TOOLCHAIN_DIR ??
      join(
        env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
        "chicmoz-network-smoke",
      ),
  ),
  ports: env.NETWORK_SMOKE_PORTS
    ? parsePorts(env.NETWORK_SMOKE_PORTS)
    : undefined,
  foundryBinDir: env.FOUNDRY_BIN_DIR ? resolve(env.FOUNDRY_BIN_DIR) : undefined,
});
