import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const INTERVAL_MS = 120_000;
const TIP = 104_595;
const PROVEN_TIP = 104_539;
const dialect = new PgDialect();
const render = (condition: unknown) => dialect.sqlToQuery(condition as SQL);

type Gap = {
  id: string;
  fromHeight: number;
  toHeight: number;
  reason: string;
  status: string;
  statusHint: string;
  l2NetworkId: string;
  requestCount: number;
  lastRequestedAt: Date | null;
  firstSeenAt: Date;
  // Whether the SQL due filter would pass it (the formula itself is checked
  // on the rendered SQL).
  due: boolean;
};

const mocks = vi.hoisted(() => {
  const state = {
    gaps: [] as Gap[],
    presentHeights: [] as number[],
    upserts: [] as Array<{
      values: Record<string, unknown>;
      set: Record<string, unknown>;
    }>,
    inserted: [] as Array<Record<string, unknown>>,
    deleted: [] as unknown[],
    updates: [] as Array<Record<string, unknown>>,
    updateTargets: [] as unknown[][],
    tips: {} as { degradedReason?: string; provenTip?: number },
    publishFails: false,
    order: [] as string[],
  };
  const tableName = (table: object) =>
    (table as Record<symbol, string>)[Symbol.for("drizzle:Name")];
  const gapRows = (condition: unknown) => {
    // Called at query time, once the module-level dialect exists.
    const { sql } = render(condition);
    const open = state.gaps.filter((gap) => gap.status === "open");
    if (sql.includes('"l2_open_gap"."id" = $')) {
      return open.slice(0, 1);
    }
    // Honour the query's reason filter, so leaving it out shows up here.
    const byReason = sql.includes('"l2_open_gap"."reason" <> $')
      ? open.filter((gap) => gap.reason !== "tip_boundary_mismatch")
      : open;
    // In-flight query: open rows still in backoff.
    return sql.includes("not (")
      ? byReason.filter((gap) => !gap.due)
      : byReason;
  };
  // Mirrors getDueGaps (the due filter itself is checked on the SQL).
  const dueCandidates = (limit: number) =>
    state.gaps
      .filter(
        (gap) =>
          gap.status === "open" &&
          gap.due &&
          gap.reason !== "tip_boundary_mismatch" &&
          gap.fromHeight <= TIP,
      )
      .sort(
        (a, b) =>
          (a.lastRequestedAt?.getTime() ?? -Infinity) -
            (b.lastRequestedAt?.getTime() ?? -Infinity) ||
          a.firstSeenAt.getTime() - b.firstSeenAt.getTime(),
      )
      .slice(0, limit);
  const heightRows = () =>
    state.presentHeights.map((height) => ({ height: BigInt(height) }));
  const executor = {
    select: (fields?: Record<string, unknown>) => ({
      from: (table: object) => ({
        where: (condition: unknown) => {
          if (tableName(table) !== "l2_open_gap") {
            return Object.assign(Promise.resolve(heightRows()), {
              orderBy: () => Promise.resolve(heightRows()),
            });
          }
          const rows =
            fields && "due" in fields
              ? gapRows(condition).map((gap) => ({ due: gap.due }))
              : gapRows(condition);
          return Object.assign(Promise.resolve(rows), {
            orderBy: () => ({
              limit: (limit: number) => Promise.resolve(dueCandidates(limit)),
            }),
          });
        },
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => {
          state.upserts.push({ values, set });
          return Promise.resolve();
        },
        onConflictDoNothing: () => {
          state.inserted.push(values);
          return Promise.resolve();
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: unknown) => {
          state.updates.push(values);
          state.updateTargets.push(render(condition).params);
          state.order.push("mark");
          return Promise.resolve();
        },
      }),
    }),
    delete: () => ({
      where: (condition: unknown) => {
        state.deleted.push(condition);
        return Promise.resolve();
      },
    }),
    transaction: async (run: (tx: unknown) => Promise<unknown>) =>
      run(executor),
  };
  return { executor, state };
});

