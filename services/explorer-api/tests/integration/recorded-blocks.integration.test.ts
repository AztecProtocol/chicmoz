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
import { existsSync, readFileSync } from "node:fs";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { rawArtifact } from "./support/contracts.js";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";
import {
  type DbFilled,
  type DbFilledAt,
  cacheAt,
  documentMismatches,
  normalizedCacheString,
  producerFrameData,
  recordedBlocks,
  removeRpcNodes,
  removeValidators,
  setInstanceSalt,
  snapshotOf,
} from "./support/recorded-blocks.js";

const TESTNET_DAY = Date.UTC(2026, 0, 1);
const LOCAL_DAY = Date.UTC(2026, 0, 2);

vi.useFakeTimers({ toFake: ["Date"], now: TESTNET_DAY });

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
const NOTES_ENTRY_DB: DbFilledAt[] = [
  { path: ["aztecScanNotes", "uploadedAt"], wire: "iso" },
  { path: ["aztecScanNotes", "updatedAt"], wire: "iso" },
  { path: ["deployerMetadata", "uploadedAt"], wire: "iso" },
  { path: ["verifiedDeploymentArguments", "id"], wire: "uuid" },
];
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

/**
 * Pins the writer's string at `entry`, database-filled values fixed, as
 * `__snapshots__/cache/<name>.json.snap`, and returns that file's bytes, so a
 * reader is shown what an earlier revision committed rather than its own.
 */
const pinCacheString = async (
  entry: ReturnType<typeof cacheAt>,
  name: string,
  filled: readonly DbFilledAt[] = [],
) => {
  const file = `__snapshots__/cache/${name}.json.snap`;
  await expect(
    normalizedCacheString(await entry.stored(), filled),
  ).toMatchFileSnapshot(file);
  const url = new URL(file, import.meta.url);
  if (!existsSync(url)) {
    throw new Error(
      `${file} is written when this file's tests finish: run them again`,
    );
  }
  return readFileSync(url, "utf8");
};

