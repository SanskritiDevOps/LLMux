import { describe, expect, it } from "vitest";
import {
  ChatRequestSchema,
  ChatResponseSchema,
  MAX_MESSAGES,
  StreamEventSchema,
} from "../../src/gateway/schemas.js";

const minimal = { model: "fast", messages: [{ role: "user", content: "Hello" }] };

const issuePaths = (result) => result.error.issues.map((issue) => issue.path.join("."));

describe("ChatRequestSchema", () => {
  it("accepts the README example", () => {
    const result = ChatRequestSchema.safeParse({
      model: "fast",
      system: "You are a helpful travel assistant.",
      messages: [{ role: "user", content: "Plan one day in Jaipur." }],
      temperature: 0.7,
      maxTokens: 800,
      stream: false,
      cache: true,
      metadata: { app: "trip-planner" },
    });

    expect(result.success).toBe(true);
  });

  it("fills in defaults for optional fields", () => {
    expect(ChatRequestSchema.parse(minimal)).toEqual({
      ...minimal,
      temperature: 0.7,
      stream: false,
      cache: true,
    });
  });

  it("trims the model name", () => {
    expect(ChatRequestSchema.parse({ ...minimal, model: "  fast " }).model).toBe("fast");
  });

  it("rejects unknown fields such as provider-style max_tokens", () => {
    const result = ChatRequestSchema.safeParse({ ...minimal, max_tokens: 100 });

    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toContain("max_tokens");
  });

  it.each([
    ["a missing model", { messages: minimal.messages }, "model"],
    ["an empty model", { ...minimal, model: "  " }, "model"],
    ["no messages", { model: "fast", messages: [] }, "messages"],
    [
      "a system role inside messages",
      { model: "fast", messages: [{ role: "system", content: "x" }] },
      "messages.0.role",
    ],
    [
      "empty message content",
      { model: "fast", messages: [{ role: "user", content: "" }] },
      "messages.0.content",
    ],
    ["temperature above 2", { ...minimal, temperature: 2.5 }, "temperature"],
    ["negative temperature", { ...minimal, temperature: -0.1 }, "temperature"],
    ["fractional maxTokens", { ...minimal, maxTokens: 10.5 }, "maxTokens"],
    ["zero maxTokens", { ...minimal, maxTokens: 0 }, "maxTokens"],
    ["a string stream flag", { ...minimal, stream: "true" }, "stream"],
    ["nested metadata", { ...minimal, metadata: { app: { name: "x" } } }, "metadata.app"],
  ])("rejects %s", (_label, body, path) => {
    const result = ChatRequestSchema.safeParse(body);

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain(path);
  });

  it(`rejects more than ${MAX_MESSAGES} messages`, () => {
    const messages = Array.from({ length: MAX_MESSAGES + 1 }, () => ({
      role: "user",
      content: "hi",
    }));

    expect(ChatRequestSchema.safeParse({ model: "fast", messages }).success).toBe(false);
  });

  it("rejects more than 20 metadata keys", () => {
    const metadata = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i]));

    expect(ChatRequestSchema.safeParse({ ...minimal, metadata }).success).toBe(false);
  });

  it("accepts a provider:model direct call as the model", () => {
    expect(ChatRequestSchema.safeParse({ ...minimal, model: "ollama:llama3.2:1b" }).success).toBe(
      true,
    );
  });
});

describe("ChatResponseSchema", () => {
  const response = {
    id: "req_8f2c1a",
    model: "fast",
    provider: "gemini",
    providerModel: "gemini-3.5-flash-lite",
    content: "Morning: Amber Fort...",
    finishReason: "stop",
    usage: { inputTokens: 42, outputTokens: 310, totalTokens: 352 },
    costUsd: 0.000105,
    latencyMs: 1830,
    cached: false,
    fallbackUsed: false,
  };

  it("accepts the README example response", () => {
    expect(ChatResponseSchema.safeParse(response).success).toBe(true);
  });

  it("only allows the four normalized finish reasons", () => {
    expect(ChatResponseSchema.safeParse({ ...response, finishReason: "end_turn" }).success).toBe(
      false,
    );
  });
});

describe("StreamEventSchema", () => {
  it.each([
    { type: "start", id: "req_1", model: "fast", provider: "gemini" },
    { type: "delta", text: "Morning: " },
    {
      type: "end",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      latencyMs: 10,
    },
    {
      type: "end",
      finishReason: "length",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      usageEstimated: true,
      latencyMs: 10,
    },
    { type: "error", code: "PROVIDER_ERROR", message: "Upstream failed" },
  ])("accepts a $type event", (event) => {
    expect(StreamEventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects unknown event types", () => {
    expect(StreamEventSchema.safeParse({ type: "progress", text: "x" }).success).toBe(false);
  });

  it("rejects an event with fields from another type", () => {
    expect(
      StreamEventSchema.safeParse({ type: "delta", text: "x", provider: "gemini" }).success,
    ).toBe(false);
  });
});
