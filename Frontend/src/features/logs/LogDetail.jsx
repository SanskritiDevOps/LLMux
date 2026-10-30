import { Dialog } from "../../components/Dialog.jsx";
import { ProviderBadge } from "../../components/ProviderBadge.jsx";
import { StatusBadge } from "../../components/StatusBadge.jsx";
import { formatDateTime, formatMs, formatNumber, formatUsd } from "../../lib/format.js";

function Row({ label, children, mono = false }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-2">
      <dt className="text-slate-400">{label}</dt>
      <dd className={`col-span-2 break-all text-slate-100 ${mono ? "font-mono text-xs" : ""}`}>
        {children}
      </dd>
    </div>
  );
}

/** Everything stored about one request, in a side panel. */
export function LogDetail({ log, onClose }) {
  return (
    <Dialog open={Boolean(log)} onClose={onClose} title="Request details" variant="side">
      {log && (
        <dl className="divide-y divide-slate-800 text-sm">
          <Row label="Request ID" mono>
            <span className="select-all">{log.requestId}</span>
          </Row>
          <Row label="Time">{formatDateTime(log.createdAt)}</Row>
          <Row label="Status">
            <StatusBadge status={log.status} />
            {log.errorCode && <span className="ml-2 font-mono text-xs">{log.errorCode}</span>}
          </Row>
          <Row label="Model" mono>
            {log.model}
          </Row>
          <Row label="Provider">
            <ProviderBadge provider={log.provider} />
          </Row>
          <Row label="Provider model" mono>
            {log.providerModel ?? "—"}
          </Row>
          <Row label="Key">
            {log.key.name}{" "}
            <span className="font-mono text-xs text-slate-400">{log.key.prefix}</span>
          </Row>
          <Row label="Tokens">
            {formatNumber(log.inputTokens)} in · {formatNumber(log.outputTokens)} out
            {log.usageEstimated && <StatusBadge status="estimated" />}
          </Row>
          <Row label="Cost">{formatUsd(log.costUsd)}</Row>
          {log.cached && <Row label="Saved by cache">{formatUsd(log.savedUsd)}</Row>}
          <Row label="Latency">{formatMs(log.latencyMs)}</Row>
          <Row label="First token">{formatMs(log.timeToFirstTokenMs)}</Row>
          <Row label="Attempts">
            {log.attempts}
            {log.fallbackUsed && <span className="ml-2">(fallback used)</span>}
          </Row>
          <Row label="Transport" mono>
            {log.transport}
          </Row>
          <Row label="Metadata" mono>
            {log.metadata ? JSON.stringify(log.metadata, null, 2) : "—"}
          </Row>
        </dl>
      )}
    </Dialog>
  );
}
