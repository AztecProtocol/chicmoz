import { type ChicmozL2TxEffectDeluxe } from "@chicmoz-pkg/types";
import { Link, useParams } from "@tanstack/react-router";
import { type FC, useState } from "react";
import {
  DetailField,
  FeePaymentMethodBadge,
  CopyableAmount,
  L2AddressLink,
  StatusPill,
  TokenEtherscanLink,
} from "~/components/common";
import { L2ToL1MsgsTable } from "~/components/data/l2-to-l1-msgs-table";
import { PublicCallRequestsTable } from "~/components/data/public-call-requests-table";
import { ConsoleHead, Shell } from "~/components/layout";
import { HashList } from "./hash-list";
import { LogsPanel } from "./logs-panel";
import {
  useDroppedTxByHash,
  useGetTxEffectByHash,
  usePendingTxsByHash,
  usePublicCallRequestsByTxHash,
  useChainInfo,
} from "~/hooks/api";
import {
  ageStr,
  fmtNum,
  formatFees,
  getFeeJuiceSymbol,
  toIsoUtc,
  truncateHashString,
} from "~/lib/utils";

type Tab = "notes" | "nulls" | "public" | "l1" | "logs" | "calls";

// By hash: a height names whichever block is canonical there when the link
// is followed, which can be another block by then.
const EffectBlockLink: FC<{ effect: ChicmozL2TxEffectDeluxe }> = ({
  effect,
}) => (
  <Link to="/blocks/$blockNumber" params={{ blockNumber: effect.blockHash }}>
    #{fmtNum(Number(effect.blockHeight))}
  </Link>
);

