import { describe, expect, it } from "vitest";
import { parseEnv } from "../../src/config/env.js";

const required = {
  DATABASE_URL: "postgresql://llmux:llmux@localhost:5432/llmux",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "x".repeat(32),
};

describe("parseEnv", () => {
  it("applies defaults when only required variables are set", () => {
    const env = parseEnv(required);

    expect(env).toMatchObject({
      NODE_ENV: "development",
      PORT: 5000,
      DEFAULT_RATE_LIMIT_PER_MIN: 60,
      MAX_RETRIES: 2,
      CACHE_ONLY_DETERMINISTIC: true,
      MAX_BODY_SIZE: "1mb",
      LOG_LEVEL: "info",
      TRUST_PROXY: 0,
    });
  });

  it("accepts a proxy hop count and rejects nonsense", () => {
    expect(parseEnv({ ...required, TRUST_PROXY: "1" }).TRUST_PROXY).toBe(1);
    expect(() => parseEnv({ ...required, TRUST_PROXY: "yes" })).toThrow(/TRUST_PROXY/);
    expect(() => parseEnv({ ...required, TRUST_PROXY: "-1" })).toThrow(/TRUST_PROXY/);
  });

  it("coerces numbers and parses booleans strictly", () => {
    const env = parseEnv({ ...required, PORT: "8080", CACHE_ONLY_DETERMINISTIC: "false" });

    expect(env.PORT).toBe(8080);
    expect(env.CACHE_ONLY_DETERMINISTIC).toBe(false);
  });

  it("treats empty provider keys as unset so the provider is disabled", () => {
    const env = parseEnv({ ...required, GEMINI_API_KEY: "", OPENAI_API_KEY: "   " });

    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("returns a frozen object", () => {
    expect(Object.isFrozen(parseEnv(required))).toBe(true);
  });

  it("names every missing required variable", () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL[\s\S]*REDIS_URL[\s\S]*JWT_SECRET/);
  });

  it.each([
    ["DATABASE_URL", "mysql://localhost/llmux"],
    ["REDIS_URL", "http://localhost:6379"],
    ["PORT", "70000"],
    ["CACHE_ONLY_DETERMINISTIC", "yes"],
    ["MAX_BODY_SIZE", "lots"],
    ["LOG_LEVEL", "verbose"],
  ])("rejects an invalid %s", (name, value) => {
    expect(() => parseEnv({ ...required, [name]: value })).toThrow(name);
  });

  it("rejects a short JWT secret", () => {
    expect(() => parseEnv({ ...required, JWT_SECRET: "change-me" })).toThrow(/JWT_SECRET.*32/);
  });

  it("rejects a per-attempt timeout longer than the overall deadline", () => {
    expect(() =>
      parseEnv({ ...required, REQUEST_TIMEOUT_MS: "90000", REQUEST_DEADLINE_MS: "60000" }),
    ).toThrow("REQUEST_TIMEOUT_MS");
  });

  it("never includes secret values in error messages", () => {
    const secret = "short-secret-value";

    expect(() => parseEnv({ ...required, JWT_SECRET: secret })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(secret) }),
    );
  });
});
