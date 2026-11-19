import { loadContractArtifact } from "@aztec-labs/aztec.js/abi";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { getContractInstanceFromInstantiationParams } from "@aztec-labs/aztec.js/contracts";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { deliver, frameBytes, loadFixture } from "@chicmoz/test-harness";
import {
  type ChicmozChainInfoEvent,
  type ChicmozL2RpcNodeErrorEvent,
  type ChicmozL2RpcNodeInfoEvent,
  type DroppedTxsEvent,
  type L1L2ValidatorEvent,
  type PendingTxsEvent,
} from "@chicmoz-pkg/message-registry";
import { BSON } from "bson";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rawArtifact } from "./support/contracts.js";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";
import {
  type DbFilled,
  cacheAt,
  producerFrameData,
  recordedBlocks,
  removeRpcNodes,
  removeValidators,
  requiredKeysOf,
  rpcNodeSnapshotOf,
  setInstanceSalt,
  snapshotOf,
} from "./support/recorded-blocks.js";

vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 0, 1) });

const TESTNET = recordedBlocks("testnet");
const LOCAL = recordedBlocks("local-network");
const LOCAL_TIP = String(Math.max(...LOCAL.map((b) => b.expected.height)));
const CLASS_IDS = LOCAL.flatMap((b) => b.expected.contractClassIds);
const INSTANCES = LOCAL.flatMap((b) => b.expected.contractInstanceAddresses);
const CLASS_VERSION = 1;

// `tx_time_of_birth` defaults to `EXTRACT(EPOCH FROM NOW()) * 1000`.
const TX_EFFECT_DB: DbFilled = { dbTimeKeys: ["txBirthTimestamp"] };
// Verified arguments `id`: `defaultRandom()`; deployer metadata `uploaded_at`
// and notes `uploaded_at`/`updated_at`: `defaultNow()`.
const VERIFIED_DB: DbFilled = {
  dbTimeKeys: ["uploadedAt", "updatedAt"],
  dbUuidKeys: ["id"],
};

const frameData = <T>(name: string): T =>
  (
    BSON.deserialize(
      frameBytes(loadFixture("local-network", "frame", name)),
    ) as { data: T }
  ).data;

const PENDING = frameData<PendingTxsEvent>("pending-txs-event-1");
const CHAIN_INFO = frameData<ChicmozChainInfoEvent>("chain-info-event-1");
const RPC_NODE = producerFrameData(
  "local-network/rpc-node",
  "L2_RPC_NODE_INFO_EVENT",
) as ChicmozL2RpcNodeInfoEvent;
const RPC_NODE_ERROR = producerFrameData(
  "rpc-node-error",
  "L2_RPC_NODE_ERROR_EVENT",
) as ChicmozL2RpcNodeErrorEvent;

/** Bodies served by a GET route, kept for the required-keys check. */
const served: Array<{ openApiPath: string; body: unknown }> = [];

