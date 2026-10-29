import { Prisma } from "@prisma/client";
import { prisma as defaultPrisma } from "../../config/db.js";
import { microUsdToUsd } from "../../gateway/cost.js";
import { GatewayError } from "../../utils/errors.js";
import { INTERVALS } from "./usage.schemas.js";

/**
 * Reads usage_logs for the dashboard. Every per-user query joins api_keys and filters on
 * the owner, so a user only ever sees requests made with their own keys.
 *
 * Times: created_at is a UTC timestamp without a time zone. Dates are passed in as ISO
 * strings cast to timestamp (which keeps the UTC wall time), and bucket times come back as
 * ISO text, so neither the database's nor Node's local time zone can shift them.
 *
 * Money is summed as integer micro-dollars in SQL and only turned into USD at the end.
 * Latency percentiles cover successful requests only: a fast failure isn't a fast answer.
 *
 * @param {import("@prisma/client").PrismaClient} [prisma]
 */
export function createUsageQueries(prisma = defaultPrisma) {
  return {
    /** Totals for a range. */
    async summary(userId, range) {
      const [row] = await prisma.$queryRaw`
        SELECT count(*)::int AS requests,
               count(*) FILTER (WHERE u.status = 'error')::int AS errors,
               count(*) FILTER (WHERE u.cached)::int AS cache_hits,
               coalesce(sum(u.input_tokens), 0)::bigint AS input_tokens,
               coalesce(sum(u.output_tokens), 0)::bigint AS output_tokens,
               coalesce(sum(u.cost_micro_usd), 0)::bigint AS cost,
               coalesce(sum(u.saved_micro_usd), 0)::bigint AS saved,
               ${percentile(0.5)} AS p50,
               ${percentile(0.95)} AS p95
        FROM usage_logs u JOIN api_keys k ON k.id = u.api_key_id
        WHERE ${scope(userId, range)}`;

      const inputTokens = Number(row.input_tokens);
      const outputTokens = Number(row.output_tokens);
      return {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        requests: row.requests,
        errors: row.errors,
        errorRate: rate(row.errors, row.requests),
        cacheHits: row.cache_hits,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        costUsd: microUsdToUsd(Number(row.cost)),
        savedUsd: microUsdToUsd(Number(row.saved)),
        latencyMs: { p50: roundOrNull(row.p50), p95: roundOrNull(row.p95) },
      };
    },

    /** One value per hour or day, with empty intervals filled in so charts have no gaps. */
    async timeseries(userId, { metric, interval, ...range }) {
      const rows = await prisma.$queryRaw`
        SELECT to_char(date_trunc(${interval}::text, u.created_at), ${ISO_FORMAT}) AS bucket,
               ${METRIC_SQL[metric]} AS value
        FROM usage_logs u JOIN api_keys k ON k.id = u.api_key_id
        WHERE ${scope(userId, range)}
        GROUP BY 1`;

      const found = new Map(rows.map((row) => [row.bucket, row.value]));
      const step = INTERVALS[interval];
      const points = [];
      // Hours and days both start at a multiple of their length since the epoch (UTC).
      for (let t = Math.floor(range.from / step) * step; t < range.to; t += step) {
        const bucket = new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
        points.push({ t: bucket, value: metricValue(metric, found.get(bucket)) });
      }
      return {
        metric,
        interval,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        points,
      };
    },

    /** Totals grouped by model alias, provider or key, most expensive first. */
    async breakdown(userId, { by, ...range }) {
      const group = GROUP_SQL[by];
      const rows = await prisma.$queryRaw`
        SELECT ${group.select},
               count(*)::int AS requests,
               count(*) FILTER (WHERE u.status = 'error')::int AS errors,
               coalesce(sum(u.input_tokens), 0)::bigint AS input_tokens,
               coalesce(sum(u.output_tokens), 0)::bigint AS output_tokens,
               coalesce(sum(u.cost_micro_usd), 0)::bigint AS cost,
               ${percentile(0.95)} AS p95
        FROM usage_logs u JOIN api_keys k ON k.id = u.api_key_id
        WHERE ${scope(userId, range)}
        GROUP BY ${group.groupBy}
        ORDER BY cost DESC, requests DESC`;

      return {
        by,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        groups: rows.map((row) => {
          const inputTokens = Number(row.input_tokens);
          const outputTokens = Number(row.output_tokens);
          return {
            key: row.group_key,
            ...(by === "key" && { name: row.key_name, prefix: row.key_prefix }),
            requests: row.requests,
            errors: row.errors,
            errorRate: rate(row.errors, row.requests),
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            costUsd: microUsdToUsd(Number(row.cost)),
            p95LatencyMs: roundOrNull(row.p95),
          };
        }),
      };
    },

    /**
     * Newest first, `limit` at a time. The cursor is the position of the last row returned
     * (its created_at and id), so new rows arriving between pages never shift or repeat a
     * page, and every page costs the same however deep it is.
     */
    async logs(userId, { cursor, limit, model, provider, status, cached, keyId }) {
      const after = cursor === undefined ? undefined : decodeCursor(cursor);
      const rows = await prisma.usageLog.findMany({
        where: {
          apiKey: { userId },
          ...(keyId && { apiKeyId: keyId }),
          ...(model && { modelAlias: model }),
          ...(provider && { provider }),
          ...(status && { status }),
          ...(cached !== undefined && { cached }),
          ...(after && {
            OR: [
              { createdAt: { lt: after.createdAt } },
              { createdAt: after.createdAt, id: { lt: after.id } },
            ],
          }),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        // One extra row says whether there is another page.
        take: limit + 1,
        include: { apiKey: { select: { name: true, keyPrefix: true } } },
      });

      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        logs: page.map(toPublicLog),
        nextCursor: rows.length > limit ? encodeCursor(last) : null,
      };
    },

    /**
     * Gateway-wide figures per provider since `since`, for provider health. Not per user:
     * a provider's health is the same for everyone using this gateway.
     */
    async providerStats(since) {
      const rows = await prisma.$queryRaw`
        SELECT u.provider,
               count(*)::int AS requests,
               count(*) FILTER (WHERE u.status = 'error')::int AS errors,
               ${percentile(0.5)} AS p50
        FROM usage_logs u
        WHERE u.provider IS NOT NULL AND u.created_at >= ${utc(since)}::timestamp
        GROUP BY u.provider`;

      return new Map(
        rows.map((row) => [
          row.provider,
          {
            requests: row.requests,
            errors: row.errors,
            errorRate: rate(row.errors, row.requests),
            p50LatencyMs: roundOrNull(row.p50),
          },
        ]),
      );
    },
  };
}

