import { describe, expect, it } from "vitest";
import { buildUsageRow, trackUsage } from "../../src/modules/usage/usageRecorder.js";
import { GatewayError } from "../../src/utils/errors.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { fakeUsage } from "../helpers/fakeUsage.js";

const summary = (fields) => ({
  alias: "fast",
  target: { provider: "gemini", model: "gemini-3.5-flash-lite" },
  usage: { inputTokens: 42, outputTokens: 310, totalTokens: 352 },
  usageEstimated: false,
  costMicroUsd: 788,
  savedMicroUsd: 0,
  attempts: 1,
  fallbackUsed: false,
  cached: false,
  providerLatencyMs: 900,
  timeToFirstTokenMs: 210,
  ...fields,
});

const base = {
  requestId: "req_1",
  apiKeyId: "key-1",
  request: { model: "fast" },
  transport: "http",
  streamed: false,
  latencyMs: 950,
};

describe("buildUsageRow", () => {
  it("builds a success row from the gateway's summary", () => {
    expect(buildUsageRow({ ...base, summary: summary() })).toEqual({
      requestId: "req_1",
      apiKeyId: "key-1",
      modelAlias: "fast",
      provider: "gemini",
      providerModel: "gemini-3.5-flash-lite",
      inputTokens: 42,
      outputTokens: 310,
      usageEstimated: false,
      costMicroUsd: 788,
      savedMicroUsd: 0,
      latencyMs: 950,
      timeToFirstTokenMs: null,
      status: "success",
      errorCode: null,
      cached: false,
      fallbackUsed: false,
      attempts: 1,
      streamed: false,
      transport: "http",
    });
  });

  it("keeps time to first token for streams only", () => {
    const row = buildUsageRow({ ...base, transport: "sse", streamed: true, summary: summary() });

    expect(row).toMatchObject({ timeToFirstTokenMs: 210, streamed: true, transport: "sse" });
  });

  it("stores the model exactly as the client sent it, alias or provider:model", () => {
    const row = buildUsageRow({
      ...base,
      request: { model: "ollama:llama3.2:1b" },
      summary: summary(),
    });

    expect(row.modelAlias).toBe("ollama:llama3.2:1b");
  });

  it("records an error with its code and the provider that failed", () => {
    const error = new GatewayError("PROVIDER_RATE_LIMITED", "gemini rate limit reached", {
      provider: "gemini",
    });
    const row = buildUsageRow({
      ...base,
      summary: summary({ usage: { inputTokens: 0, outputTokens: 0 }, costMicroUsd: 0 }),
      error,
    });

    expect(row).toMatchObject({
      status: "error",
      errorCode: "PROVIDER_RATE_LIMITED",
      provider: "gemini",
      inputTokens: 0,
      costMicroUsd: 0,
    });
  });

  it("records a request that never reached a provider, with no provider at all", () => {
    const error = new GatewayError("UNKNOWN_MODEL", "Unknown model");
    const row = buildUsageRow({
      ...base,
      request: { model: "fastest" },
      summary: summary({ target: null }),
      error,
    });

    expect(row).toMatchObject({ modelAlias: "fastest", provider: null, providerModel: null });
  });

  it("works without a summary (the gateway was never reached)", () => {
    const row = buildUsageRow({ ...base, error: new GatewayError("INTERNAL_ERROR", "x") });

    expect(row).toMatchObject({ provider: null, inputTokens: 0, costMicroUsd: 0, attempts: 1 });
  });

  it("records a cancel as cancelled, with no error code, keeping the tokens used", () => {
    const row = buildUsageRow({
      ...base,
      transport: "ws",
      streamed: true,
      summary: summary({ usageEstimated: true }),
      cancelled: true,
    });

    expect(row).toMatchObject({
      status: "cancelled",
      errorCode: null,
      usageEstimated: true,
      outputTokens: 310,
    });
  });

  it("includes metadata tags only when the client sent some", () => {
    expect(buildUsageRow({ ...base, summary: summary() })).not.toHaveProperty("metadata");
    expect(
      buildUsageRow({
        ...base,
        request: { model: "fast", metadata: { app: "trip" } },
        summary: summary(),
      }).metadata,
    ).toEqual({ app: "trip" });
  });

  it("never contains message text", () => {
    const row = buildUsageRow({
      ...base,
      request: {
        model: "fast",
        system: "secret plan",
        messages: [{ role: "user", content: "secret" }],
      },
      summary: summary(),
    });

    expect(JSON.stringify(row)).not.toContain("secret");
  });
});

describe("trackUsage", () => {
  const start = (usage = fakeUsage(), log) => ({
    usage,
    tracker: trackUsage({
      usage,
      requestId: "req_1",
      apiKeyId: "key-1",
      request: { model: "fast" },
      transport: "sse",
      log,
    }),
  });

  it("records one row with the summary the gateway reported, and the measured latency", async () => {
    const { usage, tracker } = start();
    tracker.onFinish(summary());
    await new Promise((resolve) => setTimeout(resolve, 20));

    tracker.finish();

    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0]).toMatchObject({ status: "success", streamed: true, transport: "sse" });
    expect(usage.rows[0].latencyMs).toBeGreaterThanOrEqual(15);
  });

  it("records only once, however many times finish() is called", () => {
    const { usage, tracker } = start();

    tracker.finish();
    tracker.finish({ cancelled: true });

    expect(usage.rows).toHaveLength(1);
  });

  it("never throws if recording fails, and logs it instead", () => {
    const logs = captureLogs();
    const broken = {
      record: () => {
        throw new Error("buffer exploded");
      },
    };
    const { tracker } = start(broken, logs.logger);

    expect(() => tracker.finish()).not.toThrow();
    expect(logs.lines.some((line) => line.msg === "Could not record usage")).toBe(true);
  });
});
