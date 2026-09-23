import { type FC } from "react";
import {
  ConsoleHead,
  type ConsoleCrumb,
  Shell,
  type TopBarActive,
} from "~/components/layout";

interface Props {
  active?: TopBarActive;
  crumbs: ConsoleCrumb[];
  comment?: string;
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
}

/**
 * Loading / not-found / load-error shell for detail pages — Shell + ConsoleHead + a single
 * empty-state panel. Pages with multi-state empty UIs (e.g. tx-detail's
 * mined/pending/dropped split) inline their own panels instead of using this.
 */
export const DetailEmptyState: FC<Props> = ({
  active,
  crumbs,
  comment,
  message,
  onRetry,
  retrying,
}) => (
  <Shell active={active}>
    <ConsoleHead crumbs={crumbs} comment={comment} />
    <div className="panel">
      <LoadStateMessage
        message={message}
        onRetry={onRetry}
        retrying={retrying}
      />
    </div>
  </Shell>
);

/**
 * Empty-state line with an optional retry action, for request failures.
 */
export const LoadStateMessage: FC<{
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
}> = ({ message, onRetry, retrying }) => (
  <div className="empty-state">
    {retrying ? "retrying…" : message}
    {onRetry && !retrying && (
      <>
        {" · "}
        <button type="button" className="empty-state-retry" onClick={onRetry}>
          retry
        </button>
      </>
    )}
  </div>
);
