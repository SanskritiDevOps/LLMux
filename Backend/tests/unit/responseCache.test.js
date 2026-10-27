import { describe, expect, it, vi } from "vitest";
import { cacheKey } from "../../src/gateway/cacheKey.js";
import { createResponseCache, withResponseCache } from "../../src/gateway/responseCache.js";
import { ChatRequestSchema } from "../../src/gateway/schemas.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { fakeRedis } from "../helpers/fakeRedis.js";

// The cache wrapper around a fake gateway, with an in-memory Redis: what is stored, what
// a hit returns, and what it reports for the usage log.
const answer = (fields) => ({
  response: {
    id: "req_first",
    model: "fast",
    provider: "gemini",
    providerModel: "gemini-3.5-flash-lite",
    content: "Morning: Amber Fort.",
    finishReason: "stop",
    usage: { inputTokens: 42, outputTokens: 310, totalTokens: 352 },
    costUsd: 0.000788,
    latencyMs: 900,
    cached: false,
    fallbackUsed: false,
    ...fields,
  },
  meta: { alias: "fast", attempts: 1, usageEstimated: false, costMicroUsd: 788, savedMicroUsd: 0 },
});

function setup({ reply = answer(), redis = fakeRedis(), onlyDeterministic = true } = {}) {
  const gateway = { chat: vi.fn(async () => reply), stream: vi.fn() };
  const logs = captureLogs();
  const cache = createResponseCache({ redis, ttlSeconds: 3600, logger: logs.logger });
  const cached = withResponseCache(gateway, { cache, onlyDeterministic });
  const summaries = [];
  const chat = (body, { scope = "user-1", requestId = "req_next" } = {}) =>
    cached.chat(
      ChatRequestSchema.parse({
        model: "fast",
        temperature: 0,
        messages: [{ role: "user", content: "Plan one day in Jaipur." }],
        ...body,
      }),
      {
        requestId,
        log: logs.logger,
        cacheScope: scope,
        onFinish: (summary) => summaries.push(summary),
      },
    );
  return { chat, gateway, redis, summaries, logs, cached };
}

/** Lets the cache write (which isn't awaited) finish. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("withResponseCache", () => {
  it("calls the provider on a miss and stores the answer for an hour", async () => {
    const { chat, gateway, redis } = setup();

    const { response } = await chat({});
    await settle();

    expect(gateway.chat).toHaveBeenCalledTimes(1);
    expect(response.cached).toBe(false);
    const [key] = [...redis.store.keys()];
    expect(key).toMatch(/^cache:v1:[0-9a-f]{64}$/);
    expect(redis.store.get(key).ttlSeconds).toBe(3600);
    expect(JSON.parse(redis.store.get(key).value)).toEqual({
      alias: "fast",
      provider: "gemini",
      providerModel: "gemini-3.5-flash-lite",
      content: "Morning: Amber Fort.",
      finishReason: "stop",
      usage: { inputTokens: 42, outputTokens: 310, totalTokens: 352 },
      usageEstimated: false,
      costMicroUsd: 788,
    });
  });

  it("answers the same request from the cache: free, flagged, with a new request ID", async () => {
    const { chat, gateway } = setup();
    await chat({}, { requestId: "req_first" });
    await settle();

    const { response, meta } = await chat({}, { requestId: "req_second" });

    expect(gateway.chat).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      id: "req_second",
      model: "fast",
      provider: "gemini",
      providerModel: "gemini-3.5-flash-lite",
      content: "Morning: Amber Fort.",
      finishReason: "stop",
      usage: { inputTokens: 42, outputTokens: 310, totalTokens: 352 },
      costUsd: 0,
      cached: true,
      fallbackUsed: false,
    });
    expect(response.latencyMs).toBeLessThan(100);
    expect(meta).toMatchObject({ attempts: 0, costMicroUsd: 0, savedMicroUsd: 788 });
  });

  it("reports a hit to the usage log as free, with the original cost as saved", async () => {
    const { chat, summaries } = setup();
    await chat({});
    await settle();

    await chat({});

    expect(summaries).toEqual([
      {
        alias: "fast",
        target: { provider: "gemini", model: "gemini-3.5-flash-lite" },
        usage: { inputTokens: 42, outputTokens: 310, totalTokens: 352 },
        usageEstimated: false,
        costMicroUsd: 0,
        savedMicroUsd: 788,
        attempts: 0,
        fallbackUsed: false,
        cached: true,
        providerLatencyMs: null,
        timeToFirstTokenMs: null,
      },
    ]);
  });

  it("logs each hit with the money it saved", async () => {
    const { chat, logs } = setup();
    await chat({});
    await settle();

    await chat({});

    expect(logs.lines.find((line) => line.msg === "Answered from cache")).toMatchObject({
      provider: "gemini",
      savedMicroUsd: 788,
    });
  });

  it.each([
    ["temperature above 0", { temperature: 0.7 }],
    ["cache: false", { cache: false }],
  ])("never caches a request with %s", async (_label, body) => {
    const { chat, gateway, redis } = setup();

    await chat(body);
    await settle();
    await chat(body);

    expect(gateway.chat).toHaveBeenCalledTimes(2);
    expect(redis.store.size).toBe(0);
  });

  it("caches any temperature when CACHE_ONLY_DETERMINISTIC is false", async () => {
    const { chat, gateway } = setup({ onlyDeterministic: false });

    await chat({ temperature: 0.7 });
    await settle();
    await chat({ temperature: 0.7 });

    expect(gateway.chat).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["length (cut off)", "length"],
    ["content_filter", "content_filter"],
  ])("doesn't store an answer that ended with %s", async (_label, finishReason) => {
    const { chat, redis } = setup({ reply: answer({ finishReason }) });

    await chat({});
    await settle();

    expect(redis.store.size).toBe(0);
  });

  it("keeps each account's answers separate", async () => {
    const { chat, gateway } = setup();
    await chat({}, { scope: "user-1" });
    await settle();

    await chat({}, { scope: "user-2" });

    expect(gateway.chat).toHaveBeenCalledTimes(2);
  });

  it("caches nothing without an account to scope it to", async () => {
    const { chat, gateway } = setup();

    await chat({}, { scope: "" });
    await settle();
    await chat({}, { scope: "" });

    expect(gateway.chat).toHaveBeenCalledTimes(2);
  });

  it("lets errors through, and stores nothing for them", async () => {
    const { chat, gateway, redis } = setup();
    gateway.chat.mockRejectedValueOnce(new Error("provider down"));

    await expect(chat({})).rejects.toThrow("provider down");
    await settle();

    expect(redis.store.size).toBe(0);
  });

  it("treats Redis being down as a miss, every time, without failing the request", async () => {
    const { chat, gateway } = setup({ redis: fakeRedis({ failing: true }) });

    const { response } = await chat({});
    await settle();
    await chat({});

    expect(response.content).toBe("Morning: Amber Fort.");
    expect(gateway.chat).toHaveBeenCalledTimes(2);
  });

  it("treats a corrupt entry as a miss", async () => {
    const redis = fakeRedis();
    const { chat, gateway } = setup({ redis });
    const request = ChatRequestSchema.parse({
      model: "fast",
      temperature: 0,
      messages: [{ role: "user", content: "Plan one day in Jaipur." }],
    });
    await redis.set(cacheKey(request, { scope: "user-1" }), "{not json");

    await chat({});

    expect(gateway.chat).toHaveBeenCalledTimes(1);
  });

  it("passes streams straight through", () => {
    const { cached, gateway } = setup();

    expect(cached.stream).toBe(gateway.stream);
  });
});