vi.mock("@chicmoz-pkg/postgres-helper", () => ({
  getDb: () => mocks.executor,
}));
vi.mock("../../src/environment.js", () => ({
  L2_NETWORK_ID: "MAINNET",
  L2_BLOCK_RECONCILIATION_INTERVAL_MS: INTERVAL_MS,
  L2_BLOCK_RECONCILIATION_MAX_BLOCKS: 200,
  L2_BLOCK_RECONCILIATION_MAX_RANGES: 10,
  L2_BLOCK_RECONCILIATION_SCAN_WINDOW: 10_000,
  L2_BLOCK_RECONCILIATION_TIP_REPAIR_WINDOW: 5,
}));
vi.mock("../../src/logger.js", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock(
  "../../src/svcs/database/controllers/l2/chain-info/rollup-version-cache.js",
  () => ({ getCurrentRollupVersionNumber: () => Promise.resolve(1) }),
);
vi.mock("../../src/svcs/database/controllers/l2/tips.js", () => ({
  getTips: () =>
    Promise.resolve({
      proposed: { number: TIP },
      proven: { block: { number: mocks.state.tips.provenTip ?? PROVEN_TIP } },
      degradedReason: mocks.state.tips.degradedReason,
    }),
}));
vi.mock("../../src/svcs/database/controllers/l2block/get-latest.js", () => ({
  getLatestHeight: () => Promise.resolve(BigInt(TIP)),
  getLatestBlockRollupVersion: () => Promise.resolve(1),
}));
vi.mock("../../src/svcs/message-bus/index.js", () => ({
  publishMessage: () => {
    if (mocks.state.publishFails) {
      return Promise.reject(new Error("MessageBus is shutting down"));
    }
    mocks.state.order.push("publish");
    return Promise.resolve();
  },
  publishL1Message: () => Promise.resolve(),
}));

const {
  buildMissingBlockRangeRequest,
  buildTipBoundaryRepairRequest,
  coverageOf,
  gapDueSql,
  gapRowMaxWidth,
  requestableGapFilter,
  splitRange,
} = await import(
  "../../src/svcs/database/controllers/l2block/missing-ranges.js"
);
const { l2BlockRangeRequest } = await import(
  "../../src/events/emitted/index.js"
);

const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);
const range = (from: number, to: number) => ({
  from,
  to,
  statusHint: "proposed" as const,
});
const heights = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);
const gap = (
  overrides: Partial<Gap> & Pick<Gap, "id" | "fromHeight" | "toHeight">,
): Gap => ({
  reason: "manual",
  status: "open",
  statusHint: "proposed",
  l2NetworkId: "MAINNET",
  requestCount: 0,
  lastRequestedAt: null,
  firstSeenAt: ago(DAY),
  due: true,
  ...overrides,
});
const statuses = () =>
  mocks.state.updates.map((update) => update.status).filter(Boolean);
const marks = () =>
  mocks.state.updates.filter((update) => "requestCount" in update);
const missingOnly = (...missing: number[]) => {
  mocks.state.presentHeights = mocks.state.presentHeights.filter(
    (height) => !missing.includes(height),
  );
};

beforeEach(() => {
  Object.assign(mocks.state, {
    gaps: [],
    presentHeights: heights(1, TIP),
    upserts: [],
    inserted: [],
    deleted: [],
    updates: [],
    updateTargets: [],
    tips: {},
    publishFails: false,
    order: [],
  });
});

describe("row width", () => {
  it("makes every row one range that fits the budget together with a full request", () => {
    expect(gapRowMaxWidth(200, 10)).toBe(20);
    expect(splitRange(range(30725, 30770), 20)).toEqual([
      range(30725, 30744),
      range(30745, 30764),
      range(30765, 30770),
    ]);
  });
});

