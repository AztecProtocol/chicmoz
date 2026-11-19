# Recorded fixtures

Real Aztec 6.0.0 data for tests: blocks, node answers, Kafka frames, decoded L1
logs and explorer-api bodies. Every file comes from one recorder command
(below) and names the call that produced it in `origin`.

```ts
import { listFixtures, loadFixture } from "@chicmoz/test-harness";

for (const name of listFixtures("local-network", "l2-block")) {
  const { data, features } = loadFixture("local-network", "l2-block", name);
}
```

## Layout and format

`<source>/<kind>/<name>.json`, where `source` is `local-network` (a local
`aztec start --local-network` with event-cannon traffic) or `testnet` (public
testnet, read only).

Each file is an envelope:

```json
{ "format": 1, "kind": "l2-block", "source": "testnet", "aztecVersion": "6.0.0",
  "recordedAt": "<ISO date>", "origin": "aztec_getBlock(46972, ...)",
  "features": ["empty"], "data": { ... } }
```

`data` is checked against the schema for its kind in `src/fixtures/format.ts`;
unknown fields are rejected. Inside `data`, `{"$bigint": "1"}`, `{"$hex": "00ff"}`
(a `Buffer`) and `{"$date": "<ISO>"}` stand for values JSON cannot hold.

| Kind                   | `data`                                                                                                                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `l2-block`             | `hex`: `L2Block.toBuffer()`, the bytes aztec-listener publishes; `expected`: what the node's JSON answer said (hash, archive root, height, checkpoint number and index, tx hashes, per-kind counts, published class ids, deployed instance addresses) |
| `checkpoint`           | number, archive root, first block, block count, L1 publish info                                                                                                                                                                                       |
| `node-info`, `l2-tips` | the JSON-RPC result, limited to known fields                                                                                                                                                                                                          |
| `frame`                | a Kafka message value as published (BSON, hex), its network id and event type; the topic is `<namespace>.<l2NetworkId>__<eventType>`                                                                                                                  |
| `l1-log`               | one viem `getContractEvents` log (`eventName` and `args` decoded from `topics` and `data`), its block timestamp and transaction sender                                                                                                                |
| `api-body`             | an explorer-api response: route, path, status, the UI module that parses it, body                                                                                                                                                                     |

`features` tags what a fixture contains (`empty`, `public-logs`,
`public-data-writes`, `class-publish`, `instance-deploy`,
`multi-block-checkpoint`, `checkpoint-<n>`). `synthetic` marks hand-written
data; there is none yet.

## Publication rules

Fixtures are public. The recorder keeps only known fields, replaces ENRs, IP
addresses outside loopback and the documentation ranges, and URLs to other
hosts, reduces allowed URLs to their origin, and drops secret-named keys. It
refuses to write a file that still holds a private-zone or cloud host name, a
home path, a secret-named query parameter, this machine's name, or (in a
frame) a BSON binary value. `src/fixtures/fixtures.test.ts` applies the same
checks to every committed file and every frame's decoded BSON; its messages
never quote the offending value. Block bytes are byte-exact chain data and
cannot be rewritten; only public-chain or local-network blocks belong here.
Fixture names are lowercase words joined by `-`.

## Recording

From `packages/test-harness`, `yarn record-fixtures <target> --source <source> ...`
(builds the harness, then runs `build/recorder/cli.js`; with no arguments it
prints the usage). Within one run, requests to a non-loopback host are at least
1 s apart; each is logged to stderr. No command takes or sends a key.

**Testnet** (`<testnet node>` and `<sepolia rpc>` are public keyless endpoints):

```sh
# node info, tips, checkpoint 33600 and its six blocks
yarn record-fixtures node --source testnet --url <testnet node> --checkpoint 33600 --find-multi-block

ROLLUP=0x1f435a7f2da358caf887a470faeee7d5d5f4efba
l1() { yarn record-fixtures l1 --source testnet --rpc <sepolia rpc> --aztec-version 6.0.0 --chunk 1 --max-requests 1 "$@"; }
l1 --name checkpoint-proposed-33600 --contract rollup --address $ROLLUP --event CheckpointProposed --arg checkpointNumber=33600 --from 12169706 --to 12169706
l1 --name proof-verified-33608 --contract rollup --address $ROLLUP --event L2ProofVerified --arg checkpointNumber=33608 --from 12169799 --to 12169799
l1 --name rollup-validator-queued --contract rollup --address $ROLLUP --event ValidatorQueued --from 12109851 --to 12109851
l1 --name deposit-to-aztec-public --contract feeJuicePortal --address 0xe59acba462a0324b1d619a7a1b219419f156f505 --event DepositToAztecPublic --from 12168183 --to 12168183
l1 --name governance-proposed --contract governance --address 0xcaf7447721447b22cd0076ac7c63877c3afd329f --event Proposed --from 11969282 --to 11969282
l1 --name governance-vote-cast --contract governance --address 0xcaf7447721447b22cd0076ac7c63877c3afd329f --event VoteCast --from 11969294 --to 11969294
```

Without a known block, search a range instead: `--from <a> --to <b> --chunk 1000
--direction backward` takes the newest match.

**Local network**: start an Aztec 6.0.0 local network, the infra compose
project and the chicmoz services, run event-cannon once, then:

```sh
yarn record-fixtures node --source local-network --url http://127.0.0.1:<aztec port> \
  --scan 1..<tip> --want public-logs,class-publish,instance-deploy
yarn record-fixtures kafka --source local-network --connection 127.0.0.1:<kafka port> \
  --namespace <namespace> --network SANDBOX --events PENDING_TXS_EVENT,L2_TIPS_EVENT,CHAIN_INFO_EVENT \
  --aztec-version 6.0.0 --max 1
yarn record-fixtures api --source local-network --base-url http://127.0.0.1:<explorer-api port> \
  --routes src/recorder/local-network-routes.json --aztec-version 6.0.0
```

Every `node` run also records node info and tips. `--scan` records the first
block with each wanted feature: here a class publication and a deployment of
that class from the network's own setup (blocks 1 and 2), and public logs from
event-cannon traffic. `src/recorder/local-network-routes.json` lists one or
more routes per UI module. Its tx hash, class id and instance address come
from the recorded blocks and change on every network start: replace them with
the new blocks' values before re-recording.

The API and Kafka targets accept loopback addresses only. `fixtures.test.ts`
lists every file other suites rely on; update it when a re-record renames one.

## Known limits

- API bodies come from a local explorer-api; the public testnet API needs a key.
- No dropped-tx or fee-juice-deposit body; the local pending-tx, governance and
  validator lists are empty (the local network drops nothing, bridges nothing,
  and has no governance or validator activity).
- No recorded block carries an L2-to-L1 message.
- Local-network values (hashes, addresses) change on every network start, so a
  re-record replaces those files whole.
