import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { brokerReads } from "./broker.js";
import {
  type HeightRange,
  checkRanges,
  firstMismatch,
} from "./compare-ranges.js";
import { apiStop, listenerStop } from "./crash-stops.js";
import { readScriptedEndpoints } from "./endpoints.js";
import {
  type ReorgRecord,
  byRoot,
  explorerReads,
  plusReorg,
  served,
  settle,
} from "./explorer-reads.js";
import {
  type BlockId,
  type PruneFacts,
  type ScriptStatus,
  scriptControl,
} from "./script-control.js";
import { serviceControl } from "./service-control.js";
import { type ShortHold, type StepTimes, stepThrough } from "./step-through.js";

const endpoints = readScriptedEndpoints();
const control = scriptControl(endpoints.controlUrl);
const api = explorerReads(endpoints.explorerApiUrl);
const broker = brokerReads(endpoints.broker);
const services = serviceControl(endpoints.servicesUrl);
const { databases, ...pgAccess } = endpoints.postgres;

afterAll(() => broker.close());

// Two of the listener's 1 s polls per state.
const STEP_MS = 2_000;
// For the API to reach what a scenario expects after its last step, which a
// correct pipeline does in a few polls; it bounds the commit wait too.
const SETTLE_TIMEOUT_MS = 30_000;
// Longer than the API's 5 s block cache.
const CACHE_MS = 6_000;

const range = (from: number, to: number) =>
  Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

/** What the API serves of one prune, from height `from` to one past the node's tip. */
const snapshot = async (
  prune: PruneFacts,
  from: number,
  contractAddress?: string,
) => ({
  latestHeight: await api.latestHeight(),
  canonical: await Promise.all(
    range(from, prune.final.length + 1).map(api.blockAt),
  ),
  reorgs: byRoot(await api.reorgs()),
  dropped: await api.dropped(prune.movedTx.hash),
  txEffect: await api.txEffect(prune.movedTx.hash),
  contractInstance:
    contractAddress === undefined
      ? undefined
      : await api.contractInstance(contractAddress),
  dead: await Promise.all(prune.dead.map((b) => api.blockAt(b.hash))),
});

type Snapshot = Awaited<ReturnType<typeof snapshot>>;

// Scenarios run one after another, each ending on its settled read, so the
// time since the last one is the next one's runtime.
let lastSettledAt = Date.now();

/** The API once it has consumed what the broker held when `want` was met or its time ran out; a consumer that never catches up fails the scenario. */
const settled = async (
  read: () => Promise<Snapshot>,
  want: Partial<Snapshot>,
  label: string,
) => {
  const { value, met, held } = await settle(read, {
    want,
    timeoutMs: SETTLE_TIMEOUT_MS,
    intervalMs: 1_000,
    cacheMs: CACHE_MS,
    consumedThrough: broker.apiConsumedThrough,
  });
  const took = (Date.now() - lastSettledAt) / 1000;
  lastSettledAt = Date.now();
  process.stdout.write(
    `${label} (the scenario took ${took.toFixed(1)} s): ${met ? "expected state reached" : `expected state not reached in ${SETTLE_TIMEOUT_MS / 1000} s`}; once consumed, ${held ? "as expected" : "not as expected"}:\n${JSON.stringify(value, null, 2)}\n`,
  );
  return value;
};

/** Waits until the API serves each of `blocks` at its height, as canonical. */
const apiHolds = (blocks: BlockId[], label: string) =>
  vi.waitFor(
    async () =>
      expect(
        await Promise.all(blocks.map((b) => api.blockAt(b.height))),
        label,
      ).toEqual(blocks.map((b) => served(b, false))),
    { timeout: 60_000, interval: 1_000 },
  );

/**
 * Waits until the API holds what `prune` removes, the moved tx on its dead
 * block included: on the replacing block alone it would pass as a first
 * insert.
 */
const apiHoldsDead = async (prune: PruneFacts, label: string) => {
  await apiHolds(prune.dead, label);
  const deadHolder = prune.dead.find(
    (b) => b.height === prune.movedTx.deadHeight,
  );
  await vi.waitFor(
    async () =>
      expect(
        await api.txEffect(prune.movedTx.hash),
        "the moved tx before the prune",
      ).toEqual(deadHolder && served(deadHolder, false)),
    { timeout: 30_000, interval: 1_000 },
  );
};

const STEP_TIMES: StepTimes = {
  stepMs: STEP_MS,
  // Longer than today's 5 s tips poll, so a tips timer would show.
  holdMs: 7_000,
  // Many passes of the listener's poll: a listener that never handles the
  // shorter chain fails the check that needs it, not the whole scenario.
  holdLimitMs: 15_000,
  pollMs: 250,
};

