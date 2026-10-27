import { describe, expect, it } from "vitest";
import {
  cacheKey,
  canonicalJson,
  isCacheable,
  normalizeForCache,
} from "../../src/gateway/cacheKey.js";
import { ChatRequestSchema } from "../../src/gateway/schemas.js";

// Requests go through the real schema first, as they do in the route, so defaults
// (temperature 0.7, cache true, stream false) are filled in exactly as in production.
const request = (fields) =>
  ChatRequestSchema.parse({
    model: "fast",
    temperature: 0,
    messages: [{ role: "user", content: "Plan one day in Jaipur." }],
    ...fields,
  });
const key = (fields, scope = "user-1") => cacheKey(request(fields), { scope });

describe("cacheKey", () => {
  it("looks like cache:v1:<sha256>", () => {
    expect(key({})).toMatch(/^cache:v1:[0-9a-f]{64}$/);
  });

  it("is the same for the same request", () => {
    expect(key({})).toBe(key({}));
  });

  it("ignores surrounding whitespace in the system prompt and messages", () => {
    expect(key({ system: "  Be brief.\n", messages: [{ role: "user", content: " Hi " }] })).toBe(
      key({ system: "Be brief.", messages: [{ role: "user", content: "Hi" }] }),
    );
  });

  it("ignores fields that don't change the answer: metadata and cache", () => {
    expect(key({ metadata: { app: "trip-planner", run: 7 } })).toBe(key({}));
    expect(key({ cache: true })).toBe(key({}));
  });

  it("doesn't depend on the order of the request's fields", () => {
    const a = ChatRequestSchema.parse({
      temperature: 0,
      messages: [{ content: "Hi", role: "user" }],
      model: "fast",
    });
    const b = ChatRequestSchema.parse({
      model: "fast",
      messages: [{ role: "user", content: "Hi" }],
      temperature: 0,
    });

    expect(cacheKey(a, { scope: "u" })).toBe(cacheKey(b, { scope: "u" }));
  });

  it.each([
    ["the model", { model: "local" }],
    ["the system prompt", { system: "Be brief." }],
    ["a message", { messages: [{ role: "user", content: "Plan two days in Jaipur." }] }],
    ["a role", { messages: [{ role: "assistant", content: "Plan one day in Jaipur." }] }],
    [
      "the message order",
      {
        messages: [
          { role: "assistant", content: "B" },
          { role: "user", content: "A" },
        ],
      },
    ],
    ["the temperature", { temperature: 0.2 }],
    ["maxTokens", { maxTokens: 50 }],
    ["case inside the text", { messages: [{ role: "user", content: "plan one day in jaipur." }] }],
  ])("changes with %s", (_label, fields) => {
    expect(key(fields)).not.toBe(key({}));
  });

  it("keeps message order significant", () => {
    const ab = key({
      messages: [
        { role: "user", content: "A" },
        { role: "assistant", content: "B" },
      ],
    });
    const ba = key({
      messages: [
        { role: "assistant", content: "B" },
        { role: "user", content: "A" },
      ],
    });

    expect(ab).not.toBe(ba);
  });

  it("is different for each account, so customers never share answers", () => {
    expect(key({}, "user-1")).not.toBe(key({}, "user-2"));
  });

  it("never contains the prompt itself", () => {
    expect(key({ messages: [{ role: "user", content: "my secret plan" }] })).not.toContain(
      "secret",
    );
  });
});

describe("normalizeForCache", () => {
  it("keeps only what decides the answer, with defaults filled in", () => {
    expect(normalizeForCache(request({ metadata: { app: "x" } }), { scope: "user-1" })).toEqual({
      scope: "user-1",
      model: "fast",
      system: null,
      messages: [{ role: "user", content: "Plan one day in Jaipur." }],
      temperature: 0,
      maxTokens: null,
    });
  });

  it("treats a system prompt of only whitespace as none", () => {
    expect(normalizeForCache(request({ system: "   " }), { scope: "u" }).system).toBeNull();
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,1]},"b":1}',
    );
  });

  it("escapes strings like JSON", () => {
    expect(canonicalJson({ text: 'say "hi"\n' })).toBe('{"text":"say \\"hi\\"\\n"}');
  });
});

describe("isCacheable", () => {
  it("allows a deterministic request (temperature 0)", () => {
    expect(isCacheable(request({}), { onlyDeterministic: true })).toBe(true);
  });

  it("refuses temperature above 0 by default, since the client asked for variety", () => {
    expect(isCacheable(request({ temperature: 0.7 }), { onlyDeterministic: true })).toBe(false);
    expect(isCacheable(request({ temperature: undefined }), { onlyDeterministic: true })).toBe(
      false,
    );
  });

  it("allows any temperature when CACHE_ONLY_DETERMINISTIC is false", () => {
    expect(isCacheable(request({ temperature: 0.7 }), { onlyDeterministic: false })).toBe(true);
  });

  it("refuses a request that opted out with cache: false", () => {
    expect(isCacheable(request({ cache: false }), { onlyDeterministic: false })).toBe(false);
  });

  it("refuses streams (served live, never from the cache)", () => {
    expect(isCacheable(request({ stream: true }), { onlyDeterministic: false })).toBe(false);
  });

  it("follows CACHE_ONLY_DETERMINISTIC (true in tests) when not told", () => {
    expect(isCacheable(request({ temperature: 0.7 }))).toBe(false);
  });
});
