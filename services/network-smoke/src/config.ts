import { homedir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "@chicmoz/test-harness";
import { z } from "zod";
import { type Ports, parsePorts } from "./ports.js";

export type Config = {
  /** Run directories: logs, marks, process groups, node and wallet temp data. */
  dir: string;
  /** Installed Aztec toolchains, one per lock hash, shared across runs. */
  toolchainDir: string;
  ports?: Ports;
  /** Where `anvil` and `forge` live; otherwise they are looked up on PATH. */
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

export const readConfig = (): Config => ({
  dir: env.NETWORK_SMOKE_DIR ?? join(REPO_ROOT, ".network-smoke"),
  toolchainDir:
    env.NETWORK_SMOKE_TOOLCHAIN_DIR ??
    join(
      env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
      "chicmoz-network-smoke",
    ),
  ports: env.NETWORK_SMOKE_PORTS
    ? parsePorts(env.NETWORK_SMOKE_PORTS)
    : undefined,
  foundryBinDir: env.FOUNDRY_BIN_DIR,
});