/** The API's state that must not move while the node serves the shorter chain. */
const apiView = async (prune: PruneFacts) => ({
  latestHeight: await api.latestHeight(),
  dead: await Promise.all(prune.dead.map((b) => api.blockAt(b.height))),
  reorgs: byRoot(await api.reorgs()),
});

type ApiView = Awaited<ReturnType<typeof apiView>>;

/** Steps the node through `prune`, as `stepThrough` does, viewing the API. */
const stepPrune = (
  prune: PruneFacts,
  beforePrune: () => Promise<void>,
  afterPrune?: () => Promise<void>,
) =>
  stepThrough(control, prune, {
    beforePrune,
    afterPrune,
    view: () => apiView(prune),
    times: STEP_TIMES,
  });

const COMPARE_CHAIN = fileURLToPath(
  new URL("../scripts/compare-chain.ts", import.meta.url),
);

/** One check of the read-only checker against this run's node and API. */
const compareChain = (check: "sample" | "window") =>
  new Promise<{
    code: number;
    output: string;
    range?: HeightRange;
    firstMismatch: unknown;
  }>((resolve, reject) =>
    execFile(
      process.execPath,
      [COMPARE_CHAIN, check],
      {
        env: {
          ...process.env,
          COMPARE_NODE_URL: endpoints.aztecNodeUrl,
          COMPARE_API_URL: endpoints.explorerApiUrl,
        },
        timeout: 60_000,
      },
      (error, stdout, stderr) => {
        const code = typeof error?.code === "number" ? error.code : 0;
        if (error && code === 0) {
          reject(error);
          return;
        }
        let last: unknown;
        try {
          last = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
        } catch {
          // Not a JSON line: the raw output stands in for the result.
        }
        const line = z
          .object({
            from: z.number(),
            to: z.number(),
            firstMismatch: z.unknown(),
          })
          .safeParse(last);
        resolve({
          code,
          output: stdout + stderr,
          range: line.success
            ? { from: line.data.from, to: line.data.to }
            : undefined,
          firstMismatch: line.success ? line.data.firstMismatch : stdout,
        });
      },
    ),
  );

/** The node's block at each height from `from`, and a 404 one past its tip. */
const expectedFrom = (prune: PruneFacts, from: number) => [
  ...prune.final.filter((b) => b.height >= from).map((b) => served(b, false)),
  { status: 404 },
];

const movedTxBlock = (prune: PruneFacts, height: number) =>
  served(prune.final[height - 1], false);

/** The one reorg a prune adds: rooted at its first dead block, counting all of them. */
const reorgOf = (prune: PruneFacts): ReorgRecord => ({
  height: prune.dead[0].height,
  nbrOfOrphanedBlocks: prune.dead.length,
  orphanedBlockHash: prune.dead[0].hash.toLowerCase(),
});

/** What the API must serve once a prune has settled, read from height `from`, with the contract on `contractOn` if given. */
const wantAfter = (
  prune: PruneFacts,
  from: number,
  reorgs: ReorgRecord[],
  contractOn?: BlockId,
): Partial<Snapshot> => ({
  latestHeight: prune.final.length,
  canonical: expectedFrom(prune, from),
  reorgs,
  dropped: { status: 404 },
  txEffect: movedTxBlock(prune, prune.movedTx.finalHeight),
  ...(contractOn
    ? {
        contractInstance: {
          hash: contractOn.hash.toLowerCase(),
          orphaned: false,
        },
      }
    : {}),
  dead: prune.dead.map((b) => served(b, true)),
});

/** The first prune's replacing block, which deploys the script's contract. */
const contractBlock = ({ prunes: [first] }: ScriptStatus) =>
  first.final[first.movedTx.finalHeight - 1];

/** Checks a prune's settled state against `wantAfter`'s; `names` name the checks. */
const itServesTheScript = (
  read: () => { seen: Snapshot; want: Partial<Snapshot> },
  names: { chain: string; reorgs: string; tx: string },
) => {
  it(names.chain, () => {
    const { seen, want } = read();
    expect.soft(seen.latestHeight, "latest height").toBe(want.latestHeight);
    expect
      .soft(seen.canonical, "the canonical block at each height")
      .toEqual(want.canonical);
  });

  it(names.reorgs, () => {
    const { seen, want } = read();
    expect(seen.reorgs).toEqual(want.reorgs);
  });

  it(names.tx, () => {
    const { seen, want } = read();
    expect.soft(seen.dropped, "dropped-tx lookup").toEqual(want.dropped);
    expect.soft(seen.txEffect, "tx effect").toEqual(want.txEffect);
    if ("contractInstance" in want) {
      expect
        .soft(seen.contractInstance, "contract instance")
        .toEqual(want.contractInstance);
    }
  });

  it("serves each dead block by its hash, as orphaned", () => {
    const { seen, want } = read();
    expect(seen.dead).toEqual(want.dead);
  });
};

