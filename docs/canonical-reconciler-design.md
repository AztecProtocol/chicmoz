# AztecScan canonical reconciler design

Draft for engineering review, 29 September 2026. Based on deployed Chicmoz
`f3ec5887c3d7d8c1c375f69bd9bddd8eaf54daf7`. This document proposes future
behavior; it does not describe an implemented repair service.

AztecScan needs to detect and repair stored blocks whose hashes disagree with
its trusted node, including heights that are present in the database. Start
with an observation-only scanner. Enable automatic repairs only after block
replacement preserves contract metadata and every block writer obeys the same
transaction and authority rules.

## Why gap backfill cannot finish this repair

The deployed handler skips a block when its transactions belong to another
active block that its own reorg would leave active. This prevents a Kafka
consumer from retrying the same conflict forever, but leaves the competing
block active. Re-requesting the missing height repeats the conflict.

The current reconciliation loop discovers missing heights and periodically
replays a tip window. An older height containing the wrong active hash is
present, so a complete repair requires comparing stored hashes with a node.

There is a second constraint: `tx_effect.tx_hash` is a primary key, so two fork
occurrences cannot coexist. The existing retry path deletes orphaned owner
blocks to free that key. Block deletion also cascades into registered classes,
deployed instances, and user-supplied metadata. Merely automating the incident's
orphan-and-backfill operation would expose this destructive path more often.

Sources: [block handler](../services/explorer-api/src/events/received/on-block/index.ts),
[reconciliation loop](../services/explorer-api/src/svcs/reconciliation/l2-block-reconciliation.ts),
[transaction effects](../services/explorer-api/src/svcs/database/schema/l2block/body.ts),
and [contract tables](../services/explorer-api/src/svcs/database/schema/l2contract/index.ts).

## One source of repair authority

Configure one Foundation-operated RPC endpoint per network for reconciliation.
Use a dedicated client in explorer-api with private network access. Keep tips,
block reads, and validation on that endpoint for the entire scan batch. Do not
use the listener's rotating RPC pool, or a Kafka message's delivery time or
topic, to decide which fork is canonical.

The scanner records the network, L1 chain, rollup address and version, configured
node identity, observation time, and proven tip height and hash. Its initial
automatic scope is heights at or below that proven tip. The node is trusted
infrastructure: its assertion that a block is proven is not independently
verified by this design. Proposed-only forks remain outside automatic repair.

Before accepting a batch, read the node identity and tips again. Confirm the
starting proven anchor still has the same hash, the rollup identity is unchanged,
and the endpoint has not regressed below the anchor. Validate each returned
block's computed hash, height, and rollup version. A growing proven tip is fine;
an incompatible anchor, missing block, or RPC failure invalidates the batch.
Do not record a mismatch when the node could not supply a block.

Persist an authority epoch and anchor. A rollup change, conflicting previously
accepted proven hash, or proven-tip regression halts repairs and raises an
operator-visible fault. Starting a new epoch requires explicit operator review;
neither silently taking the maximum tip nor automatically failing over to another
node resolves conflicting evidence. Reads have deadlines, and an observation
older than a configured lease must be refreshed before committing a repair.

## Scan present blocks as well as missing heights

Use bounded pages of heights scoped to the configured rollup, comparing each
node hash against all active database rows at that height. Record matches,
missing heights, conflicting hashes, and multiple-active-row violations
separately. Include the stored row hashes in the observation so a later repair
can detect intervening writes.

Keep a persistent historical cursor, a cursor following newly proven heights,
and a deduplicated queue for `SKIPPED_BLOCK_TX_CONFLICT` heights and owners.
Reserve work for each queue so a stream of new conflicts cannot starve the
historical scan. A conflict owner above the proven boundary or in another
rollup is diagnostic evidence, not permission to orphan it.

Proposed starting limits are 100 heights per batch, two concurrent RPC reads,
one batch every 30 seconds, and one repair transaction at a time. They are
tuning values, not measured capacity. Reserve a small share for a repeated
historical sweep: a cursor that visits each height only once would miss later
corruption. Persist failed work with bounded backoff; advance coverage only
after all heights in that page have valid observations or durable retry items.

## Preserve fork occurrences before enabling repair

The prerequisite schema changes are substantive and should be reviewed as a
separate migration:

- Give transaction effects an occurrence identity, unique per block and
  transaction hash. Keep a non-unique index for transaction-hash lookup, and
  migrate every dependent foreign key, including public data writes, to the
  occurrence identity. Canonical transaction queries must join the active block
  rather than return an arbitrary occurrence.
