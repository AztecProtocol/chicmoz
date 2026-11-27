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

Each run gets an id (`ns` + 10 hex) used as its Kafka namespace, its own compose project and databases, and its own process groups, so parallel runs on one host do not collide. Its ports are claimed in the host's port registry, `~/.agents/ports.md`, which other tools on the host read and write under the same lock (`src/port-registry.ts`); the claim lasts while the runner lives. Teardown stops only the run's own groups and project and releases its ports, on success, failure, Ctrl-C or SIGTERM. A group that survives SIGKILL keeps the ports claimed and fails the run, as does a release that fails. A run binds every port it claims, `NETWORK_SMOKE_PORTS` too, so it never claims one that a survivor still holds. A known limit: a SIGKILL of the runner ends its claims with its PID while its children run on, so another run can claim a port that a child has not bound yet; closing that gap would take the children's process groups in the registry.

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

The node serves the SDK's `AztecNodeApiSchema` through the SDK's own server and answers any method it does not implement with "Method not found". Its chain (`src/scripted-chain.ts`) grows blocks 1–10, proves and finalizes 1–6, then prunes 7–10 and grows 7′–12′ on 6. The block that deploys a contract dies at 8; its tx is mined again in 7′. The test (`src/prune.scripted.ts`) steps the node through each state on its control port (the `aztecAdmin` port: `GET /script`, `POST /script/step`), waits up to 30 s for the API to serve what it expects, then until the API's consumers have committed every record the broker held at that point, and checks through REST only what it reads after that:

1. Heights 1–12 serve the final chain, and nothing exists at 13.
2. `/l2/reorgs` lists one reorg: height 7, 4 blocks, rooted at the dead 7.
3. The moved tx is not dropped, its effect is on 7′, and the contract instance is on 7′.
4. Each dead block is served by its hash, as orphaned.
5. `scripts/compare-chain.ts` finds no mismatch before the prune. After it, `sample` and `window` each read the heights they should (the API's top 40; the node's finalized to proposed tip) and name the first divergence within them, without printing either URL.

That prune's replacing block is there at once. Then the script prunes the other way: 7′–12′ become proven and finalized, 13′–16′ grow with a tx at 14′, and the node serves the shorter chain, tip 12′, before it proposes 13″ with that tx and grows 13″–16″. The test holds the shorter chain for at least 7 s and until a pass of the listener has handled it, 15 s at most. Holding a longer chain, the SDK's block stream walks back from its own tip, reading heights the node lacks, then rereads the tips in the same pass, so a walk after a tip read that follows a walk is the next pass's, and the first has ended. Tip reads alone show neither, since an election probes nodes it may not follow. The quiet window opens when the node answers the listener's first read of the shorter tip, so what the pass over the old chain sent is stamped before it, and closes when the node moves on. The checks:

1. While the node serves the shorter chain, a pass of the listener handles it; no block or tips record is stamped in the window, counted by record timestamp once the API has settled, so a record that lands late still counts; and the API keeps serving 13′–16′ and its reorgs from the window's start to just before the node moves on.
2. Heights 13–16 serve 13″–16″, and nothing exists at 17.
3. `/l2/reorgs` is the list from before the prune plus one reorg: height 13, 4 blocks, rooted at the dead 13′.
4. The moved tx is not dropped, and its effect is on 13″.
5. Each dead block is served by its hash, as orphaned.

Before each prune the test waits until the API holds the blocks it removes, with the moved tx's effect (and in the first, its contract) on its dead block, so neither can pass as a first insert. After both, the broker must hold every block record in one of the topic's 3 partitions: steps 2 s apart reach the API in order from any partition, so only the broker shows whether the records share one. Their order within it is not read.

`logs/scripted-node.log` has each state change and every block lookup with the state it was answered in.

## Prune mode

`yarn smoke:prune` starts the same services, toolchain and isolation as `yarn smoke`, with the block topic on 3 partitions, but runs the local network through `toolchain/local-network.mjs`: `createLocalNetwork` with the epoch auto-settle off, which the stock CLI cannot turn off. There the proven and finalized tips move only on `aztecDebug_prove`. Node runs a copy of the launcher from the run directory, whose `node_modules` links to the installed toolchain's.