describe("a prune of blocks 7-10, replaced by 7'-12' on block 6", () => {
  let script: ScriptStatus;
  let prune: PruneFacts;
  let want: Partial<Snapshot>;
  let seen: Snapshot;
  let checkerBefore: Awaited<ReturnType<typeof compareChain>>;
  let checkerAfter: Record<
    "sample" | "window",
    Awaited<ReturnType<typeof compareChain>>
  >;
  let nodeTips: { finalized: number; proposed: number };

  beforeAll(async () => {
    script = await control.status();
    [prune] = script.prunes;
    await vi.waitFor(
      async () =>
        expect(
          (await control.status()).tipReads,
          "tip reads by the listener",
        ).toBeGreaterThan(1),
      { timeout: 60_000, interval: 500 },
    );
    const old = [
      ...prune.final.filter((b) => b.height < prune.dead[0].height),
      ...prune.dead,
    ];
    const deadHolder = prune.dead.find(
      (b) => b.height === prune.movedTx.deadHeight,
    );
    await stepPrune(prune, async () => {
      // The prune tests something only once the API holds what it removes,
      // the moved tx and its contract on their dead block included: on the
      // replacing block alone they would pass as a first insert.
      await apiHolds(old, "blocks 1-10 before the prune");
      await vi.waitFor(
        async () =>
          expect(
            {
              txEffect: await api.txEffect(prune.movedTx.hash),
              contractInstance: await api.contractInstance(
                script.contractAddress,
              ),
            },
            "the moved tx and its contract before the prune",
          ).toEqual({
            txEffect: deadHolder && served(deadHolder, false),
            contractInstance: {
              hash: deadHolder?.hash.toLowerCase(),
              orphaned: false,
            },
          }),
        { timeout: 30_000, interval: 1_000 },
      );
      checkerBefore = await compareChain("sample");
    });
    want = wantAfter(prune, 1, [reorgOf(prune)], contractBlock(script));
    seen = await settled(
      () => snapshot(prune, 1, script.contractAddress),
      want,
      "the API after the first prune",
    );
    checkerAfter = {
      sample: await compareChain("sample"),
      window: await compareChain("window"),
    };
    const tips = await createAztecNodeClient(
      endpoints.aztecNodeUrl,
    ).getChainTips();
    nodeTips = {
      finalized: Number(tips.finalized.block.number),
      proposed: Number(tips.proposed.number),
    };
  });

  it("has compare-chain name the API's first divergence from the node in each check's own range, and never print the endpoints", () => {
    const onApi = new Map(
      seen.canonical.flatMap((b) =>
        "hash" in b && !b.orphaned ? [[b.height, b.hash] as const] : [],
      ),
    );
    const onNode = new Map(
      prune.final.map((b) => [b.height, b.hash.toLowerCase()] as const),
    );
    const ranges = checkRanges({
      apiLatest: typeof seen.latestHeight === "number" ? seen.latestHeight : 0,
      nodeFinalized: nodeTips.finalized,
      nodeProposed: nodeTips.proposed,
    });
    expect
      .soft(checkerBefore, "before the prune")
      .toMatchObject({ code: 0, firstMismatch: null });
    for (const check of ["sample", "window"] as const) {
      const run = checkerAfter[check];
      const height = firstMismatch(ranges[check], onApi, onNode);
      expect.soft(run.range, `${check}: its range`).toEqual(ranges[check]);
      expect
        .soft(run.code, `${check}: exit code`)
        .toBe(height === undefined ? 0 : 1);
      expect
        .soft(run.firstMismatch, `${check}: first mismatch`)
        .toEqual(
          height === undefined ? null : expect.objectContaining({ height }),
        );
    }
    for (const run of [checkerBefore, ...Object.values(checkerAfter)]) {
      for (const url of [endpoints.aztecNodeUrl, endpoints.explorerApiUrl]) {
        expect.soft(run.output).not.toContain(new URL(url).host);
      }
    }
  });

  itServesTheScript(() => ({ seen, want }), {
    chain: "serves the script's final chain as canonical, and nothing above it",
    reorgs: "lists one reorg: the 4 blocks from height 7",
    tx: "keeps the moved tx mined, not dropped, and the contract on the replacing block",
  });
});

