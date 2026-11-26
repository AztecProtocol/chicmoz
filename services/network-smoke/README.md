# @chicmoz/network-smoke

End-to-end smoke run of the explorer backend against a real Aztec 6.0.0 local network. It starts anvil, the Aztec node, the integration harness's Postgres, Kafka and Redis, and the built `aztec-listener`, `ethereum-listener`, `explorer-api` and `websocket-event-publisher`. It sends one transaction and checks that the explorer serves what the node and the L1 rollup say. Private and never deployed.

## Commands

```sh
yarn build                                      # the four services, the harness and this package
yarn smoke                                      # one run: set up, assert, tear down; exit code is the verdict
yarn smoke:scripted                             # one run against a scripted node that prunes (see below)
yarn smoke:prune                                # one run in which the local network prunes (see below)
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

Each run gets an id (`ns` + 10 hex) used as its Kafka namespace, its own compose project and databases, and its own process groups, so parallel runs on one host do not collide. Its ports are claimed in the host's port registry, `~/.agents/ports.md`, which other tools on the host read and write under the same lock (`src/port-registry.ts`); the claim lasts while the runner lives. Teardown stops only the run's own groups and project and releases its ports, on success, failure, Ctrl-C or SIGTERM. A group that survives SIGKILL keeps the ports claimed and fails the run, as does a release that fails. A run binds every port it claims, `NETWORK_SMOKE_PORTS` too, so it never claims one that a survivor still holds.

## In CI

`.github/workflows/network-smoke.yml` runs it, the scripted mode and the prune mode, as three jobs, on pull requests that change what they build or start, nightly, and on demand, and reports all three in `network-smoke-status`. It is not a required check. On failure, CI keeps whatever run logs, marks and harness logs exist, for 7 days.

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
5. `scripts/compare-chain.ts` finds no mismatch before the prune, and after it names the same first divergence as the checks above, without printing either URL.

`logs/scripted-node.log` has each state change and every block lookup with the state it was answered in.

## Prune mode

`yarn smoke:prune` starts the same services, toolchain and isolation as `yarn smoke`, with the block topic on 3 partitions, but runs the local network through `toolchain/local-network.mjs`: `createLocalNetwork` with the epoch auto-settle off, which the stock CLI cannot turn off. There the proven and finalized tips move only on `aztecDebug_prove`. Node runs a copy of the launcher from the run directory, whose `node_modules` links to the installed toolchain's.

`src/force-prune.ts` has the node prune: it proves every checkpoint, builds the doomed blocks, then warps L1 past their epoch's proof window with `RollupCheatCodes.advanceToEpoch`, and the node's archiver removes them. The test (`src/epoch-prune.prune.ts`) plays two scenarios on one network, reading every depth and hash from the run, since tx packing changes them:

1. **Replaced at once.** The doomed blocks hold two account deployments, which the node mines again at once in a replacing block. Through REST: the canonical chain is the node's, starting from the node's genesis (not the SDK's constant), with nothing above its tip; one reorg, rooted at the first removed height, counting the removed blocks; each tx not dropped, its effect and its account contract on the node's new block; each dead block served by its hash, as orphaned.
2. **A shorter chain.** The doomed blocks are empty, so the node sits on the shorter chain. For 15 s the websocket publisher relays no block and no tips from the listener, and the API keeps the dead blocks canonical. Then one tx makes the node build at the first pruned height, and the API applies the prune: the node's chain above the target, one reorg rooted at the first dead block, the dead blocks orphaned.

The listener reads the node through `src/rpc-tap.ts`, a pass-through proxy on the run's `aztecAdmin` port that records each of its reads of the proposed tip in `logs/rpc-tap.jsonl`. From those reads each scenario prints which state of its prune the listener read first: `listener order: shorter-chain-first` (the tip at the prune target, before the replacement) or `listener order: replacement-first`. The node builds the replacement 0.15–0.35 s after the prune, so either can happen; the checks hold for both.

Each scenario starts once the API agrees with the node up to the proven base, so it judges its own prune. The deployments publish their account instances, which an account deployment skips by default, after one deployment publishes the account class: without that the explorer stores no contract to check.

## compare-chain

`scripts/compare-chain.ts` checks, read-only, that an explorer API's canonical chain is a node's. Node 24 runs it directly:

```sh
COMPARE_NODE_URL=<node JSON-RPC> COMPARE_API_URL=<API base URL> node scripts/compare-chain.ts sample | window | reorgs | watch
```

- `sample`: the API's top 40 heights against the node's hashes. It reads the node's tips before and after, and marks the sample `blind` if they moved.
- `window`: every height from the node's finalized tip to its proposed tip, one API call every 2 s.
- `reorgs`: each `/l2/reorgs` record whose dead root block is still on the node's chain.
- `watch`: `sample` every minute, `reorgs` every 10 minutes and `window` every hour, until stopped. It also reports a height whose API hash and node hash both changed as a witnessed prune.

Each check prints one JSON line, with the first mismatch and the count; a one-shot check exits 1 on a mismatch. `COMPARE_API_URL` is a base URL without a query. The URLs can hold an API key, so they are never printed: a failed node call prints only its operation and HTTP status (the SDK's message names the host and can quote the server's error body), a failed API call its path and status, and every line is printed with each part of both URLs redacted.

## Reading a failure

- Marks with elapsed seconds go to stdout and to `<run>/marks.txt`. The last mark shows the stage that failed.
- A setup stage that times out names what it waited for. A child that dies is named with the tail of its log.
- Every process logs to `<run>/logs/<name>.log`. On failure the harness saves the compose logs to `.harness/<id>/`.
- Test 6 names the service and topic. The handler's error is in that service's log, next to `Provided callback for topic ... failed`.

## Limits

- **The local network is not a live network.**
  - The automine sequencer builds one block per checkpoint, only when transactions arrive, and warps L1 time to each slot.
  - The proven tip moves by a storage write, so no `L2ProofVerified` event is emitted and nothing proof-related is checked.
  - There are no multi-block checkpoints. The only reorgs are the epoch prunes `yarn smoke:prune` forces, by warping L1 time, not by an L1 reorg.
- **Interfaces.** anvil and the prune mode's launcher bind `127.0.0.1`; the launcher serves no admin API. The stock node's RPC and admin ports, explorer-api and the websocket publisher have no host option and listen on all interfaces. The admin API keeps authentication on with a random key hash generated per run, and the network holds only the public test accounts. Run it on a host whose network you trust.
- **Kills and supply chain.**
  - A SIGKILL of the runner leaves its processes and project for `down <run>`. A kill during the harness's `up()` leaves a labelled project for `yarn harness down`. A kill during the first toolchain install can leave `npm ci` running and an `aztec-*.tmp-<run>` directory in the toolchain dir.
  - `yarn npm audit` does not cover the toolchain's npm tree.
