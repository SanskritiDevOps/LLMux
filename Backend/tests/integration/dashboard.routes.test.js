import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { listModels } from "../../src/gateway/catalog.js";
import { createGateway } from "../../src/gateway/gateway.service.js";
import { StreamEventSchema } from "../../src/gateway/schemas.js";
import { keyBucket } from "../../src/middleware/rateLimit.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { fakeKeys } from "../helpers/fakeKeys.js";
import { fakeLimiter } from "../helpers/fakeLimiter.js";
import { fakeRedis } from "../helpers/fakeRedis.js";
import { fakeUsage } from "../helpers/fakeUsage.js";
import { fakeUsers } from "../helpers/fakeUsers.js";
import { startMockProvider } from "../mockProvider.js";

// The dashboard API routes (/api/usage, /api/providers, /api/playground) with in-memory
// users and keys. The SQL behind /api/usage runs against real Postgres in
// usageQueries.db.test.js; here the queries are a fake that records what it was asked.
let mock;
let app;
let keys;
let usage;
let limiter;
let calls;

function fakeUsageQueries() {
  const answer = (name) => async (userId, query) => {
    calls.push({ name, userId, query });
    return { query: name };
  };
  return {
    summary: answer("summary"),
    timeseries: answer("timeseries"),
    breakdown: answer("breakdown"),
    logs: answer("logs"),
    async providerStats(since) {
      calls.push({ name: "providerStats", since });
      return new Map([["gemini", { requests: 8, errors: 2, errorRate: 0.25, p50LatencyMs: 420 }]]);
    },
  };
}

const breaker = {
  async state(provider) {
    return provider === "openai"
      ? { state: "open", recentFailures: 5 }
      : { state: "closed", recentFailures: 0 };
  },
};

beforeAll(async () => {
  mock = await startMockProvider();
});

afterAll(async () => {
  await mock.close();
});

beforeEach(() => {
  mock.reset();
  calls = [];
  keys = fakeKeys();
  usage = fakeUsage();
  limiter = fakeLimiter();
  const gateway = createGateway({
    enabledProviders: new Set(["gemini"]),
    providerSettings: { gemini: { apiKey: "mock-gemini-key", baseUrl: mock.url } },
    timeoutMs: 5000,
    maxRetries: 0,
  });
  app = createApp({
    logger: captureLogs().logger,
    users: fakeUsers(),
    keys,
    redis: fakeRedis(),
    gateway,
    usage,
    limiter,
    usageQueries: fakeUsageQueries(),
    breaker,
    enabledProviders: new Set(["gemini", "ollama"]),
  });
});

/** A logged-in browser with one gateway key of its own. */
async function loggedIn(email = "asha@example.com") {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/register")
    .send({ email, password: "correct horse", name: "Asha" });
  const { body } = await agent.post("/api/keys").send({ name: "trip-planner" });
  return { agent, user: res.body.user, key: body.key };
}

