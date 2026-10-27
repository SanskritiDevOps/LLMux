import { describe, expect, it } from "vitest";
import { MAX_WAIT_BEFORE_FALLBACK_MS, createGateway } from "../../src/gateway/gateway.service.js";
import { ChatRequestSchema } from "../../src/gateway/schemas.js";
import { GatewayError } from "../../src/utils/errors.js";
import { captureLogs } from "../helpers/captureLogs.js";

// Retries, backoff, Retry-After, the deadline and fallback inside the real gateway (real
// router, adapters, error policy and cost maths). Each provider call gets the next scripted
// reply, and waits are recorded instead of slept. "fast" is gemini → ollama.
const GEMINI_ONLY = "gemini:gemini-3.5-flash-lite";
const encoder = new TextEncoder();

const geminiOk = {
  ok: true,
  status: 200,
  headers: new Headers(),
  durationMs: 40,
  body: {
    candidates: [{ content: { parts: [{ text: "Amber Fort." }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 310 },
  },
};
const ollamaOk = {
  ok: true,
  status: 200,
  headers: new Headers(),
  durationMs: 30,
  body: {
    message: { content: "City Palace." },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 10,
    eval_count: 20,
  },
};
const failure = (status, headers = {}) => ({
  ok: false,
  status,
  headers: new Headers(headers),
  body: { error: { code: status, message: "upstream detail" } },
  durationMs: 5,
});

/** A streamed answer, delivered as an openStream() result. */
function streamed(lines) {
  async function* chunks() {
    for (const line of lines) yield encoder.encode(line);
  }
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: null,
    durationMs: 20,
    chunks: chunks(),
  };
}
const geminiEvent = (json) => `data: ${JSON.stringify(json)}\r\n\r\n`;
const geminiStream = (...texts) =>
  streamed([
    ...texts.map((text) => geminiEvent({ candidates: [{ content: { parts: [{ text }] } }] })),
    geminiEvent({
      candidates: [{ finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 },
    }),
  ]);
const ollamaLine = (fields) => `${JSON.stringify({ model: "llama3.2:1b", ...fields })}\n`;
const ollamaStream = (...texts) =>
  streamed([
    ...texts.map((content) => ollamaLine({ message: { content }, done: false })),
    ollamaLine({ done: true, done_reason: "stop", prompt_eval_count: 9, eval_count: 3 }),
  ]);

/**
 * @param {{ replies?: Record<string, object[]>, streams?: Record<string, (() => object)[]>,
 *   send?: Function, options?: object }} script  each provider's replies, used in order;
 *   the last one repeats
 */
function setup({ replies = {}, streams = {}, send, ...options } = {}) {
  const calls = [];
  const waits = [];
  const summaries = [];
  const logs = captureLogs();
  const next = (list, provider) =>
    list[provider].length > 1 ? list[provider].shift() : list[provider][0];
  const gateway = createGateway({
    enabledProviders: new Set(["gemini", "ollama"]),
    providerSettings: { gemini: { apiKey: "k" }, ollama: { baseUrl: "http://ollama.test" } },
    timeoutMs: 1000,
    send:
      send ??
      (async (req, opts) => {
        calls.push({ provider: opts.provider, timeoutMs: opts.timeoutMs });
        return next(replies, opts.provider);
      }),
    openStream: async (req, opts) => {
      calls.push({ provider: opts.provider, timeoutMs: opts.timeoutMs });
      return next(streams, opts.provider)();
    },
    wait: async (ms) => {
      waits.push(ms);
    },
    // The middle of the jitter range, so waits are exactly 250 ms, then 500 ms.
    random: () => 0.5,
    ...options,
  });
  const context = (signal) => ({
    requestId: "req_test",
    signal,
    log: logs.logger,
    onFinish: (summary) => summaries.push(summary),
  });
  const parse = (body) =>
    ChatRequestSchema.parse({ messages: [{ role: "user", content: "Hi" }], ...body });
  return {
    calls,
    waits,
    summaries,
    logs,
    chat: (body, signal) => gateway.chat(parse(body), context(signal)),
    stream: (body, signal) => gateway.stream(parse({ ...body, stream: true }), context(signal)),
    providers: () => calls.map((call) => call.provider),
  };
}

async function collect(events) {
  const out = [];
  for await (const event of events) out.push(event);
  return out;
}

const rejection = (promise) =>
  promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (err) => err,
  );

describe("chat retries", () => {
  it("retries a 503 on the same provider after about 250 ms, and answers", async () => {
    const { chat, providers, waits, summaries } = setup({
      replies: { gemini: [failure(503), geminiOk] },
    });

    const { response, meta } = await chat({ model: "fast" });

    expect(providers()).toEqual(["gemini", "gemini"]);
    expect(waits).toEqual([250]);
    expect(response).toMatchObject({ provider: "gemini", fallbackUsed: false });
    expect(meta.attempts).toBe(2);
    expect(summaries[0]).toMatchObject({ attempts: 2, fallbackUsed: false });
  });

  it("gives up on a provider after 2 retries (250 ms, then 500 ms) and falls back", async () => {
    const { chat, providers, waits, summaries } = setup({
      replies: { gemini: [failure(500)], ollama: [ollamaOk] },
    });

    const { response, meta } = await chat({ model: "fast" });

    expect(providers()).toEqual(["gemini", "gemini", "gemini", "ollama"]);
    expect(waits).toEqual([250, 500]);
    expect(response).toMatchObject({
      provider: "ollama",
      providerModel: "llama3.2:1b",
      content: "City Palace.",
      fallbackUsed: true,
      costUsd: 0,
    });
    expect(meta.attempts).toBe(4);
    expect(summaries[0]).toMatchObject({
      attempts: 4,
      fallbackUsed: true,
      target: { provider: "ollama", model: "llama3.2:1b" },
      usage: { inputTokens: 10, outputTokens: 20 },
    });
  });

  it.each([
    ["a timeout", new GatewayError("TIMEOUT", "gemini did not respond", { provider: "gemini" })],
    [
      "an unreachable provider",
      new GatewayError("PROVIDER_UNAVAILABLE", "Could not reach gemini", { provider: "gemini" }),
    ],
  ])("retries %s from the HTTP client too", async (_label, error) => {
    let calls = 0;
    const { chat } = setup({
      send: async () => {
        calls += 1;
        if (calls === 1) throw error;
        return geminiOk;
      },
    });

    const { meta } = await chat({ model: "fast" });

    expect(meta.attempts).toBe(2);
  });

  it("falls back at once, without retrying, when the provider rejects LLMux's key", async () => {
    const { chat, providers, waits, logs } = setup({
      replies: { gemini: [failure(401)], ollama: [ollamaOk] },
    });

    const { response } = await chat({ model: "fast" });

    expect(providers()).toEqual(["gemini", "ollama"]);
    expect(waits).toEqual([]);
    expect(response.fallbackUsed).toBe(true);
    expect(logs.lines.find((line) => line.msg.includes("check its API key"))).toMatchObject({
      provider: "gemini",
    });
  });

  it("falls back without retrying when the model is missing at that provider (404)", async () => {
    const { chat, providers } = setup({ replies: { gemini: [failure(404)], ollama: [ollamaOk] } });

    await chat({ model: "fast" });

    expect(providers()).toEqual(["gemini", "ollama"]);
  });

  it("stops at a 400, because every provider would refuse the same request", async () => {
    const { chat, providers, summaries } = setup({
      replies: { gemini: [failure(400)], ollama: [ollamaOk] },
    });

    const error = await rejection(chat({ model: "fast" }));

    expect(error).toMatchObject({ code: "INVALID_REQUEST", provider: "gemini" });
    expect(providers()).toEqual(["gemini"]);
    expect(summaries[0]).toMatchObject({ attempts: 1, fallbackUsed: false });
  });

  it("reports the last provider's error when every target fails", async () => {
    const { chat, providers } = setup({
      replies: { gemini: [failure(500)], ollama: [failure(503)] },
    });

    const error = await rejection(chat({ model: "fast" }));

    expect(error).toMatchObject({ code: "PROVIDER_UNAVAILABLE", provider: "ollama" });
    expect(providers()).toHaveLength(6);
  });

  it("does not retry when MAX_RETRIES is 0, but still falls back", async () => {
    const { chat, providers } = setup({
      maxRetries: 0,
      replies: { gemini: [failure(503)], ollama: [ollamaOk] },
    });

    await chat({ model: "fast" });

    expect(providers()).toEqual(["gemini", "ollama"]);
  });

  it("logs every failed attempt with what happens next", async () => {
    const { chat, logs } = setup({ replies: { gemini: [failure(503), geminiOk] } });

    await chat({ model: "fast" });

    expect(logs.lines.find((line) => line.msg === "Provider attempt failed")).toMatchObject({
      provider: "gemini",
      attempt: 1,
      code: "PROVIDER_UNAVAILABLE",
      retry: true,
      fallback: true,
    });
    expect(logs.lines.find((line) => line.msg === "Retrying provider")).toMatchObject({
      retry: 1,
      waitMs: 250,
    });
    expect(logs.lines.find((line) => line.msg === "Provider call completed")).toMatchObject({
      attempt: 2,
      fallbackUsed: false,
    });
  });
});

describe("Retry-After", () => {
  it("waits the provider's Retry-After when it is longer than the backoff", async () => {
    const { chat, waits } = setup({
      replies: { gemini: [failure(429, { "retry-after": "1" }), geminiOk] },
    });

    await chat({ model: "fast" });

    expect(waits).toEqual([1000]);
  });

  it("moves on to the next target instead of waiting long, when one is there", async () => {
    const { chat, providers, waits } = setup({
      replies: { gemini: [failure(429, { "retry-after": "30" })], ollama: [ollamaOk] },
    });

    const { response } = await chat({ model: "fast" });

    expect(MAX_WAIT_BEFORE_FALLBACK_MS).toBe(2000);
    expect(waits).toEqual([]);
    expect(providers()).toEqual(["gemini", "ollama"]);
    expect(response.fallbackUsed).toBe(true);
  });

  it("waits a long Retry-After for a direct call, which has nowhere else to go", async () => {
    const { chat, waits } = setup({
      replies: { gemini: [failure(429, { "retry-after": "5" }), geminiOk] },
    });

    await chat({ model: GEMINI_ONLY });

    expect(waits).toEqual([5000]);
  });

  it("never waits past the deadline: it gives up and reports the provider's error", async () => {
    const { chat, waits } = setup({
      deadlineMs: 2000,
      replies: { gemini: [failure(429, { "retry-after": "5" }), geminiOk] },
    });

    const error = await rejection(chat({ model: GEMINI_ONLY }));

    expect(waits).toEqual([]);
    expect(error).toMatchObject({ code: "PROVIDER_RATE_LIMITED" });
  });
});

describe("the overall deadline", () => {
  it("cuts each attempt's timeout to the time left", async () => {
    const { chat, calls } = setup({ deadlineMs: 500, replies: { gemini: [geminiOk] } });

    await chat({ model: "fast" });

    expect(calls[0].timeoutMs).toBeLessThanOrEqual(500);
    expect(calls[0].timeoutMs).toBeGreaterThan(400);
  });

  it("stops with a TIMEOUT naming the deadline once time runs out", async () => {
    const { chat, summaries } = setup({
      deadlineMs: 50,
      send: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return failure(503);
      },
    });

    const error = await rejection(chat({ model: "fast" }));

    expect(error).toMatchObject({ code: "TIMEOUT", status: 504, retryable: true });
    expect(error.message).toBe("No provider answered within the 50 ms deadline (1 attempt)");
    expect(error.cause).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(summaries[0].attempts).toBe(1);
  });
});

describe("client disconnects", () => {
  it("stops retrying as soon as the client leaves, mid-wait", async () => {
    const controller = new AbortController();
    const { chat, providers } = setup({
      replies: { gemini: [failure(503)] },
      // A real wait, so the abort lands in the middle of it.
      wait: (ms, signal) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason);
          });
        }),
    });
    setTimeout(() => controller.abort(), 20);

    const error = await rejection(chat({ model: "fast" }, controller.signal));

    expect(error.name).toBe("AbortError");
    expect(providers()).toEqual(["gemini"]);
  });

  it("does not retry or fall back when the call was aborted by the client", async () => {
    const controller = new AbortController();
    const { chat, providers } = setup({
      send: async () => {
        controller.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    });

    const error = await rejection(chat({ model: "fast" }, controller.signal));

    expect(error.name).toBe("AbortError");
    expect(providers()).toEqual([]);
  });
});

