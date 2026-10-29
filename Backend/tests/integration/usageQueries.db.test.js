import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createUsageQueries, decodeCursor } from "../../src/modules/usage/usage.queries.js";
import {
  BreakdownQuery,
  LogsQuery,
  RangeQuery,
  TimeseriesQuery,
} from "../../src/modules/usage/usage.schemas.js";
import { prisma, resetDatabase } from "../helpers/db.js";
import { realDependencies } from "../setup/testDatabase.js";

// The dashboard's SQL against real Postgres (llmux_test): sums, percentiles, buckets,
// grouping, keyset pagination and, above all, that one user never sees another's rows.
// Runs in CI and with TEST_REAL_DEPS=1.
describe.runIf(realDependencies)("usage queries against real Postgres", () => {
  const queries = createUsageQueries(prisma);
  let asha;
  let ravi;
  let ashaKeys;
  let raviKey;

  const at = (iso) => new Date(iso);
  const range = (from, to) => RangeQuery.parse({ from, to });

  async function user(email) {
    return prisma.user.create({ data: { email, name: email, passwordHash: "x" } });
  }

  async function key(userId, name) {
    return prisma.apiKey.create({
      data: { userId, name, keyPrefix: `llmux_sk_${name.slice(0, 4)}`, keyHash: randomUUID() },
    });
  }

  function row(apiKeyId, createdAt, fields = {}) {
    return {
      requestId: `req_${randomUUID()}`,
      apiKeyId,
      modelAlias: "fast",
      provider: "gemini",
      providerModel: "gemini-3.5-flash-lite",
      inputTokens: 10,
      outputTokens: 20,
      costMicroUsd: 1_000n,
      latencyMs: 100,
      status: "success",
      transport: "http",
      createdAt: at(createdAt),
      ...fields,
    };
  }

  beforeEach(async () => {
    await resetDatabase();
    asha = await user("asha@example.com");
    ravi = await user("ravi@example.com");
    ashaKeys = [await key(asha.id, "trip-planner"), await key(asha.id, "chatbot")];
    raviKey = await key(ravi.id, "ravi-app");

    const [trip, bot] = ashaKeys;
    await prisma.usageLog.createMany({
      data: [
        row(trip.id, "2026-10-27T09:05:00Z", { latencyMs: 100 }),
        row(trip.id, "2026-10-27T09:40:00Z", { latencyMs: 300, cached: true, savedMicroUsd: 500n }),
        row(trip.id, "2026-10-27T11:15:00Z", {
          modelAlias: "smart",
          provider: "openai",
          providerModel: "gpt-6.1-sol",
          inputTokens: 100,
          outputTokens: 400,
          costMicroUsd: 4_200_000n,
          latencyMs: 2000,
        }),
        row(bot.id, "2026-10-27T11:30:00Z", {
          status: "error",
          errorCode: "PROVIDER_ERROR",
          inputTokens: 0,
          outputTokens: 0,
          costMicroUsd: 0n,
          latencyMs: 5,
        }),
        // Someone else's request in the same hour, and one of Asha's outside the range.
        row(raviKey.id, "2026-10-27T09:10:00Z", { costMicroUsd: 9_999_999n }),
        row(trip.id, "2026-10-20T09:00:00Z"),
      ],
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const october27 = () => range("2026-10-27T00:00:00Z", "2026-10-28T00:00:00Z");

  it("sums only the user's own requests in the range", async () => {
    const summary = await queries.summary(asha.id, october27());

    expect(summary).toEqual({
      from: "2026-10-27T00:00:00.000Z",
      to: "2026-10-28T00:00:00.000Z",
      requests: 4,
      errors: 1,
      errorRate: 0.25,
      cacheHits: 1,
      inputTokens: 120,
      outputTokens: 440,
      totalTokens: 560,
      costUsd: 4.202,
      savedUsd: 0.0005,
      // Successful requests only: 100, 300, 2000 (the 5 ms failure is left out).
      latencyMs: { p50: 300, p95: 1830 },
    });
  });

  it("gives zeros and no percentiles for a range with nothing in it", async () => {
    const summary = await queries.summary(
      asha.id,
      range("2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z"),
    );

    expect(summary).toMatchObject({
      requests: 0,
      errorRate: 0,
      costUsd: 0,
      latencyMs: { p50: null, p95: null },
    });
  });

  it("narrows to one key", async () => {
    const summary = await queries.summary(asha.id, { ...october27(), keyId: ashaKeys[1].id });

    expect(summary).toMatchObject({ requests: 1, errors: 1 });
  });

  it("buckets by hour in UTC and fills empty hours with zero", async () => {
    const series = await queries.timeseries(
      asha.id,
      TimeseriesQuery.parse({
        metric: "requests",
        interval: "hour",
        from: "2026-10-27T08:30:00Z",
        to: "2026-10-27T12:00:00Z",
      }),
    );

    expect(series.points).toEqual([
      { t: "2026-10-27T08:00:00Z", value: 0 },
      { t: "2026-10-27T09:00:00Z", value: 2 },
      { t: "2026-10-27T10:00:00Z", value: 0 },
      { t: "2026-10-27T11:00:00Z", value: 2 },
    ]);
  });

  it.each([
    ["cost", [0.002, 4.2]],
    ["tokens", [60, 500]],
    ["errors", [0, 1]],
    ["cached", [1, 0]],
    ["latency", [290, 2000]],
  ])("charts %s per interval", async (metric, [nineAm, elevenAm]) => {
    const series = await queries.timeseries(
      asha.id,
      TimeseriesQuery.parse({ metric, from: "2026-10-27T09:00:00Z", to: "2026-10-27T12:00:00Z" }),
    );

    expect(series.points.map((point) => point.value)).toEqual([
      nineAm,
      metric === "latency" ? null : 0,
      elevenAm,
    ]);
  });

  it("buckets by day", async () => {
    const series = await queries.timeseries(
      asha.id,
      TimeseriesQuery.parse({
        interval: "day",
        from: "2026-10-20T00:00:00Z",
        to: "2026-10-28T00:00:00Z",
      }),
    );

    expect(series.points).toHaveLength(8);
    expect(series.points[0]).toEqual({ t: "2026-10-20T00:00:00Z", value: 1 });
    expect(series.points[7]).toEqual({ t: "2026-10-27T00:00:00Z", value: 4 });
  });

  it("groups by model, most expensive first", async () => {
    const { groups } = await queries.breakdown(
      asha.id,
      BreakdownQuery.parse({
        by: "model",
        from: "2026-10-27T00:00:00Z",
        to: "2026-10-28T00:00:00Z",
      }),
    );

    expect(groups.map((group) => [group.key, group.requests, group.costUsd])).toEqual([
      ["smart", 1, 4.2],
      ["fast", 3, 0.002],
    ]);
    expect(groups[1]).toMatchObject({ errors: 1, totalTokens: 60, p95LatencyMs: 290 });
  });

  it("groups by key with its name and prefix", async () => {
    const { groups } = await queries.breakdown(
      asha.id,
      BreakdownQuery.parse({ by: "key", from: "2026-10-27T00:00:00Z", to: "2026-10-28T00:00:00Z" }),
    );

    expect(
      groups.map(({ key, name, prefix, requests }) => ({ key, name, prefix, requests })),
    ).toEqual([
      { key: ashaKeys[0].id, name: "trip-planner", prefix: "llmux_sk_trip", requests: 3 },
      { key: ashaKeys[1].id, name: "chatbot", prefix: "llmux_sk_chat", requests: 1 },
    ]);
  });

  it("groups by provider", async () => {
    const { groups } = await queries.breakdown(
      asha.id,
      BreakdownQuery.parse({
        by: "provider",
        from: "2026-10-27T00:00:00Z",
        to: "2026-10-28T00:00:00Z",
      }),
    );

    expect(groups.map((group) => group.key)).toEqual(["openai", "gemini"]);
  });

  it("pages through logs newest first with a cursor, without repeats or gaps", async () => {
    const first = await queries.logs(asha.id, LogsQuery.parse({ limit: "2" }));
    const second = await queries.logs(
      asha.id,
      LogsQuery.parse({ limit: "2", cursor: first.nextCursor }),
    );
    const third = await queries.logs(
      asha.id,
      LogsQuery.parse({ limit: "2", cursor: second.nextCursor }),
    );

    const times = [...first.logs, ...second.logs, ...third.logs].map((log) =>
      log.createdAt.toISOString(),
    );
    expect(times).toEqual([
      "2026-10-27T11:30:00.000Z",
      "2026-10-27T11:15:00.000Z",
      "2026-10-27T09:40:00.000Z",
      "2026-10-27T09:05:00.000Z",
      "2026-10-20T09:00:00.000Z",
    ]);
    expect(third.nextCursor).toBeNull();
    expect(first.logs[0]).toMatchObject({
      key: { id: ashaKeys[1].id, name: "chatbot", prefix: "llmux_sk_chat" },
      model: "fast",
      status: "error",
      errorCode: "PROVIDER_ERROR",
      costUsd: 0,
      metadata: null,
    });
  });

  it("breaks ties on the same timestamp by id, so no row is skipped", async () => {
    const same = "2026-10-26T12:00:00Z";
    await prisma.usageLog.createMany({
      data: [row(ashaKeys[0].id, same), row(ashaKeys[0].id, same), row(ashaKeys[0].id, same)],
    });

    const seen = [];
    let cursor;
    do {
      const page = await queries.logs(
        asha.id,
        LogsQuery.parse({ limit: "1", status: "success", ...(cursor && { cursor }) }),
      );
      seen.push(...page.logs.map((log) => log.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it("filters logs by model, provider, status and cache hits", async () => {
    const smart = await queries.logs(asha.id, LogsQuery.parse({ model: "smart" }));
    const errors = await queries.logs(asha.id, LogsQuery.parse({ status: "error" }));
    const gemini = await queries.logs(asha.id, LogsQuery.parse({ provider: "gemini" }));
    const hits = await queries.logs(asha.id, LogsQuery.parse({ cached: "true" }));

    expect(smart.logs.map((log) => log.provider)).toEqual(["openai"]);
    expect(errors.logs).toHaveLength(1);
    expect(gemini.logs).toHaveLength(4);
    expect(hits.logs.map((log) => log.createdAt.toISOString())).toEqual([
      "2026-10-27T09:40:00.000Z",
    ]);
  });

  it("never returns another user's rows, whatever the filters", async () => {
    const logs = await queries.logs(asha.id, LogsQuery.parse({ keyId: raviKey.id }));
    const theirs = await queries.logs(ravi.id, LogsQuery.parse({}));

    expect(logs.logs).toEqual([]);
    expect(theirs.logs.map((log) => log.key.name)).toEqual(["ravi-app"]);
  });

  it("rejects a cursor that wasn't made by the server", () => {
    expect(() => decodeCursor("not-a-cursor")).toThrow(
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("reports gateway-wide provider figures since a time", async () => {
    const stats = await queries.providerStats(at("2026-10-27T00:00:00Z"));

    // Ravi's gemini request counts too: provider health is the same for everyone.
    expect(stats.get("gemini")).toEqual({
      requests: 4,
      errors: 1,
      errorRate: 0.25,
      p50LatencyMs: 100,
    });
    expect(stats.get("openai")).toEqual({
      requests: 1,
      errors: 0,
      errorRate: 0,
      p50LatencyMs: 2000,
    });
    expect(stats.has("anthropic")).toBe(false);
  });
});
