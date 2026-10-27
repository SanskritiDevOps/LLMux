import { describe, expect, it, vi } from "vitest";
import { STATES, createCircuitBreaker } from "../../src/gateway/circuitBreaker.js";
import { createGateway } from "../../src/gateway/gateway.service.js";
import { ChatRequestSchema } from "../../src/gateway/schemas.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { fakeRedis } from "../helpers/fakeRedis.js";

// The real gateway with a real circuit breaker on an in-memory Redis: providers whose
// circuit is open are skipped without being called. "fast" is gemini → ollama.
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
  body: { message: { content: "City Palace." }, done: true, prompt_eval_count: 10, eval_count: 20 },
};
const failure = (status) => ({
  ok: false,
  status,
  headers: new Headers(),
  body: {},
  durationMs: 5,
});

function setup({ replies, ...options }) {
  const calls = [];
  const logs = captureLogs();
  const redis = fakeRedis();
  const breaker = createCircuitBreaker({ redis, logger: logs.logger, ...options.breaker });
  const next = (provider) =>
    replies[provider].length > 1 ? replies[provider].shift() : replies[provider][0];
  const gateway = createGateway({
    enabledProviders: new Set(["gemini", "ollama"]),
    providerSettings: { gemini: { apiKey: "k" }, ollama: { baseUrl: "http://ollama.test" } },
    send: async (_req, opts) => {
      calls.push(opts.provider);
      return next(opts.provider);
    },
    openStream: async (_req, opts) => {
      calls.push(opts.provider);
      const reply = next(opts.provider);
      if (!reply.ok) return reply;
      async function* chunks() {
        yield encoder.encode(
          `${JSON.stringify({ message: { content: "City Palace." }, done: false })}\n`,
        );
        yield encoder.encode(`${JSON.stringify({ done: true, done_reason: "stop" })}\n`);
      }
      return { ...reply, body: null, chunks: chunks() };
    },
    wait: async () => {},
    breaker,
    ...options.gateway,
  });
  const chat = (body) =>
    gateway.chat(
      ChatRequestSchema.parse({ messages: [{ role: "user", content: "Hi" }], ...body }),
      { requestId: "req_test", log: logs.logger },
    );
  const stream = (body) =>
    gateway.stream(
      ChatRequestSchema.parse({
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
        ...body,
      }),
      { requestId: "req_test", log: logs.logger },
    );
  return { chat, stream, calls, breaker, logs };
}

async function openCircuit(breaker, provider, failures = 5) {
  for (let i = 0; i < failures; i += 1) await breaker.recordFailure(provider, STATES.CLOSED);
}

describe("gateway with a circuit breaker", () => {
  it("skips a provider whose circuit is open, without calling it", async () => {
    const { chat, calls, breaker, logs } = setup({
      replies: { gemini: [geminiOk], ollama: [ollamaOk] },
    });
    await openCircuit(breaker, "gemini");

    const { response, meta } = await chat({ model: "fast" });

    expect(calls).toEqual(["ollama"]);
    expect(response).toMatchObject({ provider: "ollama", fallbackUsed: true });
    expect(meta.attempts).toBe(1);
    expect(logs.lines.find((line) => line.msg === "Circuit open; skipping provider")).toMatchObject(
      {
        provider: "gemini",
        circuit: "open",
      },
    );
  });

  it("opens the circuit after repeated failures, so later requests skip the provider", async () => {
    const { chat, calls } = setup({
      replies: { gemini: [failure(503)], ollama: [ollamaOk] },
      breaker: { failureThreshold: 3 },
      gateway: { maxRetries: 0 },
    });

    for (let i = 0; i < 3; i += 1) await chat({ model: "fast" });
    calls.length = 0;
    await chat({ model: "fast" });

    expect(calls).toEqual(["ollama"]);
  });

  it("stops retrying a provider whose circuit opens part-way through a request", async () => {
    const { chat, calls } = setup({
      replies: { gemini: [failure(503)], ollama: [ollamaOk] },
      breaker: { failureThreshold: 2 },
    });

    await chat({ model: "fast" });

    // Two failures open the circuit, so the third try never happens.
    expect(calls).toEqual(["gemini", "gemini", "ollama"]);
  });

  it("doesn't count a 400, 401 or 404 against the provider: those aren't outages", async () => {
    const { chat, breaker } = setup({
      replies: { gemini: [failure(401), failure(404), failure(400)], ollama: [ollamaOk] },
      breaker: { failureThreshold: 1 },
    });

    await chat({ model: "fast" });
    await chat({ model: "fast" });
    await chat({ model: "fast" }).catch(() => {});

    expect((await breaker.state("gemini")).state).toBe("closed");
  });

  it("sends exactly one try to a half-open provider, and closes the circuit when it works", async () => {
    vi.useFakeTimers();
    try {
      const { chat, calls, breaker } = setup({
        replies: { gemini: [geminiOk], ollama: [ollamaOk] },
      });
      await openCircuit(breaker, "gemini");
      vi.advanceTimersByTime(30_001);

      const { response } = await chat({ model: "fast" });

      expect(calls).toEqual(["gemini"]);
      expect(response.provider).toBe("gemini");
      expect((await breaker.state("gemini")).state).toBe("closed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-opens a half-open circuit when the one test try fails, with no retry", async () => {
    vi.useFakeTimers();
    try {
      const { chat, calls, breaker } = setup({
        replies: { gemini: [failure(503)], ollama: [ollamaOk] },
      });
      await openCircuit(breaker, "gemini");
      vi.advanceTimersByTime(30_001);

      const { response } = await chat({ model: "fast" });

      expect(calls).toEqual(["gemini", "ollama"]);
      expect(response.provider).toBe("ollama");
      expect((await breaker.state("gemini")).state).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers 503 without calling anyone when every circuit in the chain is open", async () => {
    const { chat, calls, breaker } = setup({ replies: { gemini: [geminiOk], ollama: [ollamaOk] } });
    await openCircuit(breaker, "gemini");
    await openCircuit(breaker, "ollama");

    const error = await chat({ model: "fast" }).catch((err) => err);

    expect(calls).toEqual([]);
    expect(error).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      status: 503,
      retryable: true,
      provider: "ollama",
      message: "ollama is temporarily unavailable after repeated failures",
    });
  });

  it("skips open providers for streams too", async () => {
    const { stream, calls, breaker } = setup({
      replies: { gemini: [geminiOk], ollama: [ollamaOk] },
    });
    await openCircuit(breaker, "gemini");

    const events = [];
    for await (const event of stream({ model: "fast" })) events.push(event);

    expect(calls).toEqual(["ollama"]);
    expect(events[0]).toMatchObject({ type: "start", provider: "ollama" });
  });

  it("works as before when Redis is down: nothing is skipped", async () => {
    const logs = captureLogs();
    const gateway = createGateway({
      enabledProviders: new Set(["gemini"]),
      providerSettings: { gemini: { apiKey: "k" } },
      send: async () => geminiOk,
      breaker: createCircuitBreaker({ redis: fakeRedis({ failing: true }), logger: logs.logger }),
    });

    const { response } = await gateway.chat(
      ChatRequestSchema.parse({ model: "fast", messages: [{ role: "user", content: "Hi" }] }),
      { requestId: "r", log: logs.logger },
    );

    expect(response.provider).toBe("gemini");
  });
});
