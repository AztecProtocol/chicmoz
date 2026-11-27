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
3. `/l2/reorgs` lists two reorgs: the first prune's, and height 13, 4 blocks, rooted at the dead 13′.
4. The moved tx is not dropped, and its effect is on 13″.
5. Each dead block is served by its hash, as orphaned.

Then the script prunes twice more, each time with the replacing block there at once, and the test kills a service while it handles the prune, then starts it again (`src/crash-stops.ts`). It stops the service with a row lock, held from a Postgres session of its own on a row the service writes at that point. Before it kills the service's process group with SIGKILL through the runner (`src/service-control.ts`, on the port scripted mode leaves to anvil), it proves from `pg_stat_activity` and `pg_blocking_pids`, read from a second session, that the service's write is held up by the lock: waiting on it, or queued behind a session that is. The run names each service's Postgres sessions after the service (`PGAPPNAME`, which `pg` sends as `application_name`), and the stop finds the service's writes by that name. It also reads, through SQL and the broker, the state that stop implies (below), and kills only when it is the expected one. It then ends every session the service opened, whatever it is doing, checks that none is left, releases the lock, and starts the service again with the command and environment the run first used. A session never sees its client go, and a statement it had sent, waiting on the lock or not yet, would run once the lock is released, and an autocommit one would commit. So once the kill is sent, if it fails, or ending those sessions fails or leaves one, the scenario fails with the lock still held for the rest of the suite, rather than let that write land in what later scenarios read. A crash scenario after it fails at once, and the run's teardown removes the database. A service that does not reach its stop within 15 s, or reaches it in another state, fails the scenario's first check, and nothing is killed. So does a stop proven after those 15 s: the deadline is checked again just before the kill, since a hook that timed out runs on and its kill would land in a later scenario. The stop's broker reads give up after 10 s, as its SQL statements and connections do. Each restart takes about 30 s: the killed member's Kafka session has to end before the service's consumers join.

1. **The listener, between sending a batch and storing it** (17″–18″, replaced by 17‴ on 16″). The lock is on the listener store's hash row at height 17. The stop depends on the listener's block stream handler sending a batch's blocks before it stores them, on the SDK's store writing each block's hash before the tip, and on the prune leaving the hash rows above its target as they are. At the kill, the topic holds one more record, and the store is still on 16″, with 17″ at 17. Once restarted, the listener finds the node in sync and sends 17‴ again, under the same key. The checks: those two copies; heights 1–19 serve the node's chain, 17‴–19‴ on top, and nothing exists at 20; `/l2/reorgs` lists three reorgs: the earlier prunes', and height 17, 2 blocks, rooted at the dead 17″; the moved tx is not dropped, and its effect is on 17‴; the contract instance stays on 7′; each dead block is served by its hash, as orphaned. A restart that finds only nodes behind the sent batch is a known limit of the listener, and is not played.
2. **The API, between a block's commit and its offset's** (20‴–21‴, replaced by 20⁗ on 19‴). Once the API's consumers have committed every record, the lock is on the API's rollup-version observation rows, which its block handler upserts after each block it applies. Its catch-up, chain-info, staking-asset and node-info handlers upsert them too, each while its group holds a record it has not committed, and a group handles one record at a time. So the stop counts as reached only when the lock holds up more of the API's upserts than those four groups, counted by id, hold uncommitted records. Each group is judged by its committed offsets, which outlive a member that expired while its handler waited. At the kill, the topic holds one more record, 20⁗ is canonical in the API's database and 20‴–21‴ are not, and the block group's committed offset is still that record's, with no other API group on that partition. The lock stays through the restart, and the check reads the block group's committed offset twice. The first read comes once the restarted API's block handler is held up at the same upsert again, and the offset must still be the record's, which shows the record was consumed again. The second comes after the lock goes, and the offset must be past the record. An early commit before the restart fails the first read. The replayed batch is that record alone, so the replay brings back no dead block and writes no second reorg record; the REST checks are the first crash's, for heights 1–22 and four reorgs, the fourth at height 20. Where the API bumps its chain revision (the key of its cached chain reads) between the commit and that upsert, the kill comes after the bump: a crash between the two is not played, and the API bumps the revision again at start-up.

A listener without the block stream's store misses the first stop, and one that never sends a prune's replacing block misses the second; either way the scenario fails.

Before each prune the test waits until the API holds the blocks it removes, with the moved tx's effect (and in the first, its contract) on its dead block, so neither can pass as a first insert. The reorgs it expects are the script's, one per prune played so far, never a list read from the API, which would take in a record the API added between two scenarios. After the last prune, the broker must hold every block record in one of the topic's 3 partitions: steps 2 s apart reach the API in order from any partition, so only the broker shows whether the records share one. Their order within it is not read.

`logs/scripted-node.log` has each state change and every block lookup with the state it was answered in.

## Prune mode

`yarn smoke:prune` starts the same services, toolchain and isolation as `yarn smoke`, with the block topic on 3 partitions, but runs the local network through `toolchain/local-network.mjs`: `createLocalNetwork` with the epoch auto-settle off, which the stock CLI cannot turn off. There the proven and finalized tips move only on `aztecDebug_prove`. Node runs a copy of the launcher from the run directory, whose `node_modules` links to the installed toolchain's.

`src/force-prune.ts` has the node prune: it proves every checkpoint, builds the doomed blocks, then warps L1 past their epoch's proof window with `RollupCheatCodes.advanceToEpoch`, and the node's archiver removes them. The test (`src/epoch-prune.prune.ts`) plays two scenarios on one network, reading every depth and hash from the run, since tx packing changes them:

1. **Replaced at once.** The doomed blocks hold two account deployments, which the node mines again at once in a replacing block. Through REST: the canonical chain is the node's, starting from the node's genesis (not the SDK's constant), with nothing above its tip; one reorg, rooted at the first removed height, counting the removed blocks; each tx not dropped, its effect and its account contract on the node's new block; each dead block served by its hash, as orphaned.
2. **A shorter chain.** The doomed blocks are empty, so the node sits on the shorter chain. For 15 s the websocket publisher relays no block and no tips from the listener, and the API keeps the dead blocks canonical, while the listener keeps reading the node: no gap between its tip reads may exceed 4 polls plus the node's hold on a read of the block one past its tip. The run sets that hold (`RPC_UNSEEN_BLOCK_BY_NUMBER_WAIT_MS`) to 6 s, twice the block duration, as the node defaults to, so a walk back over the shorter chain waits as it would in production. Then one tx makes the node build at the first pruned height, and the API applies the prune: the node's chain above the target, one reorg rooted at the first dead block, the dead blocks orphaned.

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
- **Known limits of the checks.**
  - The broker reads that settle the API and count the quiet window's records run on KafkaJS's request timeout and retries, not on the settle's 30 s. A broker that stalls still fails the run, but on Vitest's hook timeout, whose message names no partition or group.
  - The API crash's replay check samples the block group's committed offset, and does not trace when a commit is issued. A commit that lands between the sample at the record and the unlock passes for the replay's.
  - `listener order` is informational. The tap reads each reply whole on the event loop that relays the tip reads, so a slow reply can delay a pass and the state it sees first. A tip read without a hash, between the prune target and the old tip, counts as the replacement, though the old chain held that height too. Either can change the printed order, never a check: the checks hold for both orders.