describe("GET /api/usage/*", () => {
  it.each(["summary", "timeseries", "breakdown", "logs"])("/%s needs a session", async (name) => {
    const res = await request(app).get(`/api/usage/${name}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("asks for the logged-in user's summary, defaulting to the last 7 days", async () => {
    const { agent, user } = await loggedIn();

    const res = await agent.get("/api/usage/summary");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ query: "summary" });
    const { userId, query } = calls[0];
    expect(userId).toBe(user.id);
    expect(query.to - query.from).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("passes a timeseries metric, interval and range through", async () => {
    const { agent } = await loggedIn();

    await agent.get("/api/usage/timeseries").query({
      metric: "cost",
      interval: "day",
      from: "2026-10-01T00:00:00Z",
      to: "2026-10-28T00:00:00Z",
    });

    expect(calls[0].query).toEqual({
      metric: "cost",
      interval: "day",
      from: new Date("2026-10-01T00:00:00Z"),
      to: new Date("2026-10-28T00:00:00Z"),
    });
  });

  it("defaults the breakdown to by=model and logs to 50 per page", async () => {
    const { agent } = await loggedIn();

    await agent.get("/api/usage/breakdown");
    await agent.get("/api/usage/logs");

    expect(calls[0].query.by).toBe("model");
    expect(calls[1].query).toEqual({ limit: 50 });
  });

  it("passes the logs filters through", async () => {
    const { agent, key } = await loggedIn();

    await agent.get("/api/usage/logs").query({
      limit: "20",
      model: "fast",
      provider: "gemini",
      status: "error",
      cached: "false",
      keyId: key.id,
    });

    expect(calls[0].query).toEqual({
      limit: 20,
      model: "fast",
      provider: "gemini",
      status: "error",
      cached: false,
      keyId: key.id,
    });
  });

  it.each([
    ["an unknown metric", "/api/usage/timeseries?metric=vibes", "metric"],
    ["an unknown grouping", "/api/usage/breakdown?by=colour", "by"],
    ["a limit above 200", "/api/usage/logs?limit=500", "limit"],
    ["a non-date from", "/api/usage/summary?from=yesterday", "from"],
    ["from after to", "/api/usage/summary?from=2026-10-20T00:00:00Z&to=2026-10-01T00:00:00Z", ""],
    [
      "a range over 90 days",
      "/api/usage/summary?from=2026-01-01T00:00:00Z&to=2026-10-01T00:00:00Z",
      "",
    ],
    [
      "hourly points for 90 days",
      "/api/usage/timeseries?interval=hour&from=2026-07-01T00:00:00Z&to=2026-09-28T00:00:00Z",
      "",
    ],
    ["an unknown field", "/api/usage/summary?colour=blue", ""],
    ["a bad status", "/api/usage/logs?status=maybe", "status"],
  ])("rejects %s with 400", async (_label, url, field) => {
    const { agent } = await loggedIn();

    const res = await agent.get(url);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_REQUEST");
    expect(res.body.error.message).toContain(field);
    expect(calls).toEqual([]);
  });

  it("answers 404 for a keyId that belongs to someone else, as for one that doesn't exist", async () => {
    const { key: theirs } = await loggedIn("ravi@example.com");
    const { agent } = await loggedIn("asha@example.com");

    const someoneElses = await agent.get("/api/usage/summary").query({ keyId: theirs.id });
    const missing = await agent
      .get("/api/usage/logs")
      .query({ keyId: "00000000-0000-4000-8000-000000000000" });

    expect(someoneElses.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(someoneElses.body.error).toEqual({
      ...missing.body.error,
      requestId: someoneElses.body.error.requestId,
    });
    expect(calls).toEqual([]);
  });
});

describe("GET /api/providers/health", () => {
  it("needs a session", async () => {
    expect((await request(app).get("/api/providers/health")).status).toBe(401);
  });

  it("lists every provider with its key status, circuit and last 15 minutes", async () => {
    const { agent } = await loggedIn();

    const res = await agent.get("/api/providers/health");

    expect(res.status).toBe(200);
    expect(res.body.windowMinutes).toBe(15);
    expect(res.body.providers.map((p) => p.provider)).toEqual([
      "gemini",
      "ollama",
      "openai",
      "anthropic",
    ]);
    expect(res.body.providers[0]).toEqual({
      provider: "gemini",
      configured: true,
      models: ["gemini-3.5-flash-lite", "gemini-2.5-pro"],
      circuit: { state: "closed", recentFailures: 0 },
      recent: { requests: 8, errors: 2, errorRate: 0.25, p50LatencyMs: 420 },
    });
    expect(res.body.providers[2]).toEqual({
      provider: "openai",
      configured: false,
      models: ["gpt-6.1-sol"],
      circuit: { state: "open", recentFailures: 5 },
      recent: { requests: 0, errors: 0, errorRate: 0, p50LatencyMs: null },
    });
    const { since } = calls.find((call) => call.name === "providerStats");
    expect(Date.now() - since.getTime()).toBeGreaterThanOrEqual(15 * 60_000);
  });
});

/** Parses an SSE body into [{ type, ...data }]. */
function parseSse(text) {
  return text
    .split("\n\n")
    .filter((block) => block !== "" && !block.startsWith(":"))
    .map((block) => {
      const [eventLine, dataLine] = block.split("\n");
      return { type: eventLine.slice("event: ".length), ...JSON.parse(dataLine.slice(6)) };
    });
}

describe("GET /api/playground/models", () => {
  it("needs a session", async () => {
    expect((await request(app).get("/api/playground/models")).status).toBe(401);
  });

  it("lists the same models as GET /v1/models", async () => {
    const { agent } = await loggedIn();

    const res = await agent.get("/api/playground/models");

    // Which models are listed depends on the providers this machine has set up (CI has
    // none), so the check is that it's exactly what GET /v1/models would answer.
    expect(res.status).toBe(200);
    expect(res.body).toEqual(listModels());
    expect(Array.isArray(res.body.models)).toBe(true);
  });
});

describe("POST /api/playground/chat", () => {
  const chat = (keyId, fields) => ({
    keyId,
    model: "fast",
    messages: [{ role: "user", content: "Plan one day in Jaipur." }],
    ...fields,
  });

  it("needs a session", async () => {
    const res = await request(app).post("/api/playground/chat").send(chat(crypto.randomUUID()));

    expect(res.status).toBe(401);
  });

  it("blocks another site's origin", async () => {
    const { agent, key } = await loggedIn();

    const res = await agent
      .post("/api/playground/chat")
      .set("Origin", "https://evil.example")
      .send(chat(key.id));

    expect(res.status).toBe(403);
  });

  it("streams the answer as SSE, with the cost in the end event", async () => {
    mock.behave("gemini", { type: "stream", chunks: ["Morning: ", "Amber Fort."] });
    const { agent, key } = await loggedIn();

    const res = await agent.post("/api/playground/chat").send(chat(key.id));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    const events = parseSse(res.text);
    expect(events.map((event) => event.type)).toEqual(["start", "delta", "delta", "end"]);
    expect(events[0]).toMatchObject({ model: "fast", provider: "gemini" });
    const end = events.at(-1);
    expect(end).toMatchObject({
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    });
    // 10 input tokens at $0.30/M and 20 output tokens at $2.50/M.
    expect(end.costUsd).toBeCloseTo(0.000053, 9);
    // Apart from costUsd, the same events as /v1/chat.
    const withoutCost = { ...end };
    delete withoutCost.costUsd;
    expect(StreamEventSchema.safeParse(withoutCost).success).toBe(true);
  });

  it("writes a usage row under the chosen key, tagged as the playground", async () => {
    mock.behave("gemini", { type: "stream", chunks: ["Hi"] });
    const { agent, key } = await loggedIn();

    const res = await agent
      .post("/api/playground/chat")
      .send(chat(key.id, { metadata: { experiment: "a" } }));

    const row = await usage.rowFor(res.headers["x-request-id"]);
    expect(row).toMatchObject({
      apiKeyId: key.id,
      modelAlias: "fast",
      status: "success",
      transport: "sse",
      streamed: true,
      metadata: { experiment: "a", source: "playground" },
    });
    expect(row.costMicroUsd).toBe(53);
  });

  it("takes a token from the key's own rate limit, shared with /v1", async () => {
    mock.behave("gemini", { type: "stream", chunks: ["Hi"] });
    const { agent, key } = await loggedIn();
    keys.rows[0].rateLimitPerMin = 1;

    const first = await agent.post("/api/playground/chat").send(chat(key.id));
    const second = await agent.post("/api/playground/chat").send(chat(key.id));

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe("RATE_LIMITED");
    expect(limiter.calls[0]).toEqual({ key: keyBucket(key.id), limit: 1 });
  });

  it("answers 404 for someone else's key, without calling the provider", async () => {
    const { key: theirs } = await loggedIn("ravi@example.com");
    const { agent } = await loggedIn("asha@example.com");

    const res = await agent.post("/api/playground/chat").send(chat(theirs.id));

    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: "NOT_FOUND", message: "Key not found" });
    expect(mock.requests).toEqual([]);
    expect(usage.rows).toEqual([]);
  });

  it("refuses a revoked key", async () => {
    const { agent, key } = await loggedIn();
    await agent.delete(`/api/keys/${key.id}`);

    const res = await agent.post("/api/playground/chat").send(chat(key.id));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("KEY_REVOKED");
  });

  it.each([
    ["no keyId", { keyId: undefined }],
    ["a stream field (the playground always streams)", { stream: false }],
    ["no messages", { messages: [] }],
  ])("rejects a body with %s", async (_label, fields) => {
    const { agent, key } = await loggedIn();

    const res = await agent.post("/api/playground/chat").send(chat(key.id, fields));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_REQUEST");
  });

  it("answers a provider failure before streaming as a JSON error, and logs it", async () => {
    mock.behave("gemini", { type: "status", status: 500, body: { error: { code: 500 } } });
    const { agent, key } = await loggedIn();

    const res = await agent
      .post("/api/playground/chat")
      .send(chat(key.id, { model: "gemini:gemini-3.5-flash-lite" }));

    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.error.provider).toBe("gemini");
    const row = await usage.rowFor(res.headers["x-request-id"]);
    expect(row).toMatchObject({ status: "error", apiKeyId: key.id });
  });
});
