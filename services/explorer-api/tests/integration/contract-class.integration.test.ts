import { TokenContractArtifact } from "@aztec-labs/noir-contracts.js/Token";
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";

const BLOCK_HASH = `0x${"ab".repeat(32)}` as const;

describe("contract classes", () => {
  let api: ExplorerApiForTest;

  beforeAll(async () => {
    api = await startExplorerApiForTest();
  });

  afterAll(async () => {
    await api?.close();
  });

  it("serves a class registered from a real artifact through the cached class route", async () => {
    const contractClass = await getContractClassFromArtifact(
      TokenContractArtifact,
    );
    const contractClassId = contractClass.id.toString();

    // A class row references its block; a bare block row satisfies the key.
    const { getDb } = await import("@chicmoz-pkg/postgres-helper");
    const { l2Block } = await import(
      "../../src/svcs/database/schema/l2block/root.js"
    );
    await getDb()
      .insert(l2Block)
      .values({ hash: BLOCK_HASH, height: 1n, version: 1 });
    const { controllers } = await import("../../src/svcs/database/index.js");
    await controllers.l2Contract.storeContractClass({
      blockHash: BLOCK_HASH,
      contractClassId,
      version: contractClass.version,
      artifactHash: contractClass.artifactHash.toString(),
      privateFunctionsRoot: contractClass.privateFunctionsRoot.toString(),
      packedBytecode: contractClass.packedBytecode,
      artifactContractName: TokenContractArtifact.name,
    });

    const res = await api.request.get(
      `/l2/contract-classes/${contractClassId}/versions/${contractClass.version}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      contractClassId,
      version: contractClass.version,
      artifactHash: contractClass.artifactHash.toString(),
      artifactContractName: "Token",
    });

    const key = [
      api.namespace,
      "SANDBOX-l2-contract-classes",
      contractClassId,
      contractClass.version,
      "without-artifact",
    ].join("-");
    expect(
      (await api.stack.exec("redis", ["redis-cli", "EXISTS", key])).trim(),
    ).toBe("1");
  });
});