describe("coverageOf", () => {
  it("answers for overlapping, contained, adjacent and unsorted gaps", () => {
    const covered = coverageOf([
      { fromHeight: 50, toHeight: 60 },
      { fromHeight: 10, toHeight: 20 },
      { fromHeight: 12, toHeight: 14 },
      { fromHeight: 15, toHeight: 30 },
      { fromHeight: 31, toHeight: 35 },
    ]);
    const probes = [9, 10, 18, 30, 31, 35, 36, 49, 50, 60, 61];
    expect(probes.filter(covered)).toEqual([10, 18, 30, 31, 35, 50, 60]);
    expect(coverageOf([])(1)).toBe(false);
    // A gap inside another must not shorten it.
    const nested = coverageOf([
      { fromHeight: 10, toHeight: 40 },
      { fromHeight: 12, toHeight: 14 },
      { fromHeight: 45, toHeight: 50 },
    ]);
    expect([30, 40, 41, 45].map(nested)).toEqual([true, true, false, true]);
  });

  it("stays fast for a full scan window against many rows", () => {
    const covered = coverageOf(
      Array.from({ length: 5_000 }, (_, i) => ({
        fromHeight: i * 2,
        toHeight: i * 2,
      })),
    );
    const started = performance.now();
    let hits = 0;
    for (let height = 0; height < 10_000; height++) {
      hits += covered(height) ? 1 : 0;
    }
    expect(hits).toBe(5_000);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("due filter (SQL)", () => {
  it("backs off interval * 2^min(requests, 8), capped at 1h, before ORDER BY/LIMIT", () => {
    const { sql, params } = render(gapDueSql(1_000));
    expect(sql).toBe(
      '("l2_open_gap"."last_requested_at" is null or extract(epoch from "l2_open_gap"."last_requested_at") * 1000 + least($1::float8 * power(2, least("l2_open_gap"."request_count", $2::int)), $3::float8) <= $4::float8)',
    );
    expect(params).toEqual([INTERVAL_MS, 8, 60 * 60 * 1000, 1_000]);
  });

  it("is part of the candidate filter, which leaves tip-boundary rows out", () => {
    const { sql, params } = render(requestableGapFilter(TIP, 1_000));
    expect(sql).toContain('"l2_open_gap"."reason" <> $');
    expect(sql).toContain('"l2_open_gap"."from_height" <= $');
    expect(sql).toContain("extract(epoch from");
    // No special case for wide rows: migration 0037 made legacy rows due.
    expect(sql).not.toContain("+ 1 >");
    expect(params).toEqual(
      expect.arrayContaining(["tip_boundary_mismatch", "open", TIP]),
    );
  });
});

describe("discovery", () => {
  it("records new missing heights as rows no wider than the row width", async () => {
    missingOnly(...heights(TIP - 44, TIP - 1));

    await buildMissingBlockRangeRequest({ reason: "cadence" });

    expect(
      mocks.state.upserts.map(({ values }) => [
        values.fromHeight,
        values.toHeight,
      ]),
    ).toEqual([
      [TIP - 44, TIP - 25],
      [TIP - 24, TIP - 5],
      [TIP - 4, TIP - 1],
    ]);
  });

  it("is not starved by unfillable gaps that cover older heights", async () => {
    const unfillable = heights(TIP - 9_000, TIP - 8_701);
    missingOnly(...unfillable, TIP - 5, TIP - 4, TIP - 2);
    mocks.state.gaps = [
      gap({
        id: "unfillable",
        fromHeight: TIP - 9_000,
        toHeight: TIP - 8_701,
        due: false,
      }),
    ];

    await buildMissingBlockRangeRequest({ reason: "cadence" });

    // Discovery's rows (the unfillable row is also split, as a manual row).
    expect(
      mocks.state.upserts
        .filter(({ values }) => values.reason === "cadence")
        .map(({ values }) => [values.fromHeight, values.toHeight]),
    ).toEqual([
      [TIP - 5, TIP - 4],
      [TIP - 2, TIP - 2],
    ]);
  });

  it("does not count tip-boundary rows as covering heights", async () => {
    missingOnly(98106);
    mocks.state.gaps = [
      gap({
        id: "tip",
        fromHeight: 98101,
        toHeight: 98111,
        reason: "tip_boundary_mismatch",
        due: false,
      }),
    ];

    await buildMissingBlockRangeRequest({ reason: "cadence" });

    expect(
      mocks.state.upserts.map(({ values }) => [
        values.fromHeight,
        values.toHeight,
      ]),
    ).toEqual([[98106, 98106]]);
  });

  it("resets the request history of a row it reopens after it was fulfilled", async () => {
    missingOnly(TIP - 1);

    await buildMissingBlockRangeRequest({ reason: "cadence" });

    const [{ set }] = mocks.state.upserts;
    expect(render(set.requestCount).sql).toBe(
      `case when "l2_open_gap"."status" = 'fulfilled' then 0 else "l2_open_gap"."request_count" end`,
    );
    expect(render(set.lastRequestedAt).sql).toBe(
      `case when "l2_open_gap"."status" = 'fulfilled' then null else "l2_open_gap"."last_requested_at" end`,
    );
  });
});

describe("selection", () => {
  it("requests due rows whole, fulfils complete ones and leaves in-flight heights alone", async () => {
    missingOnly(...heights(92100, 92119), ...heights(60000, 60005));
    mocks.state.gaps = [
      gap({ id: "missing", fromHeight: 92100, toHeight: 92119 }),
      gap({
        id: "complete",
        fromHeight: 50000,
        toHeight: 50010,
        requestCount: 4,
        lastRequestedAt: ago(DAY),
      }),
      gap({
        id: "in-flight",
        fromHeight: 60000,
        toHeight: 60005,
        requestCount: 3,
        lastRequestedAt: ago(60_000),
        due: false,
      }),
      gap({
        id: "overlaps-in-flight",
        fromHeight: 60002,
        toHeight: 60003,
        firstSeenAt: ago(1_000),
      }),
    ];

    const planned = await buildMissingBlockRangeRequest({ reason: "cadence" });

    expect(planned?.request.ranges).toEqual([range(92100, 92119)]);
    expect(statuses()).toEqual(["fulfilled"]);
  });

  it("does not request or mark a row past the range cap", async () => {
    // 10 rows of 20 fill the 10 ranges (and 200 blocks); the 11th waits,
    // unmarked.
    const rows = Array.from({ length: 11 }, (_, i) =>
      gap({
        id: `row-${i}`,
        fromHeight: 70000 + i * 100,
        toHeight: 70000 + i * 100 + 19,
        firstSeenAt: ago(DAY - i),
      }),
    );
    missingOnly(
      ...rows.flatMap((row) => heights(row.fromHeight, row.toHeight)),
    );
    mocks.state.gaps = rows;

    const planned = await buildMissingBlockRangeRequest({ reason: "cadence" });
    await planned?.markRequested();

    expect(planned?.request.ranges).toHaveLength(10);
    expect(planned?.request.ranges).not.toContainEqual(range(71000, 71019));
    expect(marks()).toHaveLength(1);
  });

  it("caps a request at the listener's 10 ranges however narrow the rows", async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      gap({
        id: `single-${i}`,
        fromHeight: 80000 + i * 10,
        toHeight: 80000 + i * 10,
        firstSeenAt: ago(DAY - i),
      }),
    );
    missingOnly(...rows.map((row) => row.fromHeight));
    mocks.state.gaps = rows;

    const planned = await buildMissingBlockRangeRequest({ reason: "cadence" });

    expect(planned?.request.ranges).toHaveLength(10);
  });

  it("splits a partly filled or over-wide row instead of requesting part of it", async () => {
    missingOnly(...heights(30725, 30770), 92084, 92086);
    mocks.state.gaps = [
      // Recorded before rows were capped; due since migration 0037 reset it.
      gap({ id: "legacy-wide", fromHeight: 30725, toHeight: 30770 }),
      gap({ id: "fragmented", fromHeight: 92084, toHeight: 92086 }),
    ];

    const planned = await buildMissingBlockRangeRequest({ reason: "cadence" });

    expect(planned).toBeNull();
    expect(
      mocks.state.upserts.map(({ values }) => [
        values.fromHeight,
        values.toHeight,
      ]),
    ).toEqual([
      [30725, 30744],
      [30745, 30764],
      [30765, 30770],
      [92084, 92084],
      [92086, 92086],
    ]);
    expect(mocks.state.deleted).toHaveLength(2);
  });

  it("starts split rows without request history, so they are due right away", async () => {
    missingOnly(...heights(30725, 30770));
    mocks.state.gaps = [
      gap({
        id: "partly-requested",
        fromHeight: 30725,
        toHeight: 30770,
        requestCount: 3,
        lastRequestedAt: ago(DAY),
      }),
    ];

    await buildMissingBlockRangeRequest({ reason: "cadence" });

    for (const { values } of mocks.state.upserts) {
      expect(values).not.toHaveProperty("requestCount");
      expect(values).not.toHaveProperty("lastRequestedAt");
      expect(values.status).toBe("open");
    }
  });

  it("reopens (and resets) a fulfilled row a split run collides with, rather than dropping the run", async () => {
    missingOnly(92084, 92086);
    mocks.state.gaps = [
      gap({ id: "fragmented", fromHeight: 92084, toHeight: 92086 }),
    ];

    await buildMissingBlockRangeRequest({ reason: "cadence" });

    expect(mocks.state.inserted).toEqual([]);
    const [{ set }] = mocks.state.upserts;
    expect(set.status).toBe("open");
    expect(render(set.requestCount).sql).toBe(
      `case when "l2_open_gap"."status" = 'fulfilled' then 0 else "l2_open_gap"."request_count" end`,
    );
  });

  it("keeps the heights above the tip as a row with the original history", async () => {
    missingOnly(TIP - 5, TIP - 4, TIP - 1);
    const lastRequestedAt = ago(DAY);
    mocks.state.gaps = [
      gap({
        id: "straddles-tip",
        fromHeight: TIP - 5,
        toHeight: TIP + 10,
        requestCount: 7,
        lastRequestedAt,
      }),
    ];

    await buildMissingBlockRangeRequest({ reason: "cadence" });

    const split = mocks.state.upserts.filter(
      ({ values }) => values.reason === "manual",
    );
    expect(
      split.map(({ values }) => [
        values.fromHeight,
        values.toHeight,
        values.requestCount,
        values.lastRequestedAt,
      ]),
    ).toEqual([
      [TIP - 5, TIP - 4, undefined, undefined],
      [TIP - 1, TIP - 1, undefined, undefined],
      [TIP + 1, TIP + 10, 7, lastRequestedAt],
    ]);
    expect(mocks.state.deleted).toHaveLength(1);
  });

  it.each([
    [
      "its heights are in flight through another row",
      [
        gap({
          id: "in-flight",
          fromHeight: 60000,
          toHeight: 60005,
          requestCount: 3,
          lastRequestedAt: ago(60_000),
          due: false,
        }),
        gap({ id: "blocked", fromHeight: 60002, toHeight: 60003 }),
      ],
      [60000, 60001, 60002, 60003, 60004, 60005],
    ],
    [
      "it is present up to the tip but extends past it",
      [gap({ id: "blocked", fromHeight: TIP - 2, toHeight: TIP + 5 })],
      [],
    ],
  ])(
    "moves a due row to the back of the queue when %s, without bumping its count",
    async (_name, gaps, missing) => {
      missingOnly(...missing);
      mocks.state.gaps = gaps;

      await buildMissingBlockRangeRequest({ reason: "cadence" });

      const index = mocks.state.updateTargets.findIndex((params) =>
        params.includes("blocked"),
      );
      expect(index).toBeGreaterThanOrEqual(0);
      expect(Object.keys(mocks.state.updates[index])).toEqual([
        "lastRequestedAt",
      ]);
    },
  );

  it("never exceeds the listener's default limits (200 blocks, 10 ranges, 250 wide)", async () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      gap({
        id: `row-${i}`,
        fromHeight: 70000 + i * 100,
        toHeight: 70000 + i * 100 + 19,
        firstSeenAt: ago(DAY - i),
      }),
    );
    missingOnly(
      ...rows.flatMap((row) => heights(row.fromHeight, row.toHeight)),
    );
    mocks.state.gaps = rows;

    const planned = await buildMissingBlockRangeRequest({ reason: "cadence" });
    const ranges = planned?.request.ranges ?? [];

    expect(planned?.request.maxBlocks).toBeLessThanOrEqual(200);
    expect(ranges.length).toBeLessThanOrEqual(10);
    expect(
      ranges.reduce((sum, r) => sum + r.to - r.from + 1, 0),
    ).toBeLessThanOrEqual(200);
    expect(
      Math.max(...ranges.map((r) => r.to - r.from + 1)),
    ).toBeLessThanOrEqual(250);
  });

  it("marks the requested rows only once the request is published", async () => {
    missingOnly(500, 501, 502);
    mocks.state.gaps = [gap({ id: "a", fromHeight: 500, toHeight: 502 })];

    const planned = await buildMissingBlockRangeRequest({ reason: "cadence" });
    expect(marks()).toEqual([]);

    mocks.state.publishFails = true;
    await expect(l2BlockRangeRequest(planned)).rejects.toThrow("shutting down");
    expect(marks()).toEqual([]);

    mocks.state.publishFails = false;
    await l2BlockRangeRequest(planned);
    expect(mocks.state.order).toEqual(["publish", "mark"]);
    expect(marks()).toHaveLength(1);
  });

  it("returns nothing while no row is due", async () => {
    missingOnly(60000);
    mocks.state.gaps = [
      gap({ id: "in-flight", fromHeight: 60000, toHeight: 60000, due: false }),
    ];

    await expect(
      buildMissingBlockRangeRequest({ reason: "cadence" }),
    ).resolves.toBeNull();
    expect(mocks.state.updates).toEqual([]);
  });
});

