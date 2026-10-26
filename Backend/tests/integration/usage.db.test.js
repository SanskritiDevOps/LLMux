import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createUsageRepository } from "../../src/modules/usage/usage.repository.js";
import { createUsageWriter } from "../../src/modules/usage/usageWriter.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { prisma, resetDatabase } from "../helpers/db.js";
import { realDependencies } from "../setup/testDatabase.js";

// The usage writer and repository against real Postgres (llmux_test). Runs in CI and with
// TEST_REAL_DEPS=1.
describe.runIf(realDependencies)("usage logs against real Postgres", () => {
  let apiKeyId;

  beforeEach(async () => {
    await resetDatabase();
    const user = await prisma.user.create({
      data: { email: "asha@example.com", name: "Asha", passwordHash: "x" },
    });
    const key = await prisma.apiKey.create({
      data: { userId: user.id, name: "trip-planner", keyPrefix: "llmux_sk_abcd", keyHash: "h" },
    });
    apiKeyId = key.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const row = (requestId, fields) => ({
    requestId,
    apiKeyId,
    modelAlias: "fast",
    provider: "gemini",
    providerModel: "gemini-3.5-flash-lite",
    inputTokens: 42,
    outputTokens: 310,
    costMicroUsd: 788,
    latencyMs: 1830,
    status: "success",
    transport: "http",
    ...fields,
  });

  it("inserts a batch and skips rows whose request_id is already stored", async () => {
    const repository = createUsageRepository(prisma);

    expect(await repository.insertMany([row("req_1"), row("req_2")])).toBe(2);
    expect(await repository.insertMany([row("req_2"), row("req_3")])).toBe(1);

    expect(await prisma.usageLog.count()).toBe(3);
  });

  it("stores every column, with cost as an exact integer", async () => {
    await createUsageRepository(prisma).insertMany([
      row("req_1", {
        usageEstimated: true,
        timeToFirstTokenMs: 210,
        streamed: true,
        transport: "sse",
        metadata: { app: "trip-planner" },
        costMicroUsd: 9_007_199_254,
      }),
    ]);

    const stored = await prisma.usageLog.findUnique({ where: { requestId: "req_1" } });
    expect(stored).toMatchObject({
      apiKeyId,
      modelAlias: "fast",
      inputTokens: 42,
      outputTokens: 310,
      usageEstimated: true,
      costMicroUsd: 9_007_199_254n,
      savedMicroUsd: 0n,
      timeToFirstTokenMs: 210,
      streamed: true,
      transport: "sse",
      cached: false,
      fallbackUsed: false,
      attempts: 1,
      metadata: { app: "trip-planner" },
    });
  });

  it("writes rows recorded through the writer in batches", async () => {
    const writer = createUsageWriter({
      repository: createUsageRepository(prisma),
      logger: captureLogs().logger,
      batchSize: 2,
      flushIntervalMs: 60_000,
    });
    for (const n of [1, 2, 3, 4, 5]) writer.record(row(`req_${n}`));

    await writer.close();

    expect(await prisma.usageLog.count()).toBe(5);
    expect(writer.stats()).toMatchObject({ buffered: 0, written: 5 });
  });

  it("drops only the row Postgres refuses, and writes the rest of its batch", async () => {
    const logs = captureLogs();
    const writer = createUsageWriter({
      repository: createUsageRepository(prisma),
      logger: logs.logger,
      flushIntervalMs: 60_000,
    });
    writer.record(row("req_1"));
    // A key that no longer exists (its user was deleted) breaks the foreign key.
    writer.record(row("req_2", { apiKeyId: "00000000-0000-0000-0000-000000000000" }));
    writer.record(row("req_3"));

    await writer.close();

    const stored = await prisma.usageLog.findMany({ orderBy: { requestId: "asc" } });
    expect(stored.map((log) => log.requestId)).toEqual(["req_1", "req_3"]);
    expect(writer.stats()).toMatchObject({ buffered: 0, written: 2, dropped: 1 });
    expect(logs.lines.find((line) => line.msg.includes("refused by the database"))).toMatchObject({
      requestId: "req_2",
    });
  });
});
