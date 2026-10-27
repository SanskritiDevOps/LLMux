import { describe, expect, it } from "vitest";
import { createGateway } from "../../src/gateway/gateway.service.js";
import { ChatRequestSchema } from "../../src/gateway/schemas.js";
import { GatewayError } from "../../src/utils/errors.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { streamFixture } from "../helpers/replayStream.js";

// The summary the gateway hands to context.onFinish for the usage log: exactly once per
// call, whatever the outcome. Real router, adapters and cost maths; only the network is faked.
const settings = {
  gemini: { apiKey: "gemini-test-key" },
  ollama: { baseUrl: "http://ollama.test:11434" },
};
const encoder = new TextEncoder();

function streamed(...pieces) {
  async function* chunks() {
    for (const piece of pieces) yield typeof piece === "string" ? encoder.encode(piece) : piece;
  }
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: null,
    durationMs: 30,
    chunks: chunks(),
  };
}

function setup({ reply, streamReply }) {
  const summaries = [];
  const gateway = createGateway({
    enabledProviders: new Set(["gemini", "ollama"]),
    providerSettings: settings,
    send: async () => reply,
    wait: async () => {},
    openStream: async () => streamReply,
  });
  const context = (signal) => ({
    requestId: "req_test",
    signal,
    log: captureLogs().logger,
    onFinish: (summary) => summaries.push(summary),
  });
  const parse = (body) =>
    ChatRequestSchema.parse({ messages: [{ role: "user", content: "Hi there" }], ...body });
  return {
    summaries,
    chat: (body) => gateway.chat(parse(body), context()),
    stream: (body, signal) => gateway.stream(parse({ ...body, stream: true }), context(signal)),
  };
}

const ok = (body) => ({ ok: true, status: 200, body, durationMs: 40 });
const geminiAnswer = {
  candidates: [{ content: { parts: [{ text: "Amber Fort." }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 310 },
};

async function collect(events) {
  const out = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("gateway.chat summary", () => {
  it("reports the target, usage, cost and provider latency of a successful call", async () => {
    const { chat, summaries } = setup({ reply: ok(geminiAnswer) });

    await chat({ model: "fast" });

    expect(summaries).toEqual([
      {
        alias: "fast",
        target: { provider: "gemini", model: "gemini-3.5-flash-lite" },
        usage: { inputTokens: 42, outputTokens: 310, totalTokens: 352 },
        usageEstimated: false,
        costMicroUsd: 788,
        savedMicroUsd: 0,
        attempts: 1,
        fallbackUsed: false,
        cached: false,
        providerLatencyMs: 40,
        timeToFirstTokenMs: null,
      },
    ]);
  });

  it("reports the target with no usage when the provider fails", async () => {
    const { chat, summaries } = setup({
      reply: { ok: false, status: 429, body: {}, durationMs: 5 },
    });

    await expect(chat({ model: "gemini:gemini-3.5-flash-lite" })).rejects.toBeInstanceOf(
      GatewayError,
    );

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      target: { provider: "gemini" },
      usage: { inputTokens: 0, outputTokens: 0 },
      costMicroUsd: 0,
    });
  });

  it("reports no target for an unknown model", async () => {
    const { chat, summaries } = setup({ reply: ok(geminiAnswer) });

    await expect(chat({ model: "fastest" })).rejects.toMatchObject({ code: "UNKNOWN_MODEL" });

    expect(summaries).toEqual([expect.objectContaining({ alias: null, target: null })]);
  });
});

describe("gateway.stream summary", () => {
  it("reports usage, cost and time to first token for a finished stream", async () => {
    const { stream, summaries } = setup({
      streamReply: streamed(streamFixture("gemini", "stream-success.sse")),
    });

    await collect(stream({ model: "fast" }));

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      target: { provider: "gemini", model: "gemini-3.5-flash-lite" },
      usage: { inputTokens: 12, outputTokens: 11, totalTokens: 23 },
      usageEstimated: false,
      costMicroUsd: 31,
      providerLatencyMs: 30,
      timeToFirstTokenMs: expect.any(Number),
    });
  });

  it("counts the tokens of a stream that fails part-way, estimating them if needed", async () => {
    // Text, then the connection ends without a finish: billed by the provider all the same.
    const line = (fields) => `${JSON.stringify({ model: "llama3.2:1b", ...fields })}\n`;
    const { stream, summaries } = setup({
      streamReply: streamed(line({ message: { content: "Amber Fort is" }, done: false })),
    });

    await expect(collect(stream({ model: "local" }))).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });

    // "Hi there" = 8 chars → 2 tokens; "Amber Fort is" = 13 chars → 4 tokens.
    expect(summaries[0]).toMatchObject({
      usage: { inputTokens: 2, outputTokens: 4, totalTokens: 6 },
      usageEstimated: true,
      costMicroUsd: 0,
    });
  });

  it("reports once when the consumer stops early, with the tokens so far", async () => {
    const { stream, summaries } = setup({
      streamReply: streamed(streamFixture("gemini", "stream-success.sse")),
    });
    const events = stream({ model: "fast" });
    await events.next();
    await events.next();

    await events.return();

    expect(summaries).toHaveLength(1);
    expect(summaries[0].usage.inputTokens).toBeGreaterThan(0);
  });

  it("reports no usage when the provider refuses before streaming", async () => {
    const { stream, summaries } = setup({
      streamReply: { ok: false, status: 503, body: {}, durationMs: 5 },
    });

    await expect(stream({ model: "gemini:gemini-3.5-flash-lite" }).next()).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });

    expect(summaries[0]).toMatchObject({
      target: { provider: "gemini" },
      usage: { inputTokens: 0, outputTokens: 0 },
      usageEstimated: false,
      timeToFirstTokenMs: null,
    });
  });
});
