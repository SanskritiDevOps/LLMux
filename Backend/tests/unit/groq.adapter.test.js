import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyError } from "../../src/gateway/errorPolicy.js";
import { ChatRequestSchema } from "../../src/gateway/schemas.js";
import { getEnabledProviders } from "../../src/gateway/router.js";
import { mapGroqError } from "../../src/providers/groq/errors.js";
import { groqAdapter } from "../../src/providers/groq/index.js";
import { GROQ_DEFAULT_BASE_URL, buildGroqRequest } from "../../src/providers/groq/request.js";
import { parseGroqResponse } from "../../src/providers/groq/response.js";
import { parseGroqStreamChunk } from "../../src/providers/groq/stream.js";
import { providerRegistry } from "../../src/providers/index.js";
import { GatewayError } from "../../src/utils/errors.js";
import { replayStream, streamFixture, textOf } from "../helpers/replayStream.js";

// Fixtures follow Groq's documented format; no GROQ_API_KEY was set to record real ones.
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/groq/${name}.json`, import.meta.url), "utf8"));
const replay = (name) => replayStream(groqAdapter, streamFixture("groq", name));

const target = { provider: "groq", model: "openai/gpt-oss-20b" };
const context = { apiKey: "gsk_test", maxTokens: 800 };
const unified = (fields) =>
  ChatRequestSchema.parse({
    model: "fast",
    system: "Be brief.",
    messages: [{ role: "user", content: "Plan one day in Jaipur." }],
    ...fields,
  });

describe("the Groq adapter", () => {
  it("is registered, streams over SSE, and is enabled by GROQ_API_KEY", () => {
    expect(providerRegistry.get("groq")).toBe(groqAdapter);
    expect(groqAdapter.streamFormat).toBe("sse");
    expect(getEnabledProviders({ GROQ_API_KEY: "gsk_test" })).toEqual(new Set(["groq"]));
  });
});

describe("buildGroqRequest", () => {
  it("sends OpenAI's Chat Completions format to Groq, with the key as a Bearer token", () => {
    expect(buildGroqRequest(unified({ temperature: 0.2 }), target, context)).toEqual({
      url: `${GROQ_DEFAULT_BASE_URL}/v1/chat/completions`,
      method: "POST",
      headers: { authorization: "Bearer gsk_test" },
      body: {
        model: "openai/gpt-oss-20b",
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "Plan one day in Jaipur." },
        ],
        temperature: 0.2,
        max_completion_tokens: 800,
      },
    });
    expect(GROQ_DEFAULT_BASE_URL).toBe("https://api.groq.com/openai");
  });

  it("streams without stream_options, which Groq doesn't document", () => {
    const { body } = buildGroqRequest(unified({ stream: true }), target, context);

    expect(body.stream).toBe(true);
    expect(body).not.toHaveProperty("stream_options");
  });

  it("refuses to build a request without a key, naming Groq", () => {
    expect(() => buildGroqRequest(unified({}), target, { maxTokens: 10 })).toThrow(
      "groq request built without an API key",
    );
  });
});

describe("parseGroqResponse", () => {
  it("reads the answer and usage, leaving out the reasoning and Groq's timing fields", () => {
    expect(parseGroqResponse(fixture("success"))).toEqual({
      content: "Morning: Amber Fort. Afternoon: City Palace.",
      finishReason: "stop",
      usage: { inputTokens: 18, outputTokens: 56, totalTokens: 74 },
      usageEstimated: false,
    });
  });

  it("names Groq when a response can't be read", () => {
    expect(() => parseGroqResponse({ choices: [] })).toThrow(
      expect.objectContaining({ code: "PROVIDER_ERROR", provider: "groq" }),
    );
  });
});

describe("Groq stream parsing", () => {
  it.each(["stream-usage-top-level.sse", "stream-usage-x-groq.sse"])(
    "reads deltas, the finish and usage from %s",
    async (name) => {
      const events = await replay(name);

      expect(textOf(events)).toBe("Morning: Amber Fort.");
      expect(events.find((event) => event.type === "finish").finishReason).toBe("stop");
      expect(events.find((event) => event.type === "usage").usage).toEqual({
        inputTokens: 12,
        outputTokens: 9,
        totalTokens: 21,
      });
    },
  );

  it("gives no usage event when the stream carries none, so the gateway estimates it", async () => {
    const events = await replay("stream-no-usage.sse");

    expect(textOf(events)).toBe("Morning: Amber Fort.");
    expect(events.some((event) => event.type === "usage")).toBe(false);
  });

  it("maps an error event as Groq's, without its text", () => {
    const error = (() => {
      try {
        parseGroqStreamChunk('{"error":{"message":"internal failure","type":"server_error"}}');
      } catch (err) {
        return err;
      }
    })();

    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({ code: "PROVIDER_ERROR", provider: "groq", retryable: true });
    expect(error.message).not.toContain("internal failure");
  });

  it("rejects broken JSON as an unreadable Groq stream", () => {
    expect(() => parseGroqStreamChunk('{"choices": [')).toThrow(
      expect.objectContaining({ code: "PROVIDER_ERROR", provider: "groq" }),
    );
  });
});

describe("mapGroqError", () => {
  it.each([
    [
      401,
      "error-invalid-key-401",
      "PROVIDER_ERROR",
      false,
      { retry: false, fallback: true, alert: true },
    ],
    [
      400,
      "error-invalid-request-400",
      "INVALID_REQUEST",
      false,
      { retry: false, fallback: false, alert: false },
    ],
    [
      429,
      "error-rate-limited-429",
      "PROVIDER_RATE_LIMITED",
      true,
      { retry: true, fallback: true, alert: false },
    ],
    // Groq's own status for "over capacity, try again later".
    [
      498,
      "error-capacity-498",
      "PROVIDER_UNAVAILABLE",
      true,
      { retry: true, fallback: true, alert: false },
    ],
  ])(
    "maps %i to %s, with the right retry and fallback",
    (status, name, code, retryable, decision) => {
      const error = mapGroqError({ status, body: fixture(name) });

      expect(error).toMatchObject({ code, retryable, provider: "groq", providerStatus: status });
      expect(classifyError(error)).toEqual(decision);
      expect(error.message).not.toContain(fixture(name).error.message);
    },
  );
});
