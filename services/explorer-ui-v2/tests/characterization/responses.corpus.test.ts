import { chicmozL2PendingTxSchema, jsonStringify } from "@chicmoz-pkg/types";
import { canonical, listFixtures, loadFixture } from "@chicmoz/test-harness";
import { type AxiosAdapter } from "axios";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

// What a page shows for an API body is decided by the UI's own schemas and
// validateResponse; explorer-api's tests never run them.

// Schema defaults read the clock.
vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 0, 1) });
vi.stubEnv("VITE_L2_NETWORK_ID", "SANDBOX");
vi.stubEnv("VITE_API_URL", "https://api.test");
vi.stubEnv("VITE_API_KEY", "dev-api-key");

const { default: client, ApiError } = await import("~/api/client");
const { API_URL } = await import("~/service/constants");
const api = await import("~/api");

type Case = {
  uiModule: string;
  call: (at: URL) => Promise<unknown>;
};

const lastSegment = (at: URL) =>
  at.pathname.slice(at.pathname.lastIndexOf("/") + 1);

const RECORDED: Record<string, Case> = {
  "block-by-height": {
    uiModule: "block",
    call: (at) => api.BlockAPI.getBlockByHeight(lastSegment(at)),
  },
  "chain-info": {
    uiModule: "chain-info",
    call: () => api.ChainInfoAPI.getChainInfo(),
  },
  "contract-class-versions": {
    uiModule: "contract",
    call: (at) => api.ContractL2API.getContractClasses(lastSegment(at)),
  },
  "contract-instance": {
    uiModule: "contract",
    call: (at) => api.ContractL2API.getContractInstance(lastSegment(at)),
  },
  "fee-recipients": {
    uiModule: "fee-recipient",
    call: () => api.FeeRecipientAPI.getFeeRecipients(),
  },
  "governance-proposals": {
    uiModule: "governance",
    call: () => api.GovernanceAPI.getProposals(),
  },
  "l1-contract-events": {
    uiModule: "l1-contract-event",
    call: () => api.L1ContractEventAPI.getContractEvents(),
  },
  "l2-validator-totals": {
    uiModule: "l1-l2-validator",
    call: () => api.L1L2ValidatorAPI.getValidatorTotals(),
  },
  "pending-txs": {
    uiModule: "tx",
    call: () => api.TxAPI.getPendingTxs(),
  },
  "public-call-requests-by-tx": {
    uiModule: "tx",
    call: (at) => api.TxAPI.getPublicCallRequestsByTxHash(lastSegment(at)),
  },
  "rpc-nodes": {
    uiModule: "rpc-node",
    call: () => api.RpcNodeAPI.getAllRpcNodes(),
  },
  "search-by-height": {
    uiModule: "search",
    call: (at) => api.searchL2Api.search(at.searchParams.get("q") ?? ""),
  },
  tips: {
    uiModule: "tips",
    call: () => api.TipsAPI.getL2TipsHealth(),
  },
  "total-tx-effects": {
    uiModule: "stats",
    call: () => api.statsL2Api.getL2TotalTxEffects(),
  },
  "tx-effect-by-hash": {
    uiModule: "tx-effect",
    call: (at) => api.TxEffectsAPI.getTxEffectByHash(lastSegment(at)),
  },
};

const PENDING_TX_HASH =
  "0x12bac4f40aa7b6d3b7f9a960ec18d12646d9e0ff390352033e2f69b80b47b38a";
const DEPOSIT_RECIPIENT =
  "0x2cbf857a43f5e01983c3ec6da10e7e3c4cd215fca8e43a45e11c8f7fb49b51d5";

