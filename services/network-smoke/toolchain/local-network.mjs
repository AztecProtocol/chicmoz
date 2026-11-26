// `aztec start --local-network` as the toolchain's CLI runs it
// (@aztec-labs/aztec dest/cli/aztec_start_action.js), with the
// AutomineSequencer's epoch auto-settle off. The CLI passes createLocalNetwork
// no automineEnableProveEpoch, which then defaults to true over the env's
// AUTOMINE_ENABLE_PROVE_EPOCH, and auto-settle proves every checkpoint within
// 200 ms, so nothing stays unproven long enough to be pruned. Here the proven
// and finalized tips move only on `aztecDebug_prove`.
//
// Plain JavaScript, because none of these packages is a workspace dependency:
// Node runs a copy from the run directory, whose node_modules links to the
// installed toolchain. Unlike the CLI it serves no admin API, which nothing
// here uses, and binds 127.0.0.1.
import { BarretenbergSync } from "@aztec-foundation/bb.js";
import { createLocalNetwork } from "@aztec-labs/aztec";
import { registerAztecNodeRpcHandlers } from "@aztec-labs/aztec-node";
import {
  createNamespacedSafeJsonRpcServer,
  startHttpRpcServer,
} from "@aztec-labs/foundation/json-rpc/server";
import { createConsoleLogger, createLogger } from "@aztec-labs/foundation/log";
import { getVKTreeRoot } from "@aztec-labs/noir-protocol-circuits-types/vk-tree";
import { protocolContractsHash } from "@aztec-labs/protocol-contracts";
import { getPackageVersion } from "@aztec-labs/stdlib/update-checker";
import { getVersioningMiddleware } from "@aztec-labs/stdlib/versioning";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) {
    throw new Error(`missing ${name}`);
  }
  return process.argv[i + 1];
};

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => process.exit(0));
}

const userLog = createConsoleLogger();
const log = createLogger("cli");

userLog("local network with epoch auto-settle off");
const { node } = await createLocalNetwork(
  {
    l1RpcUrls: [arg("--l1-rpc-urls")],
    testAccounts: process.env.TEST_ACCOUNTS === "true",
    automineEnableProveEpoch: false,
  },
  userLog,
);

const services = {};
registerAztecNodeRpcHandlers(node, services, undefined, { debug: true });
// Schema parsing can decompress a Chonk proof before the node's handler runs.
await BarretenbergSync.initSingleton();

const versions = {
  l2CircuitsVkTreeRoot: getVKTreeRoot().toString(),
  l2ProtocolContractsHash: protocolContractsHash.toString(),
};
const server = createNamespacedSafeJsonRpcServer(services, {
  http200OnError: false,
  log,
  maxBatchSize: 100,
  maxBodySizeBytes: "1mb",
  middlewares: [
    getVersioningMiddleware(versions, { packageVersion: getPackageVersion() }),
  ],
});
const { port } = await startHttpRpcServer(server, {
  host: "127.0.0.1",
  port: arg("--port"),
});
log.info(`Aztec Server listening on port ${port}`, versions);