describe("stream fallback before the first token", () => {
  it("falls back when the first provider refuses the stream, and the client never sees it", async () => {
    const { stream, providers, summaries } = setup({
      maxRetries: 0,
      streams: { gemini: [() => failure(503)], ollama: [() => ollamaStream("City ", "Palace.")] },
    });

    const events = await collect(stream({ model: "fast" }));

    expect(providers()).toEqual(["gemini", "ollama"]);
    expect(events.map((event) => event.type)).toEqual(["start", "delta", "delta", "end"]);
    expect(events[0]).toMatchObject({ type: "start", provider: "ollama" });
    expect(summaries[0]).toMatchObject({
      attempts: 2,
      fallbackUsed: true,
      target: { provider: "ollama" },
    });
  });

  it("falls back when a stream fails after opening but before any token", async () => {
    const { stream, providers } = setup({
      maxRetries: 0,
      streams: {
        gemini: [() => streamed([geminiEvent({ error: { code: 503, message: "overloaded" } })])],
        ollama: [() => ollamaStream("City Palace.")],
      },
    });

    const events = await collect(stream({ model: "fast" }));

    expect(providers()).toEqual(["gemini", "ollama"]);
    expect(events[0].provider).toBe("ollama");
    expect(events.filter((event) => event.type === "delta").map((event) => event.text)).toEqual([
      "City Palace.",
    ]);
  });

  it("retries a stream on the same provider before falling back", async () => {
    const { stream, providers, waits } = setup({
      streams: { gemini: [() => failure(503), () => geminiStream("Amber Fort.")] },
    });

    const events = await collect(stream({ model: "fast" }));

    expect(providers()).toEqual(["gemini", "gemini"]);
    expect(waits).toEqual([250]);
    expect(events[0].provider).toBe("gemini");
  });

  it("never falls back once a token was sent: the error reaches the client after the text", async () => {
    const { stream, providers } = setup({
      streams: {
        gemini: [
          () =>
            streamed([
              geminiEvent({ candidates: [{ content: { parts: [{ text: "Amber " }] } }] }),
              geminiEvent({ error: { code: 503, message: "overloaded" } }),
            ]),
        ],
        ollama: [() => ollamaStream("never used")],
      },
    });
    const seen = [];

    const error = await rejection(
      (async () => {
        for await (const event of stream({ model: "fast" })) seen.push(event);
      })(),
    );

    expect(seen.map((event) => event.type)).toEqual(["start", "delta"]);
    expect(error).toMatchObject({ code: "PROVIDER_UNAVAILABLE", provider: "gemini" });
    expect(providers()).toEqual(["gemini"]);
  });

  it("throws before any event when every target fails, so the route can answer with JSON", async () => {
    const { stream } = setup({
      maxRetries: 0,
      streams: { gemini: [() => failure(503)], ollama: [() => failure(500)] },
    });
    const events = stream({ model: "fast" });

    const error = await rejection(events.next());

    expect(error).toMatchObject({ code: "PROVIDER_ERROR", provider: "ollama" });
  });

  it("measures time to first token from the start, retries included", async () => {
    const { stream, summaries } = setup({
      maxRetries: 0,
      streams: {
        gemini: [
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 40));
            return failure(503);
          },
        ],
        ollama: [() => ollamaStream("City Palace.")],
      },
    });

    await collect(stream({ model: "fast" }));

    expect(summaries[0].timeToFirstTokenMs).toBeGreaterThanOrEqual(35);
  });
});