describe("recorded chain data read back through Postgres and Redis", () => {
  let api: ExplorerApiForTest;
  let spec: unknown;
  let localNetwork: Promise<void> | undefined;

  /** A GET that names its OpenAPI path is checked against the document. */
  const get = async (path: string, openApiPath?: string, status = 200) => {
    const res = await api.request.get(path);
    expect(res.status, `GET ${path}: ${res.text.slice(0, 300)}`).toBe(status);
    const body: unknown = res.body;
    if (openApiPath) {
      spec ??= (
        await import("../../src/svcs/http-server/open-api-spec.js")
      ).genereateOpenApiSpec();
      expect(
        documentMismatches(spec, openApiPath, body),
        `GET ${path} against ${openApiPath}`,
      ).toEqual([]);
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

  // Reads filter on the current rollup version, the one first seen latest, so
  // the local network arrives a day after testnet and stays current. Every
  // group after testnet's runs on that day with these blocks stored, whichever
  // tests are selected.
  const atLocalNetwork = () => {
    vi.setSystemTime(LOCAL_DAY);
    localNetwork ??= deliverBlocks(LOCAL);
    return localNetwork;
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
    beforeAll(() => {
      // Once the local network's later-seen rollup version is current, the
      // testnet rows no longer read back.
      if (localNetwork) {
        throw new Error(
          "run the testnet blocks before any local-network suite",
        );
      }
      vi.setSystemTime(TESTNET_DAY);
      return deliverBlocks(TESTNET);
    });
    readBackBlocks(TESTNET);
  });

  describe("local-network blocks", () => {
    beforeAll(atLocalNetwork);
    readBackBlocks(LOCAL);

    // Class bodies are not checked against the document: it has only a POST
    // operation under the class path.
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
    beforeAll(atLocalNetwork);

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
    const instanceEntry = () =>
      cacheAt(api.stack, api.namespace, ["l2", "contract-instances", address]);
    let deploymentArguments: {
      publicKeysString: string;
      salt: string;
      deployer: string;
      constructorArgs: string[];
    };

    const verify = (body: Record<string, unknown>) =>
      api.request.post(`/l2/contract-instances/${address}`).send(body);

    beforeAll(async () => {
      await atLocalNetwork();
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
    // salt disagrees proves the answer came from the committed string.
    it("POST verifies the recorded deployment from the committed string of its cache entry", async () => {
      const entry = instanceEntry();
      await entry.remove();
      const first = await verify({
        verifiedDeploymentArguments: {
          ...deploymentArguments,
          stringifiedArtifactJson: JSON.stringify(artifact),
        },
      });
      expect(first.status, first.text).toBe(200);
      // The verification's own writer stores the artifact too: pinned in
      // digest form; the committed seed is the POST's smaller cache-miss entry.
      expect(
        snapshotOf(JSON.parse(await entry.stored()), VERIFIED_DB),
      ).toMatchSnapshot("string the verification writes");
      await entry.remove();
      const miss = await verify({
        verifiedDeploymentArguments: {
          ...deploymentArguments,
          salt: new Fr(3).toString(),
        },
      });
      expect([miss.status, miss.text]).toEqual([
        400,
        "Uploaded salt does not match the DB",
      ]);
      const committed = await pinCacheString(entry, "contract-instance", [
        { path: ["verifiedDeploymentArguments", "id"], wire: "uuid" },
      ]);

      onTestFinished(async () => {
        await setInstanceSalt(address, deploymentArguments.salt);
        await entry.remove();
      });
      await setInstanceSalt(address, new Fr(2).toString());
      await entry.remove();
      const fromDatabase = await verify({
        verifiedDeploymentArguments: deploymentArguments,
      });
      expect([fromDatabase.status, fromDatabase.text]).toEqual([
        400,
        "Uploaded salt does not match the DB",
      ]);

      await entry.seed(committed);
      const fromCache = await verify({
        verifiedDeploymentArguments: deploymentArguments,
      });
      expect([fromCache.status, fromCache.text]).toEqual([
        200,
        "Contract instance deployment arguments verified and stored",
      ]);
    });

    // Constructed: no recorded upload carries notes; outside production the
    // verified-deployment POST stores them with the deployer metadata.
    describe("after a verified upload with constructed aztec-scan notes and deployer metadata", () => {
      let posted: Awaited<ReturnType<typeof verify>>;

      beforeAll(async () => {
        const { rollupAddress } = CHAIN_INFO.chainInfo.l1ContractAddresses;
        posted = await verify({
          verifiedDeploymentArguments: {
            ...deploymentArguments,
            stringifiedArtifactJson: JSON.stringify(artifact),
          },
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
                { address: rollupAddress, note: "rollup" },
              ],
            },
          },
        });
        expect(posted.status, posted.text).toBe(200);
      });

      it("the POST answer and the notes route read back the stored notes and metadata", async () => {
        expect(snapshotOf(posted.body, VERIFIED_DB)).toMatchSnapshot(
          "POST response",
        );
        const notes = await get(
          "/l2/contract-instances/with-aztec-scan-notes",
          "/l2/contract-instances/with-aztec-scan-notes",
        );
        expect(notes).toHaveLength(1);
        expect(snapshotOf(notes, VERIFIED_DB)).toMatchSnapshot("notes route");
      });

      // The entry now carries the notes and metadata, which the POST's reader
      // parses too; the salt control proves the committed string answered.
      it("POST verifies from the committed cache string that carries the notes and metadata", async () => {
        const entry = instanceEntry();
        await entry.remove();
        const miss = await verify({
          verifiedDeploymentArguments: {
            ...deploymentArguments,
            salt: new Fr(3).toString(),
          },
        });
        expect([miss.status, miss.text]).toEqual([
          400,
          "Uploaded salt does not match the DB",
        ]);
        const committed = await pinCacheString(
          entry,
          "contract-instance-with-notes",
          NOTES_ENTRY_DB,
        );

        onTestFinished(async () => {
          await setInstanceSalt(address, deploymentArguments.salt);
          await entry.remove();
        });
        await setInstanceSalt(address, new Fr(2).toString());
        await entry.remove();
        const fromDatabase = await verify({
          verifiedDeploymentArguments: deploymentArguments,
        });
        expect([fromDatabase.status, fromDatabase.text]).toEqual([
          400,
          "Uploaded salt does not match the DB",
        ]);
        await entry.seed(committed);
        const fromCache = await verify({
          verifiedDeploymentArguments: deploymentArguments,
        });
        expect([fromCache.status, fromCache.text]).toEqual([
          200,
          "Contract instance deployment arguments verified and stored",
        ]);
      });

      // Their cache entries are removed, as when they expire, so the routes
      // read the rows the verification left.
      it("class and instance read back with the stored artifact, deployment arguments and notes", async () => {
        await instanceEntry().remove();
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
          expect(snapshotOf(await get(path))).toMatchSnapshot(
            `class ${classId}`,
          );
          expect(
            snapshotOf(await get(`${path}?includeArtifactJson=true`)),
          ).toMatchSnapshot(`class ${classId} with includeArtifactJson`);
        }
      });
    });
  });

  // Each reader is shown the committed string after the rows are gone: an
  // answer the database alone cannot give means it parsed that string.
  describe("cache readers", () => {
    beforeAll(atLocalNetwork);

    // From no rows, so the error's count does not depend on the other test.
    const deliverRpcNode = async () => {
      await removeRpcNodes();
      const { l2RpcNodeInfoHandler } = await import(
        "../../src/events/received/on-rpc-node-info.js"
      );
      const { l2RpcNodeErrorHandler } = await import(
        "../../src/events/received/on-l2-rpc-node.js"
      );
      await l2RpcNodeInfoHandler.cb(RPC_NODE);
      await l2RpcNodeErrorHandler.cb(RPC_NODE_ERROR);
    };

    it("GET /l2/rpc-nodes answers from the committed string of its cache entry", async () => {
      const path = "/l2/rpc-nodes";
      await deliverRpcNode();
      const entry = cacheAt(api.stack, api.namespace, [
        "l2",
        "rpc-nodes",
        LOCAL_TIP,
      ]);
      await entry.remove();
      expect(await get(path, path)).toHaveLength(1);
      const committed = await pinCacheString(entry, "rpc-nodes");

      await removeRpcNodes();
      await entry.remove();
      expect(await get(path)).toEqual([]);
      await entry.seed(committed);
      expect(snapshotOf(await get(path, path))).toMatchSnapshot("answer");
    });

    it("GET /l2/rpc-nodes/:rpcNodeName answers from the committed string of its cache entry", async () => {
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
      await get(path, "/l2/rpc-nodes/:rpcNodeName");
      // The node's own times come from its payload and the frozen clock; only
      // its error rows are stamped by Postgres (`defaultNow()`).
      const committed = await pinCacheString(entry, "rpc-node", [
        { path: ["errors", "*", "createdAt"], wire: "iso" },
        { path: ["errors", "*", "lastSeenAt"], wire: "iso" },
      ]);

      await removeRpcNodes();
      await entry.remove();
      await get(path, undefined, 404);
      await entry.seed(committed);
      expect(
        snapshotOf(await get(path, "/l2/rpc-nodes/:rpcNodeName")),
      ).toMatchSnapshot("answer");
    });

    // Constructed: validators come from an L1 contract read nothing recorded.
    // The attester is the recorded ValidatorQueued one, on the local rollup.
    it("GET /l1/l2-validators/totals answers from the committed string of its cache entry", async () => {
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
      expect(await get(path, path)).toMatchObject({ total: 1 });
      const committed = await pinCacheString(entry, "validator-totals");

      await removeValidators();
      await entry.remove();
      expect(await get(path)).toMatchObject({ total: 0 });
      await entry.seed(committed);
      expect(snapshotOf(await get(path, path))).toMatchSnapshot("answer");
    });
  });
});
