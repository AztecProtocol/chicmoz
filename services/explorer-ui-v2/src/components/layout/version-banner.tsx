import { type FC } from "react";
import { getCanonicalDeployment } from "~/service/deployments";
import {
  DEPLOYMENT_STATUS,
  L2_NETWORK_ID,
  NETWORK_VERSION,
  UI_DEPLOYMENTS,
} from "~/service/constants";
import { normalizeUrl } from "./deployment-url";

const canonical = getCanonicalDeployment(UI_DEPLOYMENTS, L2_NETWORK_ID);

/** Tells visitors of a previous Aztec version where the current one is. */
export const VersionBanner: FC = () => {
  if (DEPLOYMENT_STATUS === "canonical") {
    return null;
  }

  const current = `${L2_NETWORK_ID} ${NETWORK_VERSION ?? ""}`.trim();
  const isArchived = DEPLOYMENT_STATUS === "archived";

  return (
    <div className="version-banner" role="status">
      <span className="version-banner-tag">
        {isArchived ? "archived" : "previous version"}
      </span>
      <span>
        {isArchived
          ? `You're viewing ${current}, a previous rollup that no longer produces blocks. This is its stored history.`
          : `You're viewing ${current}, a previous rollup that is still running.`}
        {canonical ? (
          <>
            {" "}
            <a href={normalizeUrl(canonical.url)}>
              Go to {canonical.network}
              {canonical.version ? ` ${canonical.version}` : ""}, the current
              network →
            </a>
          </>
        ) : null}
      </span>
    </div>
  );
};