describe("a prune of blocks 13'-16' that serves the shorter chain, tip 12', before 13''-16'", () => {
  let prune: PruneFacts;
  let baseline: ReorgRecord[];
  let short: ShortHold<ApiView> | undefined;
  let published: { block: number; tips: number } | undefined;
  let want: Partial<Snapshot>;
  let seen: Snapshot;

  beforeAll(async () => {
    prune = (await control.status()).prunes[1];
    short = await stepPrune(prune, async () => {
      await apiHoldsDead(prune, "blocks 13'-16' before the prune");
      baseline = await api.reorgList();
    });
    want = wantAfter(
      prune,
      prune.dead[0].height,
      plusReorg(baseline, reorgOf(prune)),
    );
    process.stdout.write(
      `while the node served the shorter chain:\n${JSON.stringify(short, null, 2)}\n`,
    );
    seen = await settled(
      () => snapshot(prune, prune.dead[0].height),
      want,
      "the API after the second prune",
    );
    // Read once settled, so a record sent in the window has landed.
    const { from, to } = short ?? {};
    if (from !== undefined && to !== undefined) {
      published = {
        block: await broker.publishedBetween(
          endpoints.broker.blockTopic,
          from,
          to,
        ),
        tips: await broker.publishedBetween(
          endpoints.broker.tipsTopic,
          from,
          to,
        ),
      };
    }
  });

  it("publishes no block and no tips record, and keeps its state, while the node serves the shorter chain", () => {
    expect
      .soft(short?.unhandled, "states of the shorter chain no pass handled")
      .toEqual([]);
    expect
      .soft(published, "records stamped while the node served it")
      .toEqual({ block: 0, tips: 0 });
    expect.soft(short?.end, "the API's state").toEqual(short?.start);
  });

  itServesTheScript(() => ({ seen, want }), {
    chain:
      "serves the node's chain above 12' as canonical, and nothing above it",
    reorgs: "adds one reorg to those before it: the 4 blocks from height 13",
    tx: "keeps the moved tx mined, not dropped, on the replacing block",
  });
});

describe("a prune of 17''-18'' replaced by 17''' at once, with the listener killed between sending 17''' and storing it", () => {
  let script: ScriptStatus;
  let prune: PruneFacts;
  let replacing: BlockId;
  let baseline: ReorgRecord[];
  let stop: ReturnType<typeof listenerStop>;
  let want: Partial<Snapshot>;
  let seen: Snapshot;

  beforeAll(async () => {
    script = await control.status();
    prune = script.prunes[2];
    replacing = prune.final[prune.dead[0].height - 1];
    stop = listenerStop({
      pg: pgAccess,
      database: databases.listener,
      broker,
      blockTopic: endpoints.broker.blockTopic,
      services,
    });
    await stepPrune(
      prune,
      async () => {
        await apiHoldsDead(prune, "blocks 17''-18'' before the prune");
        baseline = await api.reorgList();
        await stop.arm(prune.dead);
      },
      () => stop.fire(replacing),
    );
    process.stdout.write(
      `the listener's stop:\n${JSON.stringify(stop.result, null, 2)}\n`,
    );
    want = wantAfter(
      prune,
      prune.dead[0].height,
      plusReorg(baseline, reorgOf(prune)),
      contractBlock(script),
    );
    seen = await settled(
      () => snapshot(prune, prune.dead[0].height, script.contractAddress),
      want,
      "the API after the listener's restart",
    );
  });

  it("kills the listener while its store's write of 17''' waits on the lock, with 17''' sent and the store on the prune's tip", () => {
    const { missed, waiting, atKill } = stop.result;
    expect.soft(missed, "why nothing was killed").toBeUndefined();
    expect.soft(waiting, "the write that waited").toEqual({
      database: databases.listener,
      statement: 'insert into "l2_block_stream_hash"',
    });
    expect
      .soft(
        atKill?.sent.map((r) => r.to - r.from),
        "records the batch had sent, per partition",
      )
      .toEqual([1]);
    expect.soft(atKill?.store, "the listener's store").toEqual({
      proposed: prune.dead[0].height - 1,
      hash: prune.dead[0].hash.toLowerCase(),
    });
  });

  it("sends 17''' again once restarted, under the same key", () => {
    const { records = [], recoveryMs } = stop.result;
    process.stdout.write(
      `from the listener's restart to its store holding 17''': ${recoveryMs} ms\n`,
    );
    const copy = {
      height: replacing.height,
      tip: replacing.height,
      hash: replacing.hash.toLowerCase(),
    };
    expect
      .soft(
        records.map(({ height, tip, hash, sentBeforeKill }) => ({
          height,
          tip,
          hash,
          sentBeforeKill,
        })),
        "block records sent from the prune on",
      )
      .toEqual([
        { ...copy, sentBeforeKill: true },
        { ...copy, sentBeforeKill: false },
      ]);
    const [first, second] = records;
    expect.soft(first?.key, "the first copy's key").toBeTruthy();
    expect.soft(second?.key, "the second copy's key").toBe(first?.key);
  });

  itServesTheScript(() => ({ seen, want }), {
    chain:
      "serves the node's chain above 16'' as canonical, and nothing above it",
    reorgs: "adds one reorg to those before it: the 2 blocks from height 17",
    tx: "keeps the moved tx mined, not dropped, on the replacing block, and the contract on 7'",
  });
});