`src/force-prune.ts` has the node prune: it proves every checkpoint, builds the doomed blocks, then warps L1 past their epoch's proof window with `RollupCheatCodes.advanceToEpoch`, and the node's archiver removes them. The test (`src/epoch-prune.prune.ts`) plays two scenarios on one network, reading every depth and hash from the run, since tx packing changes them:

1. **Replaced at once.** The doomed blocks hold two account deployments, which the node mines again at once in a replacing block. Through REST: the canonical chain is the node's, starting from the node's genesis (not the SDK's constant), with nothing above its tip; one reorg, rooted at the first removed height, counting the removed blocks; each tx not dropped, its effect and its account contract on the node's new block; each dead block served by its hash, as orphaned.
2. **A shorter chain.** The doomed blocks are empty, so the node sits on the shorter chain. For 15 s the websocket publisher relays no block and no tips from the listener, and the API keeps the dead blocks canonical. Then one tx makes the node build at the first pruned height, and the API applies the prune: the node's chain above the target, one reorg rooted at the first dead block, the dead blocks orphaned.

The listener reads the node through `src/rpc-tap.ts`, a pass-through proxy on the run's `aztecAdmin` port that records each of its reads of the proposed tip in `logs/rpc-tap.jsonl`. From those reads each scenario prints which state of its prune the listener read first: `listener order: shorter-chain-first` (the tip at the prune target, before the replacement) or `listener order: replacement-first`, by the earliest answer that shows either, whichever request went out first. The node builds the replacement 0.15–0.35 s after the prune, so either can happen; the checks hold for both.

Each scenario starts once the API agrees with the node up to the proven base, so it judges its own prune. The deployments publish their account instances, which an account deployment skips by default, after one deployment publishes the account class: without that the explorer stores no contract to check.

## compare-chain

`scripts/compare-chain.ts` checks, read-only, that an explorer API's canonical chain is a node's. Node 24 runs it directly:

```sh
COMPARE_NODE_URL=<node JSON-RPC> COMPARE_API_URL=<API base URL> node scripts/compare-chain.ts sample | window | reorgs | watch
```

- `sample`: the API's top 40 heights against the node's hashes. It reads the node's tips before and after, and marks the sample `blind` if they moved.
- `window`: every height from the node's finalized tip to its proposed tip, one API call every 2 s.
- `reorgs`: each `/l2/reorgs` record whose dead root block is still on the node's chain.
- `watch`: `sample` every minute, `reorgs` every 10 minutes and `window` every hour, until stopped. A failed check is reported and skips only itself. It reports a witnessed prune at a height where the API and the node agree on a hash other than the one they last agreed on there; only samples that are not blind count.

Each check prints one JSON line, with the first mismatch and the count; a one-shot check exits 1 on a mismatch and 2 when a call fails. `COMPARE_API_URL` is a base URL without a query. Each request to either side gives up after `COMPARE_TIMEOUT_MS` (15 s by default), and a node read gets one attempt. The URLs can hold an API key, so they are never printed: a failed node call prints only its operation and its HTTP status or timeout (the SDK's message names the host and can quote the server's error body), a failed API call its path and status, and every line is printed with both URLs redacted. A server can echo a key inside a valid answer, such as a hex key as a block hash, so each path segment, query value and fragment of 8 characters or more is redacted on its own too, raw or decoded, in any case.

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
  - A SIGKILL of the runner leaves its processes, its project and, during the first toolchain install, its `aztec-*.tmp-<run>` staging directory in the toolchain dir, for `down <run>`. `down` looks in the toolchain dir of its own environment, so it needs the run's `NETWORK_SMOKE_TOOLCHAIN_DIR`, and fails on a toolchain dir it cannot read. A kill during the harness's `up()` leaves a labelled project for `yarn harness down`.
  - Known limits: the `npm ci` such a kill orphans is not stopped; it exits on its own, and can write into the staging directory again if it outlives `down`. A kill before `up()` starts the first container can leave the project's network or volumes, which `yarn harness ls` and `yarn harness down` do not see, since they go by containers.
  - `yarn npm audit` does not cover the toolchain's npm tree.
