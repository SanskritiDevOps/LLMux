import { describe, expect, it } from "vitest";
import { defineAdapter, errorFromStatus } from "../../src/providers/adapter.js";
import { createAdapterRegistry } from "../../src/providers/registry.js";
import { GatewayError } from "../../src/utils/errors.js";

const fakeAdapter = (overrides = {}) => ({
  name: "gemini",
  defaultBaseUrl: "https://example.test",
  buildRequest: () => ({}),
  parseResponse: () => ({}),
  mapError: () => new GatewayError("PROVIDER_ERROR", "x"),
  ...overrides,
});

describe("defineAdapter", () => {
  it("returns a frozen copy of a valid adapter", () => {
    const adapter = defineAdapter(fakeAdapter());

    expect(adapter.name).toBe("gemini");
    expect(Object.isFrozen(adapter)).toBe(true);
  });

  it("allows an adapter without streaming", () => {
    expect(defineAdapter(fakeAdapter()).parseStreamChunk).toBeUndefined();
  });

  it("accepts a streaming adapter that names its stream format", () => {
    expect(() =>
      defineAdapter(fakeAdapter({ parseStreamChunk: () => [], streamFormat: "ndjson" })),
    ).not.toThrow();
  });

  it.each([
    ["an unknown provider name", { name: "mistral" }, /name must be one of/],
    ["a missing base URL", { defaultBaseUrl: undefined }, /defaultBaseUrl/],
    ["an invalid base URL", { defaultBaseUrl: "not a url" }, /defaultBaseUrl/],
    ["a missing buildRequest", { buildRequest: undefined }, /missing buildRequest/],
    ["a missing parseResponse", { parseResponse: undefined }, /missing parseResponse/],
    ["a missing mapError", { mapError: "nope" }, /missing mapError/],
    ["a non-function parseStreamChunk", { parseStreamChunk: {} }, /parseStreamChunk/],
    ["parseStreamChunk without a streamFormat", { parseStreamChunk: () => [] }, /streamFormat/],
    [
      "an unknown streamFormat",
      { parseStreamChunk: () => [], streamFormat: "websocket" },
      /streamFormat must be one of sse, ndjson/,
    ],
  ])("rejects %s", (_label, overrides, message) => {
    expect(() => defineAdapter(fakeAdapter(overrides))).toThrow(message);
  });
});

describe("errorFromStatus", () => {
  it.each([
    [400, "INVALID_REQUEST", false],
    [401, "PROVIDER_ERROR", false],
    [402, "PROVIDER_ERROR", false],
    [403, "PROVIDER_ERROR", false],
    [404, "PROVIDER_ERROR", false],
    [408, "TIMEOUT", true],
    [409, "PROVIDER_ERROR", false],
    [429, "PROVIDER_RATE_LIMITED", true],
    [500, "PROVIDER_ERROR", true],
    [502, "PROVIDER_ERROR", true],
    [503, "PROVIDER_UNAVAILABLE", true],
    [504, "TIMEOUT", true],
  ])("maps %i to %s (retryable: %s)", (status, code, retryable) => {
    const error = errorFromStatus("gemini", status);

    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({ code, retryable, provider: "gemini" });
  });

  it("names the provider but never includes provider response text", () => {
    expect(errorFromStatus("openai", 500).message).toBe("openai returned a server error (500)");
  });
});

describe("createAdapterRegistry", () => {
  const gemini = defineAdapter(fakeAdapter());
  const ollama = defineAdapter(fakeAdapter({ name: "ollama" }));

  it("finds adapters by provider name", () => {
    const registry = createAdapterRegistry([gemini, ollama]);

    expect(registry.get("ollama")).toBe(ollama);
    expect(registry.has("gemini")).toBe(true);
    expect(registry.has("openai")).toBe(false);
    expect(registry.names()).toEqual(["gemini", "ollama"]);
  });

  it("throws for a provider with no adapter", () => {
    expect(() => createAdapterRegistry([gemini]).get("openai")).toThrow(/No adapter registered/);
  });

  it("refuses the same provider twice", () => {
    expect(() => createAdapterRegistry([gemini, gemini])).toThrow(/registered twice/);
  });
});
