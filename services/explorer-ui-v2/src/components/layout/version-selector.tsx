import { type FC, useCallback, useMemo, useRef, useState } from "react";
import { useDismissableMenu } from "~/hooks/use-dismissable-menu";
import { cn } from "~/lib/utils";
import {
  type DeploymentStatus,
  getVersionEntries,
} from "~/service/deployments";
import {
  L2_NETWORK_ID,
  NETWORK_VERSION,
  UI_DEPLOYMENTS,
} from "~/service/constants";
import { normalizeUrl } from "./deployment-url";

const STATUS_LABEL: Record<DeploymentStatus, string> = {
  canonical: "current",
  live: "previous",
  archived: "archived",
};

/**
 * Picks the major Aztec version of the current network. Each version is its
 * own deployment with its own chain history, so switching opens that
 * version's landing page rather than the current path.
 */
export const VersionSelector: FC = () => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissableMenu(ref, open, close);

  const versions = useMemo(
    () =>
      getVersionEntries(UI_DEPLOYMENTS, L2_NETWORK_ID).map(
        ({ version, status, url }) => ({
          version: version ?? "",
          status,
          url: normalizeUrl(url),
        }),
      ),
    [],
  );

  if (NETWORK_VERSION === null) {
    return null;
  }

  if (versions.length <= 1) {
    return (
      <div className="brand-env version-selector">{NETWORK_VERSION}</div>
    );
  }

  return (
    <div className="network-selector version-selector" ref={ref}>
      <button
        type="button"
        className={cn("brand-env network-trigger", open && "on")}
        aria-label="Select Aztec version"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{NETWORK_VERSION}</span>
        <span className="network-caret">▾</span>
      </button>
      {open ? (
        <div className="network-dropdown" role="menu">
          {versions.map((entry) => {
            const isActive = entry.version === NETWORK_VERSION;
            return (
              <button
                key={`${entry.version}-${entry.url}`}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                className={cn("network-option", isActive && "active")}
                onClick={() => {
                  if (isActive) {
                    close();
                    return;
                  }
                  window.location.assign(entry.url);
                }}
              >
                <span className="network-dot" />
                <span className="version-name">{entry.version}</span>
                <span
                  className={cn(
                    "version-status",
                    entry.status !== "canonical" && "previous",
                  )}
                >
                  {STATUS_LABEL[entry.status]}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};
