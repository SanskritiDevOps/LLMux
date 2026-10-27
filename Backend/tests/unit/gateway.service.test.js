import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ChatRequestSchema, ChatResponseSchema } from "../../src/gateway/schemas.js";
import { createGateway } from "../../src/gateway/gateway.service.js";
import { getProviderSettings } from "../../src/gateway/providerSettings.js";
import { GatewayError } from "../../src/utils/errors.js";
import { captureLogs } from "../helpers/captureLogs.js";

const fixture = (provider, name) =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/${provider}/${name}.json`, import.meta.url), "utf8"),
  );

const settings = {
  gemini: { apiKey: "gemini-test-key" },
  ollama: { baseUrl: "http://ollama.test:11434" },
};

// Real router, real adapters, real cost maths; only the network call is faked.
function setup({ enabled = ["gemini", "ollama"], reply }) {
  const send = vi.fn(async () => reply);
  const logs = captureLogs();
  const gateway = createGateway({
    enabledProviders: new Set(enabled),
    providerSettings: settings,
    timeoutMs: 1234,
    // Retries wait without delay here; their timing is tested in retry.test.js.
    wait: async () => {},
    send,
  });
  const chat = (body, signal) =>
    gateway.chat(
      ChatRequestSchema.parse({ messages: [{ role: "user", content: "Hi" }], ...body }),
      {
        requestId: "req_test",
        signal,
        log: logs.logger,
      },
    );
  return { chat, send, logs };
}

const ok = (body) => ({ ok: true, status: 200, body, durationMs: 40 });

describe("gateway.chat", () => {
  it("routes an alias to its first configured target and returns the unified response", async () => {
    const { chat, send } = setup({ reply: ok(fixture("gemini", "success")) });

    const { response } = await chat({ model: "fast" });

    expect(ChatResponseSchema.parse(response)).toEqual({
      id: "req_test",
      model: "fast",
      provider: "gemini",
      providerModel: "gemini-3.5-flash-lite",
      content: "Morning: Amber Fort. Afternoon: City Palace.",
      finishReason: "stop",
      usage: { inputTokens: 42, outputTokens: 310, totalTokens: 352 },
      // 42 × $0.30/MTok + 310 × $2.50/MTok = 788 micro-dollars
      costUsd: 0.000788,
      latencyMs: expect.any(Number),
      cached: false,
      fallbackUsed: false,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("passes the provider's credentials, the capped maxTokens and the timeout to the call", async () => {
    const { chat, send } = setup({ reply: ok(fixture("gemini", "success")) });
    const signal = new AbortController().signal;

    await chat({ model: "fast", maxTokens: 999_999 }, signal);

    const [providerRequest, options] = send.mock.calls[0];
    expect(providerRequest.headers["x-goog-api-key"]).toBe("gemini-test-key");
    // Capped at the catalog's maxOutputTokens for this model.
    expect(providerRequest.body.generationConfig.maxOutputTokens).toBe(8192);
    expect(options).toEqual({ provider: "gemini", timeoutMs: 1234, signal });
  });

  it("uses the next configured target when the primary provider has no key", async () => {
    const { chat, send } = setup({ enabled: ["ollama"], reply: ok(fixture("ollama", "success")) });

    const { response } = await chat({ model: "fast" });

    expect(response).toMatchObject({
      provider: "ollama",
      providerModel: "llama3.2:1b",
      costUsd: 0,
    });
    expect(send.mock.calls[0][0].url).toBe("http://ollama.test:11434/api/chat");
  });

  it("supports direct provider:model calls", async () => {
    const { chat } = setup({ reply: ok(fixture("ollama", "success")) });

    const { response, meta } = await chat({ model: "ollama:llama3.2:1b" });

    expect(response.model).toBe("ollama:llama3.2:1b");
    expect(meta.alias).toBeNull();
  });

  it("returns metadata for usage logging alongside the response", async () => {
    const { chat } = setup({ reply: ok(fixture("gemini", "success")) });

    const { meta } = await chat({ model: "fast" });

    expect(meta).toMatchObject({
      alias: "fast",
      attempts: 1,
      providerLatencyMs: 40,
      usageEstimated: false,
      costMicroUsd: 788,
      savedMicroUsd: 0,
    });
    expect(meta.target.key).toBe("gemini:gemini-3.5-flash-lite");
  });

  it("maps a provider error with the adapter and logs the raw body without exposing it", async () => {
    const body = fixture("gemini", "error-rate-limited-429");
    const { chat, logs } = setup({
      enabled: ["gemini"],
      reply: { ok: false, status: 429, body, durationMs: 5 },
    });

    const error = await chat({ model: "fast" }).catch((err) => err);

    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({ code: "PROVIDER_RATE_LIMITED", provider: "gemini" });
    expect(error.message).not.toContain("exhausted");

    const warning = logs.lines.find((line) => line.msg === "Provider returned an error");
    expect(warning).toMatchObject({
      provider: "gemini",
      status: 429,
      code: "PROVIDER_RATE_LIMITED",
    });
    expect(warning.providerBody).toContain("rate_limit_exceeded");
  });

  it("truncates huge provider error bodies in the log", async () => {
    const { chat, logs } = setup({
      reply: { ok: false, status: 502, body: "<html>".padEnd(5000, "x"), durationMs: 5 },
    });

    await chat({ model: "fast" }).catch(() => {});

    const warning = logs.lines.find((line) => line.msg === "Provider returned an error");
    expect(warning.providerBody.length).toBeLessThanOrEqual(1001);
  });

  it("logs the raw body when a 200 response cannot be parsed", async () => {
    const { chat, logs } = setup({
      enabled: ["gemini"],
      reply: ok({ unexpected: "new-provider-format" }),
    });

    const error = await chat({ model: "fast" }).catch((err) => err);

    expect(error).toMatchObject({ code: "PROVIDER_ERROR", provider: "gemini" });
    const warning = logs.lines.find((line) => line.msg === "Provider response could not be parsed");
    expect(warning).toMatchObject({ provider: "gemini", status: 200, code: "PROVIDER_ERROR" });
    expect(warning.providerBody).toContain("new-provider-format");
  });

  it("logs a successful call with tokens, latency and cost", async () => {
    const { chat, logs } = setup({ reply: ok(fixture("gemini", "success")) });

    await chat({ model: "fast" });

    expect(logs.lines.find((line) => line.msg === "Provider call completed")).toMatchObject({
      provider: "gemini",
      model: "gemini-3.5-flash-lite",
      status: 200,
      providerLatencyMs: 40,
      inputTokens: 42,
      outputTokens: 310,
      costMicroUsd: 788,
    });
  });

  it("lets transport errors from the HTTP client through unchanged", async () => {
    const timeout = new GatewayError("TIMEOUT", "gemini did not respond within 1234 ms", {
      provider: "gemini",
    });
    const logs = captureLogs();
    const gateway = createGateway({
      enabledProviders: new Set(["gemini"]),
      providerSettings: settings,
      send: async () => {
        throw timeout;
      },
    });

    const request = ChatRequestSchema.parse({
      model: "fast",
      messages: [{ role: "user", content: "Hi" }],
    });
    await expect(gateway.chat(request, { requestId: "r", log: logs.logger })).rejects.toBe(timeout);
  });

  it("rejects unknown models before calling any provider", async () => {
    const { chat, send } = setup({ reply: ok({}) });

    await expect(chat({ model: "fastest" })).rejects.toMatchObject({ code: "UNKNOWN_MODEL" });
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses stream: true, which belongs to gateway.stream()", async () => {
    const { chat, send } = setup({ reply: ok({}) });

    await expect(chat({ model: "fast", stream: true })).rejects.toThrow(
      "gateway.chat() does not stream; use gateway.stream()",
    );
    expect(send).not.toHaveBeenCalled();
  });
});

describe("getProviderSettings", () => {
  it("takes keys and the Ollama URL from the environment", () => {
    expect(
      getProviderSettings({
        GEMINI_API_KEY: "g",
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: "a",
        OLLAMA_BASE_URL: "http://localhost:11434",
      }),
    ).toEqual({
      gemini: { apiKey: "g" },
      openai: { apiKey: undefined },
      anthropic: { apiKey: "a" },
      ollama: { baseUrl: "http://localhost:11434" },
    });
  });
});
