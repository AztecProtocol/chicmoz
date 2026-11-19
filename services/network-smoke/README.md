# @chicmoz/network-smoke

End-to-end smoke run of the explorer backend against a real Aztec 6.0.0 local network. It starts anvil, the Aztec node, the integration harness's Postgres, Kafka and Redis, and the built `aztec-listener`, `ethereum-listener`, `explorer-api` and `websocket-event-publisher`. It sends one transaction and checks that the explorer serves what the node and the L1 rollup say. Private and never deployed.

## Commands

```sh
yarn build                                      # the four services, the harness and this package
yarn smoke                                      # one run: set up, assert, tear down; exit code is the verdict
yarn workspace @chicmoz/network-smoke down <run> # clean up a run whose runner was killed (SIGKILL)
yarn harness ls | down <id>                     # compose projects, as for integration tests
```

Needs Linux (`/proc`), Docker with the compose plugin, Node 24 with npm, and foundry at the version in `toolchain/foundry-version` (`anvil` and `forge` on `PATH`, or in `FOUNDRY_BIN_DIR`). The first run installs the Aztec toolchain from `toolchain/package-lock.json` with `npm ci --ignore-scripts` (about 1.2 GB) and reuses it while the lock is unchanged. Later runs take about a minute.

| Variable                      | Default                                                  | Meaning                                                                        |
| ----------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `NETWORK_SMOKE_DIR`           | `<repo>/.network-smoke`                                  | run directories                                                                |
| `NETWORK_SMOKE_TOOLCHAIN_DIR` | `$XDG_CACHE_HOME/chicmoz-network-smoke` (`~/.cache/...`) | one installed toolchain per lock hash; delete old `aztec-*` dirs at will       |
| `NETWORK_SMOKE_PORTS`         | random free ports below the kernel's ephemeral range     | `anvil,aztec,aztecAdmin,aztecP2p,explorerApi,ws,wsHealth`; `wsHealth = ws + 1` |
| `FOUNDRY_BIN_DIR`             | `PATH`                                                   | directory holding `anvil` and `forge`                                          |

Each run gets an id (`ns` + 10 hex) used as its Kafka namespace, its own compose project and databases, and its own process groups, so parallel runs on one host do not collide. Teardown stops only the run's own groups and project, on success, failure, Ctrl-C or SIGTERM.

## In CI

`.github/workflows/network-smoke.yml` runs it on pull requests that change what it builds or starts, nightly, and on demand, and reports `network-smoke-status`. It is not a required check. On failure, CI keeps whatever run logs, marks and harness logs exist, for 7 days.

## What it checks

1. A block reaches the API (`/l2/latest-height`, `/l2/blocks/1`).
2. The run's own transaction (a Schnorr account deployment) is served by `/l2/tx-effects/:hash` at the block the node's receipt names.
3. The websocket publisher streams that block with the node's hash.
4. Every height up to that block has the node's hash, and its `proposedOnL1` matches the rollup's `CheckpointProposed` log on anvil (archive, L1 block number, L1 transaction hash).
5. `/l2/tips` is not degraded, and its proposed tip has reached that block.
6. No consumer logs three or more handler failures on one topic. One or two can be at-least-once delivery recovering, and the run prints them.

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