describe("recorded chain data read back through Postgres and Redis", () => {
  let api: ExplorerApiForTest;

  const get = async (path: string, openApiPath?: string, status = 200) => {
    const res = await api.request.get(path);
    expect(res.status, `GET ${path}: ${res.text.slice(0, 300)}`).toBe(status);
    const body: unknown = res.body;
    if (openApiPath) {
      served.push({ openApiPath, body });
    }
    return body;
  };

  beforeAll(async () => {
    api = await startExplorerApiForTest();
  });

  afterAll(async () => {
    await api?.close();
  });

  const deliverBlocks = async (blocks: typeof TESTNET) => {
    const { blockHandler } = await import(
      "../../src/events/received/on-block/index.js"
    );
    for (const { event } of blocks) {
      await deliver(blockHandler, event);
    }
  };

  // Every stored column comes back through the row readers' schemas, then
  // through the cache string; numeric, bigint and jsonb columns change type
  // on the way, which no unit test of a schema sees.
  const readBackBlocks = (blocks: typeof TESTNET) => {
    it.each(blocks.map((b) => [b.name, b] as const))(
      "%s: block, its tx effects and each tx effect by hash",
      async (_, { expected }) => {
        const block = await get(
          `/l2/blocks/${expected.height}`,
          "/l2/blocks/{heightOrHash}",
        );
        expect(snapshotOf(block)).toMatchSnapshot("block");
        expect(await get(`/l2/blocks/${expected.hash}`)).toEqual(block);

        const txEffects = await get(
          `/l2/blocks/${expected.height}/tx-effects`,
          "/l2/blocks/{blockHeight}/txEffects",
        );
        expect(txEffects).toHaveLength(expected.txHashes.length);
        expect(snapshotOf(txEffects, TX_EFFECT_DB)).toMatchSnapshot(
          "tx effects of the block",
        );
        for (const txHash of expected.txHashes) {
          const txEffect = await get(
            `/l2/tx-effects/${txHash}`,
            "/l2/txEffects/{hash}",
          );
          expect(snapshotOf(txEffect, TX_EFFECT_DB)).toMatchSnapshot(
            `tx effect ${txHash}`,
          );
        }
      },
    );
  };

  describe("testnet blocks", () => {
    beforeAll(() => deliverBlocks(TESTNET));
    readBackBlocks(TESTNET);
  });

  // Reads filter on the current rollup version, the one first seen latest; a
  // day later the local network's version is current.
  describe("local-network blocks", () => {
    beforeAll(async () => {
      vi.setSystemTime(Date.UTC(2026, 0, 2));
      await deliverBlocks(LOCAL);
    });
    readBackBlocks(LOCAL);

    // Class bodies stay out of the required-keys check: the generated document
    // has only a POST operation under the class path.
    it.each(CLASS_IDS)(
      "class %s reads back as the block handler stored it, with and without includeArtifactJson",
      async (classId) => {
        const path = `/l2/contract-classes/${classId}/versions/${CLASS_VERSION}`;
        expect(snapshotOf(await get(path))).toMatchSnapshot("class");
        expect(
          snapshotOf(await get(`${path}?includeArtifactJson=true`)),
        ).toMatchSnapshot("class with includeArtifactJson");
      },
    );

    it.each(INSTANCES)(
      "instance %s reads back as the block handler stored it",
      async (address) => {
        expect(
          snapshotOf(
            await get(
              `/l2/contract-instances/${address}`,
              "/l2/contract-instances/{address}",
            ),
          ),
        ).toMatchSnapshot();
      },
    );
  });

  describe("txs", () => {
    it("the recorded pending txs read back as the pending-tx handler stored them", async () => {
      const { pendingTxHandler } = await import(
        "../../src/events/received/on-pending-txs.js"
      );
      await pendingTxHandler.cb(PENDING);
      for (const { txHash } of PENDING.txs) {
        expect(
          snapshotOf(await get(`/l2/txs/${txHash}`, "/l2/txs/{hash}")),
        ).toMatchSnapshot(txHash);
      }
    });

    // Constructed: the local network drops nothing. Shaped as aztec-listener's
    // dropped-tx verifier publishes it, for the recorded pending tx.
    it("a constructed dropped tx reads back as the dropped-tx handler stored it", async () => {
      const { droppedTxHandler } = await import(
        "../../src/events/received/on-dropped-txs.js"
      );
      const event: DroppedTxsEvent = {
        txs: PENDING.txs.map((tx) => ({
          txHash: tx.txHash,
          createdAsPendingAt: tx.birthTimestamp,
          droppedAt: Date.now(),
          dropReason: "expired",
        })),
      };
      await deliver(droppedTxHandler, event);
      for (const { txHash } of event.txs) {
        expect(
          snapshotOf(
            await get(`/l2/dropped-txs/${txHash}`, "/l2/dropped-txs/{hash}"),
          ),
        ).toMatchSnapshot(txHash);
      }
    });
  });

  describe("contract instance verification", () => {
    const [address] = INSTANCES;
    const artifact = rawArtifact("auth_registry_contract-AuthRegistry");
    let deploymentArguments: {
      publicKeysString: string;
      salt: string;
      deployer: string;
      constructorArgs: string[];
    };

    const verify = (body: Record<string, unknown>) =>
      api.request.post(`/l2/contract-instances/${address}`).send(body);

    beforeAll(async () => {
      // The local network deploys AuthRegistry without an initializer at salt 1.
      const instance = await getContractInstanceFromInstantiationParams(
        loadContractArtifact(artifact),
        { constructorArgs: [], deployer: AztecAddress.ZERO, salt: new Fr(1) },
      );
      expect(instance.address.toString()).toBe(address);
      deploymentArguments = {
        publicKeysString: instance.publicKeys.toString(),
        salt: instance.salt.toString(),
        deployer: instance.deployer.toString(),
        constructorArgs: [],
      };
    });

    // The POST reads the instance through the cache; a 200 while the row's
    // salt disagrees proves the answer came from the stored string.
    it("POST verifies the recorded deployment from the string its cache entry holds", async () => {
      const entry = cacheAt(api.stack, api.namespace, [
        "l2",
        "contract-instances",
        address,
      ]);
      await entry.remove();
      const first = await verify({
        verifiedDeploymentArguments: {
          ...deploymentArguments,
          stringifiedArtifactJson: JSON.stringify(artifact),
        },
      });
      expect(first.status, first.text).toBe(200);
      const stored = await entry.stored();
      expect(snapshotOf(JSON.parse(stored), VERIFIED_DB)).toMatchSnapshot(
        "cached string",
      );

      const otherSalt = new Fr(2).toString();
      await setInstanceSalt(address, otherSalt);
      await entry.remove();
      const fromDatabase = await verify({
        verifiedDeploymentArguments: deploymentArguments,
      });
      expect([fromDatabase.status, fromDatabase.text]).toEqual([
        400,
        "Uploaded salt does not match the DB",
      ]);

      await entry.seed(stored);
      const fromCache = await verify({
        verifiedDeploymentArguments: deploymentArguments,
      });
      expect([fromCache.status, fromCache.text]).toEqual([
        200,
        "Contract instance deployment arguments verified and stored",
      ]);
      await setInstanceSalt(address, deploymentArguments.salt);
      await entry.remove();
    });

    // Constructed: no recorded upload carries notes; outside production the
    // verified-deployment POST stores them with the deployer metadata.
    it("constructed aztec-scan notes and deployer metadata read back from the POST and the notes route", async () => {
      const { rollupAddress } = CHAIN_INFO.chainInfo.l1ContractAddresses;
      const res = await verify({
        verifiedDeploymentArguments: deploymentArguments,
        deployerMetadata: {
          contractIdentifier: "AuthRegistry",
          details: "Authorization registry deployed by the local network",
          creatorName: "Aztec",
          creatorContact: "contact@example.org",
          appUrl: "https://app.example.org",
          repoUrl: "https://example.org/repo",
          aztecScanNotes: {
            name: "AuthRegistry",
            origin: "local network setup",
            comment: "Protocol-adjacent registry",
            category: "infra",
            relatedL1ContractAddresses: [
              {
                address: rollupAddress,
                note: "rollup",
              },
            ],
          },
        },
      });
      expect(res.status, res.text).toBe(200);
      expect(snapshotOf(res.body, VERIFIED_DB)).toMatchSnapshot(
        "POST response",
      );
      const notes = await get(
        "/l2/contract-instances/with-aztec-scan-notes",
        "/l2/contract-instances/with-aztec-scan-notes",
      );
      expect(notes).toHaveLength(1);
      expect(snapshotOf(notes, VERIFIED_DB)).toMatchSnapshot("notes route");
    });

    // Their cache entries are removed, as when they expire, so the routes
    // read the rows the verification and notes left.
    it("class and instance read back with the stored artifact, deployment arguments and notes", async () => {
      const instanceEntry = cacheAt(api.stack, api.namespace, [
        "l2",
        "contract-instances",
        address,
      ]);
      await instanceEntry.remove();
      expect(
        snapshotOf(
          await get(
            `/l2/contract-instances/${address}`,
            "/l2/contract-instances/{address}",
          ),
          VERIFIED_DB,
        ),
      ).toMatchSnapshot("instance");
      for (const classId of CLASS_IDS) {
        for (const flag of ["without-artifact", "with-artifact"] as const) {
          await cacheAt(api.stack, api.namespace, [
            "l2",
            "contract-classes",
            classId,
            CLASS_VERSION,
            flag,
          ]).remove();
        }
        const path = `/l2/contract-classes/${classId}/versions/${CLASS_VERSION}`;
        expect(snapshotOf(await get(path))).toMatchSnapshot(`class ${classId}`);
        expect(
          snapshotOf(await get(`${path}?includeArtifactJson=true`)),
        ).toMatchSnapshot(`class ${classId} with includeArtifactJson`);
      }
    });
  });

  // Each reader is shown the string its own writer stored, after the rows are
  // gone: an equal answer means it parsed the cache entry, not the database.
  describe("cache readers", () => {
    const deliverRpcNode = async () => {
      const { l2RpcNodeInfoHandler } = await import(
        "../../src/events/received/on-rpc-node-info.js"
      );
      const { l2RpcNodeErrorHandler } = await import(
        "../../src/events/received/on-l2-rpc-node.js"
      );
      await l2RpcNodeInfoHandler.cb(RPC_NODE);
      await l2RpcNodeErrorHandler.cb(RPC_NODE_ERROR);
    };

    it("GET /l2/rpc-nodes answers from its cache entry", async () => {
      await deliverRpcNode();
      const entry = cacheAt(api.stack, api.namespace, [
        "l2",
        "rpc-nodes",
        LOCAL_TIP,
      ]);
      await entry.remove();
      const fresh = await get("/l2/rpc-nodes", "/l2/rpc-nodes");
      expect(fresh).toHaveLength(1);
      const stored = await entry.stored();
      expect({
        response: (fresh as unknown[]).map(rpcNodeSnapshotOf),
        cached: (JSON.parse(stored) as unknown[]).map(rpcNodeSnapshotOf),
      }).toMatchSnapshot();

      await removeRpcNodes();
      await entry.remove();
      expect(await get("/l2/rpc-nodes")).toEqual([]);
      await entry.seed(stored);
      expect(await get("/l2/rpc-nodes")).toEqual(fresh);
    });

    it("GET /l2/rpc-nodes/:rpcNodeName answers from its cache entry", async () => {
      await deliverRpcNode();
      const { rpcNodeName } = RPC_NODE.rpcNode;
      const path = `/l2/rpc-nodes/${rpcNodeName}`;
      const entry = cacheAt(api.stack, api.namespace, [
        "l2",
        "rpc-nodes",
        rpcNodeName,
        LOCAL_TIP,
      ]);
      await entry.remove();
      const fresh = await get(path, "/l2/rpc-nodes/:rpcNodeName");
      const stored = await entry.stored();
      expect({
        response: rpcNodeSnapshotOf(fresh),
        cached: rpcNodeSnapshotOf(JSON.parse(stored)),
      }).toMatchSnapshot();

      await removeRpcNodes();
      await entry.remove();
      await get(path, undefined, 404);
      await entry.seed(stored);
      expect(await get(path)).toEqual(fresh);
    });

    // Constructed: validators come from an L1 contract read nothing recorded.
    // The attester is the recorded ValidatorQueued one, on the local rollup.
    it("GET /l1/l2-validators/totals answers from its cache entry", async () => {
      const { chainInfoHandler } = await import(
        "../../src/events/received/on-chain-info.js"
      );
      const { l1L2ValidatorHandler } = await import(
        "../../src/events/received/on-l1-l2-validator.js"
      );
      const { L1L2ValidatorStatus } = await import("@chicmoz-pkg/types");
      await chainInfoHandler.cb(CHAIN_INFO);
      const args = loadFixture("testnet", "l1-log", "rollup-validator-queued")
        .data.log.args as Record<"attester" | "withdrawer", `0x${string}`>;
      const event: L1L2ValidatorEvent = {
        validators: [
          {
            rollupAddress:
              CHAIN_INFO.chainInfo.l1ContractAddresses.rollupAddress,
            attester: args.attester,
            withdrawer: args.withdrawer,
            proposer: args.withdrawer,
            stake: "200000000000000000000000",
            status: L1L2ValidatorStatus.VALIDATING,
            firstSeenAt: Date.now(),
            latestSeenChangeAt: Date.now(),
          },
        ],
      };
      await deliver(l1L2ValidatorHandler, event);

      const path = "/l1/l2-validators/totals";
      const entry = cacheAt(api.stack, api.namespace, [
        "l1",
        "l2-validators",
        "totals",
      ]);
      await entry.remove();
      const fresh = await get(path, path);
      expect(fresh).toMatchObject({ total: 1 });
      const stored = await entry.stored();
      expect({
        response: snapshotOf(fresh),
        cached: snapshotOf(JSON.parse(stored)),
      }).toMatchSnapshot();

      await removeValidators();
      await entry.remove();
      expect(await get(path)).toMatchObject({ total: 0 });
      await entry.seed(stored);
      expect(await get(path)).toEqual(fresh);
    });
  });

  // A client generated from the document relies on these keys; the snapshots
  // above pin values, this pins the contract the document states for them.
  it("every served body has the keys the OpenAPI document requires for its route", async () => {
    const { genereateOpenApiSpec } = await import(
      "../../src/svcs/http-server/open-api-spec.js"
    );
    const spec = genereateOpenApiSpec();
    const missing: string[] = [];
    const checked = new Set<string>();
    for (const { openApiPath, body } of served) {
      const { isArray, required } = requiredKeysOf(spec, openApiPath);
      expect(Array.isArray(body), openApiPath).toBe(isArray);
      const items = isArray ? (body as unknown[]) : [body];
      for (const item of items) {
        checked.add(openApiPath);
        for (const key of required) {
          if (
            item === null ||
            typeof item !== "object" ||
            !Object.hasOwn(item, key)
          ) {
            missing.push(`${openApiPath}: ${key}`);
          }
        }
      }
    }
    expect([...checked].sort()).toEqual([
      "/l1/l2-validators/totals",
      "/l2/blocks/{blockHeight}/txEffects",
      "/l2/blocks/{heightOrHash}",
      "/l2/contract-instances/with-aztec-scan-notes",
      "/l2/contract-instances/{address}",
      "/l2/dropped-txs/{hash}",
      "/l2/rpc-nodes",
      "/l2/rpc-nodes/:rpcNodeName",
      "/l2/txEffects/{hash}",
      "/l2/txs/{hash}",
    ]);
    expect([...new Set(missing)]).toEqual([]);
  });
});
