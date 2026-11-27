import { TimeoutError } from "@aztec-labs/foundation/error";
import { logger } from "../../../logger.js";
import { withDeadline } from "./deadline.js";
import { callNodeFunction } from "./index.js";
import { type RpcNode } from "./pool.js";
import { redactUrls } from "./redact-urls.js";

export type ReportedVersion = { node: RpcNode; version: number };

/**
 * The highest rollup version the nodes' node info reports, with a node that
 * reports it, or undefined when none answers within `timeoutMs`.
 */
export const readLatestRollupVersion = async (
  nodes: RpcNode[],
  timeoutMs: number,
): Promise<ReportedVersion | undefined> => {
  const reports = await Promise.all(
    nodes.map(async (node): Promise<ReportedVersion | undefined> => {
      try {
        const info = await withDeadline(
          callNodeFunction("getNodeInfo", [], node),
          timeoutMs,
          () =>
            new TimeoutError(
              `Node ${node.name} did not answer getNodeInfo within ${
                timeoutMs / 1000
              } s`,
            ),
        );
        return Number.isSafeInteger(info?.rollupVersion)
          ? { node, version: info.rollupVersion }
          : undefined;
      } catch (e) {
        logger.info(
          `Node ${node.name} reported no rollup version: ${redactUrls((e as Error).message)}`,
        );
        return undefined;
      }
    }),
  );
  let latest: ReportedVersion | undefined;
  for (const report of reports) {
    if (report !== undefined && report.version > (latest?.version ?? -1)) {
      latest = report;
    }
  }
  return latest;
};
