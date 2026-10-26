import { type FC, useCallback, useMemo, useRef, useState } from "react";
import { useDismissableMenu } from "~/hooks/use-dismissable-menu";
import { cn } from "~/lib/utils";
import { getNetworkEntries } from "~/service/deployments";
import { L2_NETWORK_ID, UI_DEPLOYMENTS } from "~/service/constants";
import { normalizeUrl, withCurrentPath } from "./deployment-url";

/** Picks the network; switching always lands on its canonical version. */
export const NetworkSelector: FC = () => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissableMenu(ref, open, close);
  const currentNetwork = L2_NETWORK_ID;

  const networks = useMemo(
    () =>
      getNetworkEntries(UI_DEPLOYMENTS).map(({ network, url }) => ({
        name: network,
        url: normalizeUrl(url),
      })),
    [],
  );

  if (networks.length <= 1) {
    return <div className="brand-env">{currentNetwork}</div>;
  }

  return (
    <div className="network-selector" ref={ref}>
      <button
        type="button"
        className={cn("brand-env network-trigger", open && "on")}
        aria-label="Select Aztec network"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{currentNetwork}</span>
        <span className="network-caret">▾</span>
      </button>
      {open ? (
        <div className="network-dropdown" role="menu">
          {networks.map((network) => {
            const isActive = network.name === currentNetwork;
            return (
              <button
                key={`${network.name}-${network.url}`}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                className={cn("network-option", isActive && "active")}
                onClick={() => {
                  if (isActive) {
                    close();
                    return;
                  }
                  window.location.assign(withCurrentPath(network.url));
                }}
              >
                <span className="network-dot" />
                <span>{network.name}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};
