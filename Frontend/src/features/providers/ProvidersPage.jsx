import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client.js";
import { ErrorNotice } from "../../components/ErrorNotice.jsx";
import { PageHeader } from "../../components/PageHeader.jsx";
import { ProviderBadge } from "../../components/ProviderBadge.jsx";
import { Skeleton } from "../../components/Skeleton.jsx";
import { StatusBadge } from "../../components/StatusBadge.jsx";
import { formatMs, formatNumber, formatPercent } from "../../lib/format.js";

// Circuit state changes within seconds, so this page refreshes more often than Overview.
const REFRESH_MS = 15_000;

function Figure({ label, value }) {
  return (
    <div>
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="text-lg font-semibold text-slate-100 tabular-nums">{value}</dd>
    </div>
  );
}

function ProviderCard({ provider, windowMinutes }) {
  const { configured, circuit, recent, models } = provider;
  return (
    <section
      aria-label={provider.provider}
      className={`rounded-lg border border-slate-800 bg-slate-900 p-4 ${configured ? "" : "opacity-60"}`}
    >
      <div className="mb-4 flex items-center justify-between gap-2">
        <ProviderBadge provider={provider.provider} />
        {configured ? (
          <StatusBadge status={circuit.state} />
        ) : (
          <StatusBadge status="not configured" label="Not configured" />
        )}
      </div>

      {configured ? (
        <>
          <dl className="grid grid-cols-3 gap-2">
            <Figure label="Error rate" value={formatPercent(recent.errorRate)} />
            <Figure label="p50 latency" value={formatMs(recent.p50LatencyMs)} />
            <Figure label="Requests" value={formatNumber(recent.requests)} />
          </dl>
          <p className="mt-2 text-xs text-slate-400">
            Last {windowMinutes} minutes, all users
            {circuit.recentFailures > 0 && ` · ${circuit.recentFailures} recent failures`}
          </p>
          {circuit.state !== "closed" && (
            <p className="mt-2 text-xs text-amber-300">
              {circuit.state === "open"
                ? "Skipped: requests go to the next provider in each fallback chain."
                : "Testing: one request is let through to see if it has recovered."}
            </p>
          )}
        </>
      ) : (
        <p className="text-sm text-slate-400">
          The server has no key for this provider, so it is left out of every fallback chain.
        </p>
      )}

      <div className="mt-4 border-t border-slate-800 pt-3">
        <p className="mb-1 text-xs text-slate-400">Models</p>
        <ul className="flex flex-wrap gap-1">
          {models.map((model) => (
            <li
              key={model}
              className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-xs text-slate-300"
            >
              {model}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function ProvidersPage() {
  const health = useQuery({
    queryKey: ["providers", "health"],
    queryFn: ({ signal }) => api("/api/providers/health", { signal }),
    refetchInterval: REFRESH_MS,
  });

  return (
    <>
      <PageHeader
        title="Providers"
        description="Circuit state and recent health of each provider, refreshed every 15 seconds"
      />
      {health.isError ? (
        <ErrorNotice
          error={health.error}
          title="Couldn't load provider health"
          onRetry={() => health.refetch()}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {health.isPending
            ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-56" />)
            : // Configured providers first; the order within each group is the server's.
              [...health.data.providers]
                .sort((a, b) => Number(b.configured) - Number(a.configured))
                .map((provider) => (
                  <ProviderCard
                    key={provider.provider}
                    provider={provider}
                    windowMinutes={health.data.windowMinutes}
                  />
                ))}
        </div>
      )}
    </>
  );
}
