/** Display formatting for numbers, money, rates and times. Display only: never sum these. */

const integer = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export const formatNumber = (value) => integer.format(value ?? 0);
export const formatCompact = (value) => compact.format(value ?? 0);

/** $1,234.56 for normal amounts; three significant digits for fractions of a cent. */
export function formatUsd(value) {
  const amount = value ?? 0;
  if (amount === 0) return "$0.00";
  if (Math.abs(amount) < 0.01) {
    return `$${amount.toLocaleString("en-US", { maximumSignificantDigits: 3 })}`;
  }
  return amount.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export const formatPercent = (fraction) =>
  `${((fraction ?? 0) * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;

export const formatMs = (ms) =>
  ms === null || ms === undefined
    ? "—"
    : ms >= 1000
      ? `${(ms / 1000).toLocaleString("en-US", { maximumFractionDigits: 2 })} s`
      : `${Math.round(ms)} ms`;

export const formatDateTime = (value) =>
  new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/** "3 min ago", "2 days ago", or "Never". */
export function formatRelative(value) {
  if (!value) return "Never";
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  const units = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  const rtf = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(-Math.round(seconds / size), unit);
  }
  return "just now";
}

/**
 * A chart bucket's label. Hourly buckets show local time; daily buckets are UTC days, so
 * they are labelled in UTC (otherwise a day could show as the previous date).
 */
export function formatBucket(iso, interval) {
  const date = new Date(iso);
  return interval === "day"
    ? date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    : date.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}