describe("buildTipBoundaryRepairRequest", () => {
  it("sends the window for a hash mismatch above the proven tip too", async () => {
    mocks.state.tips = {
      degradedReason: `proposed boundary block ${TIP - 2} hash mismatch: db=0x1 tip=0x2`,
    };

    const planned = await buildTipBoundaryRepairRequest();

    expect(planned?.request.ranges).toEqual([range(TIP - 7, TIP + 3)]);
  });

  it("sends the window for a missing block", async () => {
    mocks.state.tips = {
      degradedReason: `proposed boundary block ${TIP - 2} is missing`,
    };

    const planned = await buildTipBoundaryRepairRequest();

    expect(planned?.request.ranges).toEqual([range(TIP - 7, TIP + 3)]);
    // Reopening a tip row keeps its backoff: it is fulfilled as soon as its
    // heights are present, mismatch or not.
    expect(mocks.state.upserts[0].set).not.toHaveProperty("requestCount");
  });

  it("backs off while its row is not due", async () => {
    mocks.state.tips = {
      degradedReason: "finalized boundary block 98106 is missing",
    };
    mocks.state.gaps = [
      gap({
        id: "MAINNET:tip_boundary_mismatch:98101:98111",
        fromHeight: 98101,
        toHeight: 98111,
        reason: "tip_boundary_mismatch",
        due: false,
      }),
    ];

    await expect(buildTipBoundaryRepairRequest()).resolves.toBeNull();
  });
});