const ISO_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS"Z"';

const utc = (date) => date.toISOString();

function scope(userId, { from, to, keyId }) {
  return Prisma.sql`k.user_id = ${userId}::uuid
    AND u.created_at >= ${utc(from)}::timestamp
    AND u.created_at < ${utc(to)}::timestamp
    ${keyId ? Prisma.sql`AND u.api_key_id = ${keyId}::uuid` : Prisma.empty}`;
}

// The fraction is a constant from this file, never user input.
function percentile(fraction) {
  return Prisma.sql`percentile_cont(${Prisma.raw(String(fraction))})
    WITHIN GROUP (ORDER BY u.latency_ms) FILTER (WHERE u.status = 'success')`;
}

// Fixed SQL per metric name; the name is checked against METRICS before it gets here.
const METRIC_SQL = {
  requests: Prisma.sql`count(*)::int`,
  errors: Prisma.sql`count(*) FILTER (WHERE u.status = 'error')::int`,
  cached: Prisma.sql`count(*) FILTER (WHERE u.cached)::int`,
  tokens: Prisma.sql`coalesce(sum(u.input_tokens + u.output_tokens), 0)::bigint`,
  cost: Prisma.sql`coalesce(sum(u.cost_micro_usd), 0)::bigint`,
  latency: percentile(0.95),
};

function metricValue(metric, value) {
  if (metric === "latency") return roundOrNull(value);
  if (value === undefined) return 0;
  return metric === "cost" ? microUsdToUsd(Number(value)) : Number(value);
}

const GROUP_SQL = {
  model: { select: Prisma.sql`u.model_alias AS group_key`, groupBy: Prisma.sql`u.model_alias` },
  provider: { select: Prisma.sql`u.provider AS group_key`, groupBy: Prisma.sql`u.provider` },
  key: {
    select: Prisma.sql`u.api_key_id::text AS group_key, k.name AS key_name,
      k.key_prefix AS key_prefix`,
    groupBy: Prisma.sql`u.api_key_id, k.name, k.key_prefix`,
  },
};

const rate = (part, whole) => (whole === 0 ? 0 : part / whole);
const roundOrNull = (value) => (value === null || value === undefined ? null : Math.round(value));

/** One request as the dashboard sees it. metadata is the client's own tags. */
function toPublicLog(row) {
  return {
    id: row.id,
    requestId: row.requestId,
    createdAt: row.createdAt,
    key: { id: row.apiKeyId, name: row.apiKey.name, prefix: row.apiKey.keyPrefix },
    model: row.modelAlias,
    provider: row.provider,
    providerModel: row.providerModel,
    status: row.status,
    errorCode: row.errorCode,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    usageEstimated: row.usageEstimated,
    costUsd: microUsdToUsd(Number(row.costMicroUsd)),
    savedUsd: microUsdToUsd(Number(row.savedMicroUsd)),
    latencyMs: row.latencyMs,
    timeToFirstTokenMs: row.timeToFirstTokenMs,
    cached: row.cached,
    fallbackUsed: row.fallbackUsed,
    attempts: row.attempts,
    transport: row.transport,
    metadata: row.metadata ?? null,
  };
}

/** The cursor is opaque to clients: base64url of the last row's time and id. */
export function encodeCursor(row) {
  return Buffer.from(JSON.stringify([row.createdAt.toISOString(), row.id])).toString("base64url");
}

export function decodeCursor(cursor) {
  try {
    const [time, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const createdAt = new Date(time);
    if (
      typeof id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(id) ||
      Number.isNaN(createdAt.getTime())
    ) {
      throw new Error("bad cursor");
    }
    return { createdAt, id };
  } catch {
    throw new GatewayError("INVALID_REQUEST", "Invalid request: cursor: is not a valid cursor");
  }
}
