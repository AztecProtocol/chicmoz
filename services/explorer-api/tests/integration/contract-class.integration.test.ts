import { TokenContractArtifact } from "@aztec-labs/noir-contracts.js/Token";
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract";
import {
  ARTIFACT_MAX_DEPTH,
  ARTIFACT_REFUSED_MESSAGE,
} from "@chicmoz-pkg/contract-verification";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";

const BLOCK_HASH = `0x${"ab".repeat(32)}` as const;

describe("contract classes", () => {
  let api: ExplorerApiForTest;
  let contractClass: Awaited<ReturnType<typeof getContractClassFromArtifact>>;
  let classPath: string;

  beforeAll(async () => {
    api = await startExplorerApiForTest();
    contractClass = await getContractClassFromArtifact(TokenContractArtifact);
    classPath = `/l2/contract-classes/${contractClass.id.toString()}/versions/${contractClass.version}`;

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
      contractClassId: contractClass.id.toString(),
      version: contractClass.version,
      artifactHash: contractClass.artifactHash.toString(),
      privateFunctionsRoot: contractClass.privateFunctionsRoot.toString(),
      packedBytecode: contractClass.packedBytecode,
      artifactContractName: TokenContractArtifact.name,
    });
  });

  afterAll(async () => {
    await api?.close();
  });

  it("serves a class registered from a real artifact through the cached class route", async () => {
    const contractClassId = contractClass.id.toString();

    const res = await api.request.get(classPath);
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

  it("answers 400 with the refusal message for an artifact upload over a limit", async () => {
    // An object root, as compiler output has, holding arrays nested to the
    // limit: one level too deep.
    const nested =
      "[".repeat(ARTIFACT_MAX_DEPTH) + "]".repeat(ARTIFACT_MAX_DEPTH);

    const res = await api.request
      .post(classPath)
      .send({ stringifiedArtifactJson: `{"functions":${nested}}` });

    expect({ status: res.status, text: res.text }).toEqual({
      status: 400,
      text: ARTIFACT_REFUSED_MESSAGE,
    });
  });
});