export const TxDetailPage: FC = () => {
  const { hash = "" } = useParams({ strict: false });
  const [tab, setTab] = useState<Tab>("notes");

  const { data: pending } = usePendingTxsByHash(hash);
  const { data: effect } = useGetTxEffectByHash(hash, !!pending);
  const { data: dropped } = useDroppedTxByHash(hash);
  const { data: chainInfo } = useChainInfo();
  const { data: minedPublicCalls } = usePublicCallRequestsByTxHash(
    effect ? hash : "",
  );
  const feeJuiceDecimals = chainInfo?.feeJuiceDecimals ?? 18;
  const feeJuiceSymbol = getFeeJuiceSymbol(chainInfo?.feeJuiceSymbol);
  const feeJuiceAddress = chainInfo?.l1ContractAddresses?.feeJuiceAddress;

  // Only a block on the chain mines a tx: an orphaned block's effect is history.
  const historical = effect?.isOrphaned === true;
  const mined = !!effect && !historical;
  // No status while no lookup has found the tx.
  const status = mined
    ? "mined"
    : dropped
      ? "dropped"
      : pending
        ? "pending"
        : historical
          ? "orphaned"
          : undefined;

  const ts = effect?.timestamp
    ? effect.timestamp
    : pending?.birthTimestamp
      ? pending.birthTimestamp
      : dropped?.droppedAt
        ? dropped.droppedAt
        : undefined;

  const noteHashes = effect?.noteHashes ?? [];
  const nullifiers = effect?.nullifiers ?? [];
  const publicDataWrites = effect?.publicDataWrites ?? [];
  const l2ToL1Msgs = effect?.l2ToL1Msgs ?? [];
  const privateLogs = effect?.privateLogs ?? [];
  const publicLogs = effect?.publicLogs ?? [];
  const contractClassLogs = effect?.contractClassLogs ?? [];
  const logsCount =
    privateLogs.length + publicLogs.length + contractClassLogs.length;

  return (
    <Shell active="txs">
      <ConsoleHead
        crumbs={[
          { label: "aztec-scan", to: "/" },
          { label: "tx-effects", to: "/tx-effects" },
          { label: truncateHashString(hash, 12, 10), active: true },
        ]}
        comment={`/api/l2/tx-effects/${truncateHashString(hash, 8, 6)}`}
      />

      <div className="detail-header">
        <div className="kicker">Tx effect · {ts ? ageStr(ts) : "—"}</div>
        <h1 className="hash-sized">{hash}</h1>
        <div className="meta-row">
          {status && <StatusPill status={status} />}
          {effect?.blockHeight !== undefined && (
            <span className="meta-line">
              {historical ? "was in" : "in"} <EffectBlockLink effect={effect} />
            </span>
          )}
          {status === "dropped" && dropped && (
            <span className="meta-line" style={{ color: "var(--red)" }}>
              dropped at {toIsoUtc(dropped.droppedAt)}
            </span>
          )}
        </div>
      </div>

      {effect && (
        <>
          <div className="stats-strip">
            <div className="sc">
              <div className="lbl">Fee paid</div>
              <div className="val">
                <CopyableAmount
                  displayAmount={formatFees(
                    effect.transactionFee,
                    feeJuiceDecimals,
                    5,
                  )}
                  rawAmount={effect.transactionFee}
                />
                <TokenEtherscanLink
                  symbol={feeJuiceSymbol}
                  address={feeJuiceAddress}
                  className="u"
                />
              </div>
            </div>
            <div className="sc">
              <div className="lbl">Block</div>
              <div className="val">
                <EffectBlockLink effect={effect} />
              </div>
            </div>
            <div className="sc">
              <div className="lbl">Note hashes</div>
              <div className="val">{noteHashes.length}</div>
            </div>
            <div className="sc">
              <div className="lbl">Nullifiers</div>
              <div className="val">{nullifiers.length}</div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3>
                Transaction
                <span className="tag">
                  {historical ? "in an orphaned block" : "mined transaction"}
                </span>
              </h3>
            </div>
            <div className="kv-grid">
              <DetailField label="Tx hash" width="extra-wide">
                {effect.txHash}
              </DetailField>
              <DetailField label="Status" width="extra-wide">
                {historical ? (
                  <span style={{ color: "var(--red)" }}>orphaned</span>
                ) : (
                  <span style={{ color: "var(--green)" }}>mined</span>
                )}
              </DetailField>
              <DetailField label="Block" width="extra-wide">
                <EffectBlockLink effect={effect} />
              </DetailField>
              <DetailField label="Block hash" width="extra-wide">
                {effect.blockHash}
              </DetailField>
              <DetailField label="Timestamp" width="extra-wide">
                {toIsoUtc(ts)}{" "}
                <span className="mute">· {ts ? ageStr(ts) : "—"}</span>
              </DetailField>
              <DetailField label="Transaction fee" width="extra-wide">
                <CopyableAmount
                  displayAmount={formatFees(
                    effect.transactionFee,
                    feeJuiceDecimals,
                    5,
                  )}
                  rawAmount={effect.transactionFee}
                />{" "}
                <TokenEtherscanLink
                  symbol={feeJuiceSymbol}
                  address={feeJuiceAddress}
                />
              </DetailField>
              {effect.feePayer && (
                <DetailField label="Fee payer" width="extra-wide">
                  <L2AddressLink address={effect.feePayer} truncate={false} />
                </DetailField>
              )}
              {effect.initiator && (
                <DetailField label="Initiator" width="extra-wide">
                  <L2AddressLink address={effect.initiator} truncate={false} />
                </DetailField>
              )}
              {effect.feePaymentMethod && (
                <DetailField label="Fee payment method" width="extra-wide">
                  <FeePaymentMethodBadge method={effect.feePaymentMethod} />
                </DetailField>
              )}
              <DetailField label="Revert code" width="extra-wide">
                <span
                  style={{
                    color: effect.revertCode.code
                      ? "var(--red)"
                      : "var(--green)",
                  }}
                >
                  {effect.revertCode.code} ·{" "}
                  {effect.revertCode.code ? "reverted" : "ok"}
                </span>
              </DetailField>
            </div>
          </div>

          <div className="panel">
            <div className="tabs">
              <button
                className={tab === "notes" ? "on" : ""}
                onClick={() => setTab("notes")}
              >
                Note hashes<span className="c">{noteHashes.length}</span>
              </button>
              <button
                className={tab === "nulls" ? "on" : ""}
                onClick={() => setTab("nulls")}
              >
                Nullifiers<span className="c">{nullifiers.length}</span>
              </button>
              <button
                className={tab === "public" ? "on" : ""}
                onClick={() => setTab("public")}
              >
                Public writes
                <span className="c">{publicDataWrites.length}</span>
              </button>
              <button
                className={tab === "l1" ? "on" : ""}
                onClick={() => setTab("l1")}
              >
                L2 → L1 msgs<span className="c">{l2ToL1Msgs.length}</span>
              </button>
              <button
                className={tab === "logs" ? "on" : ""}
                onClick={() => setTab("logs")}
              >
                Logs<span className="c">{logsCount}</span>
              </button>
              <button
                className={tab === "calls" ? "on" : ""}
                onClick={() => setTab("calls")}
              >
                Public calls
                <span className="c">{minedPublicCalls?.length ?? 0}</span>
              </button>
            </div>
            {tab === "notes" && (
              <HashList items={noteHashes} emptyMessage="no note hashes" />
            )}
            {tab === "nulls" && (
              <HashList items={nullifiers} emptyMessage="no nullifiers" />
            )}
            {tab === "public" && (
              <div>
                {publicDataWrites.map((w, i) => (
                  <div key={i} className="list-row">
                    <span className="idx">{i}</span>
                    <span className="v">
                      <span style={{ color: "var(--ink-3)" }}>slot </span>
                      {w.leafSlot}
                      <br />
                      <span style={{ color: "var(--ink-3)" }}>val </span>
                      {w.value}
                    </span>
                  </div>
                ))}
                {publicDataWrites.length === 0 && (
                  <div className="empty-state">no public data writes</div>
                )}
              </div>
            )}
            {tab === "l1" && (
              <HashList items={l2ToL1Msgs} emptyMessage="no L2 → L1 messages" />
            )}
            {tab === "logs" && (
              <LogsPanel
                privateLogs={privateLogs}
                publicLogs={publicLogs}
                contractClassLogs={contractClassLogs}
              />
            )}
            {tab === "calls" && (
              <PublicCallRequestsTable data={minedPublicCalls} />
            )}
          </div>
        </>
      )}

      {status === "pending" && pending && (
        <>
          <div className="panel">
            <div className="panel-head">
              <h3>
                Pending
                <span className="tag">
                  /api/l2/txs/{truncateHashString(hash, 6, 4)}
                </span>
              </h3>
            </div>
            <div className="kv-grid">
              <DetailField label="Tx hash" width="extra-wide">
                {pending.txHash}
              </DetailField>
              <DetailField label="Fee payer" width="extra-wide">
                <L2AddressLink address={pending.feePayer} truncate={false} />
              </DetailField>
              {pending.initiator && (
                <DetailField label="Initiator" width="extra-wide">
                  <L2AddressLink address={pending.initiator} truncate={false} />
                </DetailField>
              )}
              {pending.feePaymentMethod && (
                <DetailField label="Fee payment method" width="extra-wide">
                  <FeePaymentMethodBadge method={pending.feePaymentMethod} />
                </DetailField>
              )}
              <DetailField label="Seen at" width="extra-wide">
                {toIsoUtc(pending.birthTimestamp)}{" "}
                <span className="mute">· {ageStr(pending.birthTimestamp)}</span>
              </DetailField>
            </div>
          </div>

          {pending.publicCallRequests &&
            pending.publicCallRequests.length > 0 && (
              <div className="panel">
                <div className="panel-head">
                  <h3>
                    Public call requests
                    <span className="c">
                      {pending.publicCallRequests.length}
                    </span>
                  </h3>
                </div>
                <PublicCallRequestsTable data={pending.publicCallRequests} />
              </div>
            )}

          {pending.l2ToL1Msgs && pending.l2ToL1Msgs.length > 0 && (
            <div className="panel">
              <div className="panel-head">
                <h3>
                  L2 → L1 messages
                  <span className="c">{pending.l2ToL1Msgs.length}</span>
                </h3>
              </div>
              <L2ToL1MsgsTable data={pending.l2ToL1Msgs} omitTxHash />
            </div>
          )}
        </>
      )}

      {status === "dropped" && dropped && (
        <div className="panel">
          <div className="panel-head">
            <h3>
              Dropped
              <span className="tag">
                /api/l2/dropped-txs/{truncateHashString(hash, 6, 4)}
              </span>
            </h3>
          </div>
          <div className="kv-grid">
            <DetailField label="Tx hash" width="extra-wide">
              {dropped.txHash}
            </DetailField>
            <DetailField label="Seen as pending at" width="extra-wide">
              {toIsoUtc(dropped.createdAsPendingAt)}
            </DetailField>
            <DetailField label="Dropped at" width="extra-wide">
              {toIsoUtc(dropped.droppedAt)}
            </DetailField>
            {dropped.dropReason && (
              <DetailField label="Reason" width="extra-wide">
                {dropped.dropReason}
              </DetailField>
            )}
          </div>
        </div>
      )}

      {!effect && !pending && !dropped && (
        <div className="panel">
          <div className="empty-state">tx not found</div>
        </div>
      )}
    </Shell>
  );
};
