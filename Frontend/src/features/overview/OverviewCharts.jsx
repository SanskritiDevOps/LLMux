import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartCard } from "../../components/ChartCard.jsx";
import { axisProps, tooltipProps } from "../../lib/chartTheme.js";
import {
  formatBucket,
  formatCompact,
  formatMs,
  formatNumber,
  formatPercent,
  formatUsd,
} from "../../lib/format.js";
import { ACCENT_CHART, providerStyle } from "../../lib/providers.js";

const grid = <CartesianGrid stroke="#1d293d" vertical={false} />;

export function RequestsChart({ query, interval }) {
  const points = query.data?.points ?? [];
  const data = points.map((point) => ({ ...point, label: formatBucket(point.t, interval) }));
  return (
    <ChartCard
      title="Requests over time"
      query={query}
      isEmpty={points.every((point) => point.value === 0)}
      table={{ columns: ["Time", "Requests"], rows: data.map((d) => [d.label, d.value]) }}
    >
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
          {grid}
          <XAxis dataKey="label" {...axisProps} minTickGap={32} />
          <YAxis {...axisProps} allowDecimals={false} tickFormatter={formatCompact} />
          <Tooltip {...tooltipProps} formatter={(value) => [formatNumber(value), "Requests"]} />
          <Area
            type="monotone"
            dataKey="value"
            stroke={ACCENT_CHART}
            strokeWidth={2}
            fill={ACCENT_CHART}
            fillOpacity={0.15}
            activeDot={{ r: 4, stroke: "#0f172b", strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/** One bar per model alias; every bar is the same measure, so they share one colour. */
export function CostByModelChart({ query }) {
  const groups = query.data?.groups ?? [];
  return (
    <ChartCard
      title="Cost by model"
      query={query}
      isEmpty={groups.length === 0}
      table={{
        columns: ["Model", "Cost", "Requests"],
        rows: groups.map((g) => [g.key, formatUsd(g.costUsd), g.requests]),
      }}
    >
      <ResponsiveContainer>
        <BarChart data={groups} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
          {grid}
          <XAxis dataKey="key" {...axisProps} />
          <YAxis {...axisProps} tickFormatter={formatUsd} width={72} />
          <Tooltip {...tooltipProps} formatter={(value) => [formatUsd(value), "Cost"]} />
          <Bar dataKey="costUsd" fill={ACCENT_CHART} radius={[4, 4, 0, 0]} maxBarSize={48} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/** p95 latency per provider, each bar in its provider's colour and named on the axis. */
export function LatencyByProviderChart({ query }) {
  const groups = (query.data?.groups ?? []).filter((g) => g.key && g.p95LatencyMs !== null);
  const data = groups.map((g) => ({ ...g, label: providerStyle(g.key).label }));
  return (
    <ChartCard
      title="Latency by provider (p95)"
      query={query}
      isEmpty={data.length === 0}
      emptyText="No successful requests in this range"
      table={{
        columns: ["Provider", "p95 latency", "Requests"],
        rows: data.map((d) => [d.label, formatMs(d.p95LatencyMs), d.requests]),
      }}
    >
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
          {grid}
          <XAxis dataKey="label" {...axisProps} />
          <YAxis {...axisProps} tickFormatter={formatMs} width={64} />
          <Tooltip {...tooltipProps} formatter={(value) => [formatMs(value), "p95 latency"]} />
          <Bar dataKey="p95LatencyMs" radius={[4, 4, 0, 0]} maxBarSize={48}>
            {data.map((d) => (
              <Cell key={d.key} fill={providerStyle(d.key).chart} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/** Share of requests answered from the cache, per interval. Empty intervals have no point. */
export function CacheHitChart({ requests, cached, interval }) {
  const query = requests.isError ? requests : cached;
  const total = requests.data?.points ?? [];
  const hits = new Map((cached.data?.points ?? []).map((point) => [point.t, point.value]));
  const data = total.map((point) => ({
    label: formatBucket(point.t, interval),
    rate: point.value === 0 ? null : (hits.get(point.t) ?? 0) / point.value,
  }));
  return (
    <ChartCard
      title="Cache hit rate"
      query={{ ...query, isPending: requests.isPending || cached.isPending }}
      isEmpty={data.every((d) => d.rate === null)}
      table={{
        columns: ["Time", "Cache hit rate"],
        rows: data.filter((d) => d.rate !== null).map((d) => [d.label, formatPercent(d.rate)]),
      }}
    >
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
          {grid}
          <XAxis dataKey="label" {...axisProps} minTickGap={32} />
          <YAxis {...axisProps} domain={[0, 1]} tickFormatter={formatPercent} />
          <Tooltip {...tooltipProps} formatter={(value) => [formatPercent(value), "Hit rate"]} />
          <Line
            type="monotone"
            dataKey="rate"
            stroke={ACCENT_CHART}
            strokeWidth={2}
            dot={false}
            connectNulls
            activeDot={{ r: 4, stroke: "#0f172b", strokeWidth: 2 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
