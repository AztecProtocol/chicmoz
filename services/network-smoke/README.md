# @chicmoz/network-smoke

End-to-end smoke run of the explorer backend against a real Aztec 6.0.0 local network. It starts anvil, the Aztec node, the integration harness's Postgres, Kafka and Redis, and the built `aztec-listener`, `ethereum-listener`, `explorer-api` and `websocket-event-publisher`. It sends one transaction and checks that the explorer serves what the node and the L1 rollup say. Private and never deployed.

## Commands

```sh
yarn build                                      # the four services, the harness and this package
yarn smoke                                      # one run: set up, assert, tear down; exit code is the verdict
yarn smoke:scripted                             # one run against a scripted node that prunes (see below)
yarn workspace @chicmoz/network-smoke down <run> # clean up a run whose runner was killed (SIGKILL)
yarn harness ls | down <id>                     # compose projects, as for integration tests
```

Needs Linux (`/proc`), Docker with the compose plugin, Node 24 with npm, and foundry at the version in `toolchain/foundry-version` (`anvil` and `forge` on `PATH`, or in `FOUNDRY_BIN_DIR`). The first run installs the Aztec toolchain from `toolchain/package-lock.json` with `npm ci --ignore-scripts` (about 1.2 GB) and reuses it while the lock is unchanged. Later runs take about a minute.

| Variable                      | Default                                                             | Meaning                                                                        |
| ----------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `NETWORK_SMOKE_DIR`           | `<repo>/.network-smoke`                                             | run directories                                                                |
| `NETWORK_SMOKE_TOOLCHAIN_DIR` | `$XDG_CACHE_HOME/chicmoz-network-smoke` (`~/.cache/...`)            | one installed toolchain per lock hash; delete old `aztec-*` dirs at will       |
| `NETWORK_SMOKE_PORTS`         | free ports below the ephemeral range, unlisted in the host registry | `anvil,aztec,aztecAdmin,aztecP2p,explorerApi,ws,wsHealth`; `wsHealth = ws + 1` |
| `FOUNDRY_BIN_DIR`             | `PATH`                                                              | directory holding `anvil` and `forge`                                          |

Each run gets an id (`ns` + 10 hex) used as its Kafka namespace, its own compose project and databases, and its own process groups, so parallel runs on one host do not collide. Its ports are claimed in the host's port registry, `~/.agents/ports.md`, which other tools on the host read and write under the same lock (`src/port-registry.ts`); the claim lasts while the runner lives. Teardown stops only the run's own groups and project and releases its ports, on success, failure, Ctrl-C or SIGTERM.

## In CI

`.github/workflows/network-smoke.yml` runs it and the scripted mode, as two jobs, on pull requests that change what they build or start, nightly, and on demand, and reports both in `network-smoke-status`. It is not a required check. On failure, CI keeps whatever run logs, marks and harness logs exist, for 7 days.

## What it checks

1. A block reaches the API (`/l2/latest-height`, `/l2/blocks/1`).
2. The run's own transaction (a Schnorr account deployment) is served by `/l2/tx-effects/:hash` at the block the node's receipt names.
3. The websocket publisher streams that block with the node's hash.
4. Every height up to that block has the node's hash, and its `proposedOnL1` matches the rollup's `CheckpointProposed` log on anvil (archive, L1 block number, L1 transaction hash).
5. `/l2/tips` is not degraded, and its proposed tip has reached that block.
6. No consumer logs three or more handler failures on one topic. One or two can be at-least-once delivery recovering, and the run prints them.

## Scripted mode

`yarn smoke:scripted` replaces anvil and the Aztec node with a scripted JSON-RPC node (`src/scripted-node.ts`) and starts only `aztec-listener` and `explorer-api`, with the same harness, isolation and teardown. It installs no toolchain and needs no foundry. Before any service starts, it creates the block topic with 3 partitions, so blocks published without a key can reach the API out of order.

The node serves the SDK's `AztecNodeApiSchema` through the SDK's own server and answers any method it does not implement with "Method not found". Its chain (`src/scripted-chain.ts`) grows blocks 1–10, proves and finalizes 1–6, then prunes 7–10 and grows 7′–12′ on 6. The block that deploys a contract dies at 8; its tx is mined again in 7′. The test (`src/prune.scripted.ts`) steps the node through each state on its control port (the `aztecAdmin` port: `GET /script`, `POST /script/step`), waits until the API stops changing, and checks through REST only:

1. Heights 1–12 serve the final chain, and nothing exists at 13.
2. `/l2/reorgs` lists one reorg: height 7, 4 blocks, rooted at the dead 7.
3. The moved tx is not dropped, its effect is on 7′, and the contract instance is on 7′.
4. Each dead block is served by its hash, as orphaned.

`logs/scripted-node.log` has each state change and every block lookup with the state it was answered in.

## Reading a failure

- Marks with elapsed seconds go to stdout and to `<run>/marks.txt`. The last mark shows the stage that failed.
- A setup stage that times out names what it waited for. A child that dies is named with the tail of its log.
- Every process logs to `<run>/logs/<name>.log`. On failure the harness saves the compose logs to `.harness/<id>/`.
- Test 6 names the service and topic. The handler's error is in that service's log, next to `Provided callback for topic ... failed`.

## Limits

- **The local network is not a live network.**
  - The automine sequencer builds one block per checkpoint, only when transactions arrive, and warps L1 time to each slot.
  - The proven tip moves by a storage write, so no `L2ProofVerified` event is emitted and nothing proof-related is checked.
  - There are no multi-block checkpoints and no reorgs.
- **Interfaces.** anvil binds `127.0.0.1`. The node's RPC and admin ports, explorer-api and the websocket publisher have no host option and listen on all interfaces. The admin API keeps authentication on with a random key hash generated per run, and the network holds only the public test accounts. Run it on a host whose network you trust.
- **Kills and supply chain.**
  - A SIGKILL of the runner leaves its processes and project for `down <run>`. A kill during the harness's `up()` leaves a labelled project for `yarn harness down`. A kill during the first toolchain install can leave `npm ci` running and an `aztec-*.tmp-<run>` directory in the toolchain dir.
  - `yarn npm audit` does not cover the toolchain's npm tree.