- Separate contract registration and deployment occurrences from stable
  contract identities. Keep source verification, uploaded artifacts, deployment
  arguments, and deployer metadata on stable identities with the appropriate
  network and rollup scope. Fork changes must never cascade-delete that data.
- Represent the selected block at each height explicitly, with one canonical
  mapping per network, rollup, and height. Initially the current orphan fields
  can be maintained alongside that mapping; all readers must agree on the
  selection before cutover.

Inventory all foreign keys and consumers before choosing the final migration
DDL. Backfill occurrence identities and stable metadata, validate row counts
and references, then switch readers and writers in stages. Existing verification
data must survive both forward migration and rollback of the application.
Do not deploy a repair worker that relies on deleting an entire block to resolve
a uniqueness constraint. Database backups alone do not make that operation a
correct canonicalization strategy.

## Commit evidence and replacement together

Fetch and validate the proposed replacement outside the database transaction.
Prepare all chain-derived contract data before acquiring a lock; no network
calls belong inside the transaction.

Every mutating path must then acquire the same transaction-scoped advisory
lock for its network and rollup: live blocks, catch-up blocks, tip repair, and
canonical repair. A worker-only lock leaves races with the existing consumers.
Pass the transaction object through the block store, contract store, orphan
updates, gap bookkeeping, and dependent hooks; none may quietly use a separate
pool connection.

Under the lock, recheck the authority epoch and observation lease, the expected
active hashes, affected transaction occurrences, and the previously accepted
canonical decisions. If anything changed, discard this prepared repair and
re-observe. A matching block is an idempotent success; an orphaned matching
occurrence may be selected without recreating it or losing its metadata.

Insert any missing immutable occurrences, select the validated canonical
occurrence, update orphan indicators, record the repair evidence and outcome,
and mark the corresponding gap fulfilled in one commit. Never orphan every
higher block merely because one historical height disagrees. Repair additional
heights only when they have their own validated evidence, and keep unresolved
dependent projections marked incomplete until repaired.

Persist accepted canonical hashes at repaired or confirmed proven heights. A
delayed live or catch-up message with a different hash must not overwrite them:
record a reconciliation request and acknowledge that conflicting message.
Transient database errors still propagate for Kafka redelivery. Only a fresh
observation in the accepted authority epoch may alter a confirmed decision.

Side effects outside Postgres, including cache invalidation and WebSocket
notifications, go through a transactional outbox. Retrying publication must
not repeat database mutations. Transaction and contract API reads select only
canonical occurrences, while fork history remains available explicitly.

## Recovery and observability

Repair evidence should include before and after hashes, the trusted node and
anchor, rollup identity, observation timestamps, attempt ID, and outcome.
Retrying after a crash must either find that same committed outcome or safely
retry the uncommitted work. Persist unresolved conflicts instead of treating
an acknowledged Kafka message as a completed repair.

Expose last successful observation time, historical coverage, distance behind
the proven tip, mismatch and unresolved-conflict counts, repair outcomes, and
outbox lag. Alert on stalled coverage or a broken authority anchor even when
the newest indexed block is fresh. The current freshness checks measure the
tip; they do not establish historical canonical correctness.

The repair enable flag must stop new mutations immediately while leaving
observation and reporting available. Retain audit rows and fork occurrences
when rolling back the application. Restoring a previous canonical selection
requires new authority evidence; replaying the journal backward is not a safe
chain decision.

## Delivery and acceptance

1. Ship the bounded observation-only scanner and reporting. Compare its
   results with a manual hash scan on a fixed proven anchor and exercise node
   failures, rollup changes, and restarts.
2. Migrate occurrence identities and contract metadata preservation. Refactor
   all writers to share transaction and authority enforcement while automatic
   repair remains disabled.
3. Exercise repair on staging copies of incident data. Verify conflict owners
   across heights, shared transactions across forks, orphan reactivation,
   stale Kafka replay, and concurrent live and catch-up writes using real
   Postgres transactions and the actual constraints.
4. Test crashes before commit, after commit and before acknowledgement, and
   between outbox commit and publication. Verify that contract source,
   artifacts, deployment arguments, and metadata remain byte-for-byte intact,
   including metadata for descendants in other blocks.
5. Enable a small operator-selected batch of proven repairs on one network,
   compare the affected range with the node again, and expand only after the
   invariants and coverage measurements hold.

Before automatic enablement, settle the final occurrence schema, cache and
derived-projection invalidation list, authority lease, and the operator procedure
for conflicting proven anchors. Implementing the observation-only scanner does
not depend on those decisions; automatic repair does.
