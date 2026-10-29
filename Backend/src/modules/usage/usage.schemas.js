import { z } from "zod";

/**
 * Query strings for /api/usage. Every value arrives as a string; these schemas turn them
 * into typed values with defaults, and reject anything unknown.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RANGE_DAYS = 7;
export const MAX_RANGE_DAYS = 90;
export const LOGS_DEFAULT_LIMIT = 50;
export const LOGS_MAX_LIMIT = 200;

export const METRICS = ["requests", "errors", "cached", "tokens", "cost", "latency"];
export const INTERVALS = { hour: 60 * 60 * 1000, day: DAY_MS };
export const MAX_BUCKETS = 1000;
export const BREAKDOWN_BY = ["model", "provider", "key"];
export const STATUSES = ["success", "error", "cancelled"];

const isoDate = z.iso.datetime({ offset: true, error: "must be an ISO 8601 date and time" });
const keyId = z.uuid({ error: "must be a key ID" });

const rangeFields = {
  from: isoDate.optional(),
  to: isoDate.optional(),
  keyId: keyId.optional(),
};

/** from/to default to the last 7 days; `to` defaults to now. */
function withRange(fields) {
  const { from, to, ...rest } = fields;
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  return { ...rest, from: start, to: end };
}

const rangeIsValid = [
  ({ from, to }) => from < to && to - from <= MAX_RANGE_DAYS * DAY_MS,
  { error: `from must be before to, at most ${MAX_RANGE_DAYS} days apart` },
];

export const RangeQuery = z
  .strictObject(rangeFields)
  .transform(withRange)
  .refine(...rangeIsValid);

export const TimeseriesQuery = z
  .strictObject({
    ...rangeFields,
    metric: z.enum(METRICS).default("requests"),
    interval: z.enum(Object.keys(INTERVALS)).default("hour"),
  })
  .transform(withRange)
  .refine(...rangeIsValid)
  .refine(({ from, to, interval }) => (to - from) / INTERVALS[interval] <= MAX_BUCKETS, {
    error: `the range has more than ${MAX_BUCKETS} intervals; use interval=day`,
  });

export const BreakdownQuery = z
  .strictObject({ ...rangeFields, by: z.enum(BREAKDOWN_BY).default("model") })
  .transform(withRange)
  .refine(...rangeIsValid);

export const LogsQuery = z.strictObject({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(LOGS_MAX_LIMIT).default(LOGS_DEFAULT_LIMIT),
  model: z.string().trim().min(1).max(200).optional(),
  provider: z.string().trim().min(1).max(50).optional(),
  status: z.enum(STATUSES).optional(),
  cached: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  keyId: keyId.optional(),
});