// No recording has these bodies; each is a stored row as explorer-api
// serializes it (bigint as a decimal string, timestamps in ms).
const CONSTRUCTED: [string, Case & { path: string; body: unknown }][] = [
  [
    // The recorded pending tx, dropped as "expired" once aztec-listener's
    // default 5 h age threshold passed.
    "dropped-tx",
    {
      uiModule: "dropped-tx",
      path: `/l2/dropped-txs/${PENDING_TX_HASH}`,
      call: (at) => api.DroppedTxAPI.getDroppedTxByHash(lastSegment(at)),
      body: {
        txHash: PENDING_TX_HASH,
        createdAsPendingAt: 1795115670208,
        droppedAt: 1795133670208,
        dropReason: "expired",
      },
    },
  ],
  [
    // The recorded pending-txs frame's tx as its `tx` row holds it (no
    // initiator: NULL); GET /l2/txs serves jsonStringify of the parsed rows.
    "pending-txs",
    {
      ...RECORDED["pending-txs"],
      path: "/l2/txs",
      body: JSON.parse(
        jsonStringify(
          z.array(chicmozL2PendingTxSchema).parse([
            {
              txHash: PENDING_TX_HASH,
              feePayer:
                "0x0e900d357d0a7b9de3c0293c6b1a58dccfc1862f31c745ba5d3a5a5aaf4ac1fd",
              birthTimestamp: 1795115670208,
              initiator: null,
              expirationTimestamp: 1795198736,
              gasLimitDa: 916,
              gasLimitL2: 549670,
              teardownGasLimitDa: 0,
              teardownGasLimitL2: 0,
              maxFeePerDaGas: "0",
              maxFeePerL2Gas: "1480569393941",
              maxPriorityFeePerDaGas: "0",
              maxPriorityFeePerL2Gas: "0",
              gasUsedDa: 832,
              gasUsedL2: 499700,
              feePaymentMethod: "fee_juice",
              noteHashCount: 1,
              nullifierCount: 3,
              l2ToL1MsgCount: 0,
              privateLogCount: 1,
            },
          ]),
        ),
      ) as unknown,
    },
  ],
  [
    // The recorded testnet DepositToAztecPublic log; the endpoint serves
    // finalized deposits only.
    "fee-juice-portal-deposits",
    {
      uiModule: "l1-fee-juice-portal-deposit",
      path: `/l1/fee-juice-portal-deposits/${DEPOSIT_RECIPIENT}`,
      call: (at) =>
        api.L1FeeJuicePortalDepositAPI.getByAddress(lastSegment(at)),
      body: [
        {
          l1ContractAddress: "0xe59acba462a0324b1d619a7a1b219419f156f505",
          l1BlockNumber: "12168183",
          l1BlockHash:
            "0xd373900cc034f5a6eac9d6bc2194ec2c7e557e9df9c879197d32cdded3dcc11d",
          l1BlockTimestamp: 1795088376000,
          l1TransactionHash:
            "0x2050c37e80d667366d9f2768c8c5514be5f328a9a6f8ee88472498019dfc2e7e",
          l1LogIndex: 174,
          isFinalized: true,
          l1Sender: "0xab9ad51e9838325fd61a76ed9ae5ace3896f232b",
          to: DEPOSIT_RECIPIENT,
          amount: "1000000000000000000000",
          secretHash:
            "0x125d729e69fd88cd8923813073df8317962b1e41ca9f0f158840c7f1d59cd9dd",
          key: "0x008b75ab3e522b2d8a62948f09db17c0f4ba3b3f4b9e6b342bf5723a3fa5eff0",
          index: "3487",
        },
      ],
    },
  ],
];

let served: unknown;
const requests: string[] = [];
// JSON text, so axios parses the body the way it parses a real response.
const adapter: AxiosAdapter = (config) => {
  requests.push(client.getUri(config));
  return Promise.resolve({
    data: JSON.stringify(served),
    status: 200,
    statusText: "OK",
    headers: {},
    config,
  });
};
client.defaults.adapter = adapter;

const fetchAs = async ({ call }: Case, path: string, body: unknown) => {
  served = body;
  requests.length = 0;
  const result = await call(new URL(path, API_URL));
  // The path selects the API function, and so the schema, that parsed the body.
  expect(requests).toEqual([`${API_URL}${path}`]);
  return result;
};

describe("UI parsing of explorer-api bodies", () => {
  const names = listFixtures("local-network", "api-body");

  // A recorded body without a call here would never be parsed.
  it("has one API call per recorded body", () => {
    expect(Object.keys(RECORDED).sort()).toEqual(names);
  });

  it.each(names)(
    "parses the recorded %s body to the same value",
    async (name) => {
      const { path, status, uiModule, body } = loadFixture(
        "local-network",
        "api-body",
        name,
      ).data;
      const entry = RECORDED[name];
      expect({ status, uiModule }).toEqual({
        status: 200,
        uiModule: entry.uiModule,
      });
      expect(canonical(await fetchAs(entry, path, body))).toMatchSnapshot();
    },
  );

  it.each(CONSTRUCTED)(
    "parses the constructed %s body to the same value",
    async (_name, entry) => {
      expect(
        canonical(await fetchAs(entry, entry.path, entry.body)),
      ).toMatchSnapshot();
    },
  );

  // No recording has this body; explorer-api's cache test pins the instance
  // with notes it serves.
  it("parses an instance with notes through the notes list schema", async () => {
    const instance = JSON.parse(
      readFileSync(
        new URL(
          "../../../explorer-api/tests/integration/__snapshots__/cache/contract-instance-with-notes.json.snap",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { address: string; aztecScanNotes: unknown };
    const parsed = await fetchAs(
      {
        uiModule: "contract",
        call: () => api.ContractL2API.getContractInstancesWithAztecScanNotes(),
      },
      "/l2/contract-instances/with-aztec-scan-notes",
      [instance],
    );

    expect(
      (parsed as { address: string; aztecScanNotes: unknown }[]).map(
        ({ address, aztecScanNotes }) => ({ address, aztecScanNotes }),
      ),
    ).toEqual([
      {
        address: instance.address,
        aztecScanNotes: {
          ...(instance.aztecScanNotes as object),
          uploadedAt: new Date("2000-01-01T00:00:00.000Z"),
          updatedAt: new Date("2000-01-01T00:00:00.000Z"),
        },
      },
    ]);
  });

  // The message comes from zod and changes with it; status 400 keeps a schema
  // failure from rendering as "not found".
  it("refuses a recorded block whose hash is a number with a 400 Schema ApiError", async () => {
    const { path, body } = loadFixture(
      "local-network",
      "api-body",
      "block-by-height",
    ).data;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error("block-by-height body is not an object");
    }
    const request = fetchAs(RECORDED["block-by-height"], path, {
      ...body,
      hash: 11,
    });
    await expect(request).rejects.toBeInstanceOf(ApiError);
    await expect(request).rejects.toMatchObject({
      status: 400,
      type: "Schema",
    });
  });
});
