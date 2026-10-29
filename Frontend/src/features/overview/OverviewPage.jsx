import { useState } from "react";
import { Link } from "react-router-dom";
import { API_URL } from "../../api/client.js";
import { EmptyState } from "../../components/EmptyState.jsx";
import { ErrorNotice } from "../../components/ErrorNotice.jsx";
import { PageHeader } from "../../components/PageHeader.jsx";
import { StatTile } from "../../components/StatTile.jsx";
import { formatMs, formatNumber, formatPercent, formatUsd } from "../../lib/format.js";
import {
  CacheHitChart,
  CostByModelChart,
  LatencyByProviderChart,
  RequestsChart,
} from "./OverviewCharts.jsx";
import { RANGES, useOverview } from "./useOverview.js";

function RangePicker({ value, onChange }) {
  return (
    <div role="group" aria-label="Time range" className="flex rounded-md border border-slate-700">
      {Object.entries(RANGES).map(([key, range]) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          title={range.label}
          onClick={() => onChange(key)}
          className={`px-3 py-1.5 text-sm transition-colors duration-150 first:rounded-l-md last:rounded-r-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
            value === key
              ? "bg-slate-800 text-slate-100"
              : "text-slate-400 hover:bg-slate-900 hover:text-slate-100"
          }`}
        >
          {key}
        </button>
      ))}
    </div>
  );
}

function FirstRequest() {
  const curl = `curl ${API_URL}/v1/chat \\
  -H "Authorization: Bearer $LLMUX_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"fast","messages":[{"role":"user","content":"Hello"}]}'`;
  return (
    <EmptyState
      title="Send your first request"
      className="mb-6"
      action={
        <Link to="/keys" className="text-sm font-medium text-indigo-300 hover:text-indigo-200">
          Create a gateway key
        </Link>
      }
    >
      <p>Requests made with your keys show up here within a few seconds.</p>
      <pre className="mt-4 overflow-x-auto rounded-md bg-slate-950 p-3 text-left font-mono text-xs text-slate-300">
        {curl}
      </pre>
    </EmptyState>
  );
}

export function OverviewPage() {
  const [range, setRange] = useState("24h");
  const { summary, requests, cached, byModel, byProvider } = useOverview(range);
  const { interval, label } = RANGES[range];
  const totals = summary.data;
  const loading = summary.isPending;

  return (
    <>
      <PageHeader title="Overview" description={`${label}, refreshed every 30 seconds`}>
        <RangePicker value={range} onChange={setRange} />
      </PageHeader>

      {summary.isError ? (
        <ErrorNotice
          error={summary.error}
          title="Couldn't load usage"
          onRetry={() => summary.refetch()}
          className="mb-6"
        />
      ) : (
        <>
          {totals?.requests === 0 && <FirstRequest />}
          <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Requests"
              value={formatNumber(totals?.requests)}
              caption={totals && `${formatNumber(totals.totalTokens)} tokens`}
              loading={loading}
            />
            <StatTile label="Total cost" value={formatUsd(totals?.costUsd)} loading={loading} />
            <StatTile
              label="Saved by cache"
              value={formatUsd(totals?.savedUsd)}
              caption={totals && `${formatNumber(totals.cacheHits)} cache hits`}
              loading={loading}
            />
            <StatTile
              label="Error rate"
              value={formatPercent(totals?.errorRate)}
              caption={totals && `${formatNumber(totals.errors)} failed`}
              loading={loading}
            />
          </div>
          <div className="mb-6 flex flex-wrap gap-x-8 gap-y-1 rounded-lg border border-slate-800 bg-slate-900 px-4 py-3 text-sm">
            <span className="text-slate-400">Latency of successful requests</span>
            <span>
              <span className="text-slate-400">p50 </span>
              <span className="font-medium tabular-nums">
                {loading ? "…" : formatMs(totals?.latencyMs.p50)}
              </span>
            </span>
            <span>
              <span className="text-slate-400">p95 </span>
              <span className="font-medium tabular-nums">
                {loading ? "…" : formatMs(totals?.latencyMs.p95)}
              </span>
            </span>
          </div>
        </>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RequestsChart query={requests} interval={interval} />
        <CostByModelChart query={byModel} />
        <LatencyByProviderChart query={byProvider} />
        <CacheHitChart requests={requests} cached={cached} interval={interval} />
      </div>
    </>
  );
}
