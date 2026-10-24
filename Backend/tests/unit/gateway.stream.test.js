import { describe, expect, it, vi } from "vitest";
import { createGateway } from "../../src/gateway/gateway.service.js";
import { ChatRequestSchema, StreamEventSchema } from "../../src/gateway/schemas.js";
import { GatewayError } from "../../src/utils/errors.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { streamFixture } from "../helpers/replayStream.js";

const settings = {
  gemini: { apiKey: "gemini-test-key" },
  ollama: { baseUrl: "http://ollama.test:11434" },
};

const encoder = new TextEncoder();

/** An openStream() result whose body is the given pieces (strings or bytes). */
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

// Real router, adapters, stream reader and cost maths; only the network is faked.
function setup({ enabled = ["gemini", "ollama"], reply }) {
  const openStream = vi.fn(async () => reply);
  const logs = captureLogs();
  const gateway = createGateway({
    enabledProviders: new Set(enabled),
    providerSettings: settings,
    timeoutMs: 1234,
    openStream,
  });
  const stream = (body, signal) =>
    gateway.stream(
      ChatRequestSchema.parse({ messages: [{ role: "user", content: "Hi there" }], ...body }),
      { requestId: "req_test", signal, log: logs.logger },
    );
  return { stream, openStream, logs };
}

async function collect(events) {
  const out = [];
  for await (const event of events) out.push(event);
  return out;
}

const ollamaLine = (fields) => `${JSON.stringify({ model: "llama3.2:1b", ...fields })}\n`;

describe("gateway.stream", () => {
  it("streams a Gemini answer as start, deltas and end, all in the unified format", async () => {
    const { stream, openStream } = setup({
      reply: streamed(streamFixture("gemini", "stream-success.sse")),
    });

    const events = await collect(stream({ model: "fast", stream: true }));

    for (const event of events) expect(StreamEventSchema.parse(event)).toEqual(event);
    expect(events.map((event) => event.type)).toEqual(["start", "delta", "delta", "delta", "end"]);
    expect(events[0]).toEqual({ type: "start", id: "req_test", model: "fast", provider: "gemini" });
    expect(events.at(-1)).toEqual({
      type: "end",
      finishReason: "stop",
      usage: { inputTokens: 12, outputTokens: 11, totalTokens: 23 },
      latencyMs: expect.any(Number),
    });
    const [providerRequest, options] = openStream.mock.calls[0];
    expect(providerRequest.url).toContain(":streamGenerateContent?alt=sse");
    expect(options).toMatchObject({ provider: "gemini", timeoutMs: 1234 });
  });

  it("streams a recorded Ollama answer for the local alias", async () => {
    const { stream, openStream } = setup({
      reply: streamed(streamFixture("ollama", "stream-success.ndjson")),
    });

    const events = await collect(stream({ model: "local", stream: true }));

    const text = events.filter((event) => event.type === "delta").map((event) => event.text);
    expect(text.join("")).toBe("The Amber Fort is a prominent fort in Jaipur.");
    expect(events.at(-1)).toMatchObject({
      finishReason: "stop",
      usage: { inputTokens: 36, outputTokens: 12, totalTokens: 48 },
    });
    expect(openStream.mock.calls[0][0].body.stream).toBe(true);
  });

  it("estimates usage, and says so, when the provider sends no counts", async () => {
    const { stream } = setup({
      reply: streamed(
        ollamaLine({ message: { content: "Amber Fort" }, done: false }),
        ollamaLine({ message: { content: "" }, done: true, done_reason: "stop" }),
      ),
    });

    const events = await collect(stream({ model: "local", system: "Be brief." }));

    // ("Be brief." + "Hi there") = 17 chars → 5 tokens; "Amber Fort" = 10 chars → 3 tokens.
    expect(events.at(-1)).toMatchObject({
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      usageEstimated: true,
    });
  });

  it("throws a provider error before yielding anything, so the route can still use HTTP status", async () => {
    const { stream, logs } = setup({
      reply: { ok: false, status: 429, body: { error: { code: 429 } }, durationMs: 5 },
    });
    const events = stream({ model: "fast" });

    await expect(events.next()).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" });
    expect(logs.lines.find((line) => line.msg === "Provider returned an error")).toMatchObject({
      provider: "gemini",
      status: 429,
    });
  });

  it("rejects unknown models before opening any stream", async () => {
    const { stream, openStream } = setup({ reply: streamed() });

    await expect(stream({ model: "fastest" }).next()).rejects.toMatchObject({
      code: "UNKNOWN_MODEL",
    });
    expect(openStream).not.toHaveBeenCalled();
  });

  it("throws after the deltas already sent when the provider fails mid-stream", async () => {
    const { stream, logs } = setup({
      reply: streamed(streamFixture("gemini", "stream-error-midway.sse")),
    });
    const seen = [];

    const error = await (async () => {
      for await (const event of stream({ model: "fast" })) seen.push(event.type);
    })().catch((err) => err);

    expect(seen).toEqual(["start", "delta"]);
    expect(error).toBeInstanceOf(GatewayError);
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(logs.lines.find((line) => line.msg === "Provider stream failed").providerBody).toContain(
      "overloaded",
    );
  });

  it("fails a stream that ends without a finish, since the answer may be truncated", async () => {
    const { stream, logs } = setup({
      reply: streamed(ollamaLine({ message: { content: "Amber" }, done: false })),
    });

    await expect(collect(stream({ model: "local" }))).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      provider: "ollama",
      retryable: true,
      message: "ollama ended the stream before the answer was complete",
    });
    expect(logs.lines.some((line) => line.msg === "Provider stream ended without finishing")).toBe(
      true,
    );
  });

  it("cancels the provider request when the consumer stops early", async () => {
    const { stream, openStream } = setup({
      reply: streamed(streamFixture("gemini", "stream-success.sse")),
    });
    const events = stream({ model: "fast" });

    await events.next();
    await events.return();

    expect(openStream.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("passes the caller's abort through to the provider request", async () => {
    const { stream, openStream } = setup({
      reply: streamed(streamFixture("gemini", "stream-success.sse")),
    });
    const controller = new AbortController();
    const events = stream({ model: "fast" }, controller.signal);
    await events.next();

    controller.abort();

    expect(openStream.mock.calls[0][1].signal.aborted).toBe(true);
    await events.return();
  });

  it("logs the completed stream with time to first token, tokens and cost", async () => {
    const { stream, logs } = setup({
      reply: streamed(streamFixture("gemini", "stream-success.sse")),
    });

    await collect(stream({ model: "fast" }));

    expect(logs.lines.find((line) => line.msg === "Provider stream completed")).toMatchObject({
      provider: "gemini",
      streamed: true,
      timeToFirstTokenMs: expect.any(Number),
      inputTokens: 12,
      outputTokens: 11,
      usageEstimated: false,
      // 12 × $0.30/MTok + 11 × $2.50/MTok = 31.1, rounded to 31 micro-dollars
      costMicroUsd: 31,
    });
  });
});
