import { useState } from "react";
import { Button } from "../../components/Button.jsx";
import { DataTable } from "../../components/DataTable.jsx";
import { EmptyState } from "../../components/EmptyState.jsx";
import { ErrorNotice } from "../../components/ErrorNotice.jsx";
import { PageHeader } from "../../components/PageHeader.jsx";
import { ProviderBadge } from "../../components/ProviderBadge.jsx";
import { StatusBadge } from "../../components/StatusBadge.jsx";
import { formatDateTime, formatMs, formatNumber, formatUsd } from "../../lib/format.js";
import { LogDetail } from "./LogDetail.jsx";
import { LogFilters } from "./LogFilters.jsx";
import { useLogs } from "./useLogs.js";

const NO_FILTERS = { model: "", provider: "", status: "", cached: "", keyId: "" };

const columns = [
  { key: "time", header: "Time", render: (log) => formatDateTime(log.createdAt) },
  { key: "model", header: "Model", className: "font-mono text-xs", render: (log) => log.model },
  {
    key: "provider",
    header: "Provider",
    render: (log) => <ProviderBadge provider={log.provider} />,
  },
  {
    key: "tokens",
    header: "Tokens in / out",
    align: "right",
    render: (log) => `${formatNumber(log.inputTokens)} / ${formatNumber(log.outputTokens)}`,
  },
  { key: "cost", header: "Cost", align: "right", render: (log) => formatUsd(log.costUsd) },
  { key: "latency", header: "Latency", align: "right", render: (log) => formatMs(log.latencyMs) },
  { key: "status", header: "Status", render: (log) => <StatusBadge status={log.status} /> },
  {
    key: "flags",
    header: "Cache / fallback",
    render: (log) => (
      <span className="flex gap-1">
        {log.cached && <StatusBadge status="cached" />}
        {log.fallbackUsed && <StatusBadge status="fallback" />}
        {!log.cached && !log.fallbackUsed && <span className="text-slate-500">—</span>}
      </span>
    ),
  },
];

export function LogsPage() {
  const [filters, setFilters] = useState(NO_FILTERS);
  const [selected, setSelected] = useState(null);
  const logs = useLogs(filters);
  const rows = logs.data?.pages.flatMap((page) => page.logs) ?? [];
  const filtered = Object.values(filters).some(Boolean);

  return (
    <>
      <PageHeader title="Logs" description="Every request made with your keys, newest first" />
      <LogFilters filters={filters} onChange={setFilters} />

      {logs.isError && (
        <ErrorNotice
          error={logs.error}
          title="Couldn't load logs"
          onRetry={() => logs.refetch()}
          className="mb-4"
        />
      )}

      {!logs.isPending && !logs.isError && rows.length === 0 ? (
        <EmptyState title={filtered ? "No requests match these filters" : "No requests yet"}>
          {filtered
            ? "Try clearing a filter."
            : "Requests appear here a few seconds after they are made."}
        </EmptyState>
      ) : (
        !logs.isError && (
          <DataTable
            caption="Request logs"
            columns={columns}
            rows={rows}
            rowKey={(log) => log.id}
            loading={logs.isPending}
            onRowClick={setSelected}
            rowLabel={(log) => `${log.model} at ${formatDateTime(log.createdAt)}, ${log.status}`}
          />
        )
      )}

      {logs.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="secondary"
            loading={logs.isFetchingNextPage}
            onClick={() => logs.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      )}

      <LogDetail log={selected} onClose={() => setSelected(null)} />
    </>
  );
}
