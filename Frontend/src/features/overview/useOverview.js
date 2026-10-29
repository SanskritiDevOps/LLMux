import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client.js";

export const RANGES = {
  "24h": { label: "Last 24 hours", hours: 24, interval: "hour" },
  "7d": { label: "Last 7 days", hours: 7 * 24, interval: "hour" },
  "30d": { label: "Last 30 days", hours: 30 * 24, interval: "day" },
};

// Overview data refreshes every 30 seconds (docs/Design.md section 8).
const REFRESH_MS = 30_000;

/** from/to for a range, worked out on every fetch so a refresh moves the window forward. */
function window(range) {
  const to = new Date();
  const from = new Date(to.getTime() - RANGES[range].hours * 3_600_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function useUsage(name, range, query = {}) {
  return useQuery({
    queryKey: ["usage", name, range, query],
    queryFn: ({ signal }) =>
      api(`/api/usage/${name}`, { query: { ...window(range), ...query }, signal }),
    refetchInterval: REFRESH_MS,
  });
}

export function useOverview(range) {
  const { interval } = RANGES[range];
  return {
    summary: useUsage("summary", range),
    requests: useUsage("timeseries", range, { metric: "requests", interval }),
    cached: useUsage("timeseries", range, { metric: "cached", interval }),
    byModel: useUsage("breakdown", range, { by: "model" }),
    byProvider: useUsage("breakdown", range, { by: "provider" }),
  };
}