describe("a prune of 20'''-21''' replaced by 20'''' at once, with the API killed between committing 20'''' and committing its offset", () => {
  let script: ScriptStatus;
  let prune: PruneFacts;
  let baseline: ReorgRecord[];
  let stop: ReturnType<typeof apiStop>;
  let want: Partial<Snapshot>;
  let seen: Snapshot;

  beforeAll(async () => {
    script = await control.status();
    prune = script.prunes[3];
    stop = apiStop({
      pg: pgAccess,
      database: databases.api,
      apiGroupPrefix: endpoints.broker.apiGroupPrefix,
      broker,
      blockTopic: endpoints.broker.blockTopic,
      services,
    });
    await stepPrune(
      prune,
      async () => {
        await apiHoldsDead(prune, "blocks 20'''-21''' before the prune");
        baseline = await api.reorgList();
        await stop.arm();
      },
      () => stop.fire(prune.final[prune.dead[0].height - 1], prune.dead),
    );
    process.stdout.write(
      `the API's stop:\n${JSON.stringify(stop.result, null, 2)}\n`,
    );
    want = wantAfter(
      prune,
      prune.dead[0].height,
      plusReorg(baseline, reorgOf(prune)),
      contractBlock(script),
    );
    seen = await settled(
      () => snapshot(prune, prune.dead[0].height, script.contractAddress),
      want,
      "the API after its restart",
    );
  });

  it("kills the API while its block handler's upsert after 20'''' waits on the lock, with 20'''' committed and its offset not", () => {
    const { missed, waiting, atKill } = stop.result;
    const [sent] = atKill?.sent ?? [];
    expect.soft(missed, "why nothing was killed").toBeUndefined();
    expect.soft(waiting, "the write that waited").toEqual({
      database: databases.api,
      statement: 'insert into "l2_rollup_version_observation"',
    });
    expect
      .soft(
        atKill?.sent.map((r) => r.to - r.from),
        "records the batch put on the topic, per partition",
      )
      .toEqual([1]);
    expect
      .soft(
        atKill?.canonical,
        "20'''' and the dead blocks in the API's database",
      )
      .toEqual({ replacing: true, dead: prune.dead.map(() => false) });
    expect
      .soft(atKill?.committed, "the API's committed offsets on that partition")
      .toEqual({ blockHandler: [sent?.from] });
  });

  it("consumes 20'''' again once restarted, and commits past it", () => {
    const { atKill, afterRestart, recoveryMs } = stop.result;
    const [sent] = atKill?.sent ?? [];
    process.stdout.write(
      `from the API's restart to its commit past 20'''': ${recoveryMs} ms\n`,
    );
    expect(afterRestart?.committed).toEqual({ blockHandler: [sent?.to] });
  });

  // The replayed batch is 20'''' alone, so the replay has no dead block to
  // bring back, and no record to write again.
  itServesTheScript(() => ({ seen, want }), {
    chain:
      "serves the node's chain above 19''' as canonical, and nothing above it",
    reorgs:
      "adds one reorg to those before it, the 2 blocks from height 20, and none from the replay",
    tx: "keeps the moved tx mined, not dropped, on the replacing block, and the contract on 7'",
  });
});

describe("the block topic, after every prune", () => {
  // Spaced steps reach the API in order from any partition, so the scenarios
  // cannot show where the block records went; the broker can.
  it("holds every block record in one of its partitions", async () => {
    const partitions = await broker.recordsPerPartition(
      endpoints.broker.blockTopic,
    );
    expect(partitions.length, "partitions").toBeGreaterThan(1);
    expect(
      partitions.filter((p) => p.records > 0),
      "partitions holding records",
    ).toHaveLength(1);
  });
});
