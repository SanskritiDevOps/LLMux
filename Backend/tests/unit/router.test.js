import { describe, expect, it } from "vitest";
import { parseModelConfig } from "../../src/config/models.js";
import {
  DIRECT_DEFAULT_MAX_TOKENS,
  getEnabledProviders,
  maxTokensFor,
  resolveModel,
} from "../../src/gateway/router.js";
import { GatewayError } from "../../src/utils/errors.js";

const price = (input, output, maxOutputTokens = 8192) => ({
  inputPerMTok: input,
  outputPerMTok: output,
  maxOutputTokens,
});

const config = parseModelConfig({
  catalog: {
    "gemini:g-flash": price(300_000, 2_500_000),
    "ollama:llama3.2:1b": price(0, 0, 4096),
    "anthropic:claude-x": price(2_000_000, 10_000_000),
    "openai:gpt-x": price(2_000_000, 10_000_000, 512),
  },
  aliases: {
    fast: {
      description: "d",
      targets: ["gemini:g-flash", "ollama:llama3.2:1b"],
      defaultMaxTokens: 1024,
    },
    smart: {
      description: "d",
      targets: ["anthropic:claude-x", "openai:gpt-x"],
      defaultMaxTokens: 256,
    },
  },
});

const all = new Set(["gemini", "ollama", "anthropic", "openai"]);
const resolve = (name, enabledProviders = all) => resolveModel(name, { config, enabledProviders });

function expectUnknownModel(fn, message) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.code).toBe("UNKNOWN_MODEL");
    expect(err.status).toBe(400);
    expect(err.message).toMatch(message);
    return;
  }
  throw new Error("expected resolveModel to throw");
}

describe("resolveModel: aliases", () => {
  it("returns the alias's targets in fallback order", () => {
    const resolved = resolve("fast");

    expect(resolved).toMatchObject({ alias: "fast", direct: false, defaultMaxTokens: 1024 });
    expect(resolved.targets.map((t) => t.key)).toEqual(["gemini:g-flash", "ollama:llama3.2:1b"]);
  });

  it("gives each target its provider, model, pricing and cap", () => {
    expect(resolve("fast").targets[0]).toEqual({
      key: "gemini:g-flash",
      provider: "gemini",
      model: "g-flash",
      pricing: { inputPerMTok: 300_000, outputPerMTok: 2_500_000 },
      maxOutputTokens: 8192,
    });
  });

  it("splits only at the first colon, keeping Ollama tags intact", () => {
    const local = resolve("fast").targets[1];

    expect(local.provider).toBe("ollama");
    expect(local.model).toBe("llama3.2:1b");
  });

  it("skips targets whose provider is not configured", () => {
    const resolved = resolve("fast", new Set(["ollama"]));

    expect(resolved.targets.map((t) => t.key)).toEqual(["ollama:llama3.2:1b"]);
  });

  it("rejects an alias whose providers are all unconfigured", () => {
    expectUnknownModel(() => resolve("smart", new Set(["gemini"])), /none of its providers/);
  });

  it("rejects unknown aliases", () => {
    expectUnknownModel(() => resolve("fastest"), /Unknown model "fastest"/);
  });

  it("is case-sensitive", () => {
    expectUnknownModel(() => resolve("Fast"), /Unknown model/);
  });

  it.each([["constructor"], ["__proto__"], ["toString"], ["hasOwnProperty"]])(
    "does not resolve the inherited property %s",
    (name) => {
      expectUnknownModel(() => resolve(name), /Unknown model/);
    },
  );
});

describe("resolveModel: direct provider:model calls", () => {
  it("returns exactly that model with no fallback", () => {
    const resolved = resolve("ollama:llama3.2:1b");

    expect(resolved).toMatchObject({ alias: null, direct: true });
    expect(resolved.targets).toHaveLength(1);
    expect(resolved.targets[0].model).toBe("llama3.2:1b");
  });

  it("defaults to DIRECT_DEFAULT_MAX_TOKENS, capped by the model", () => {
    expect(resolve("anthropic:claude-x").defaultMaxTokens).toBe(DIRECT_DEFAULT_MAX_TOKENS);
    expect(resolve("openai:gpt-x").defaultMaxTokens).toBe(512);
  });

  it("rejects models that are not in the catalog, so every call has a known price", () => {
    expectUnknownModel(() => resolve("openai:gpt-unpriced"), /Unknown model "openai:gpt-unpriced"/);
  });

  it("rejects unknown providers", () => {
    expectUnknownModel(() => resolve("mistral:small"), /Unknown model/);
  });

  it("rejects a configured model whose provider is disabled", () => {
    expectUnknownModel(
      () => resolve("anthropic:claude-x", new Set(["gemini"])),
      /Provider "anthropic" is not configured/,
    );
  });
});

describe("maxTokensFor", () => {
  const target = { maxOutputTokens: 512 };

  it("uses the requested value when it is under the cap", () => {
    expect(maxTokensFor(target, 100, 256)).toBe(100);
  });

  it("uses the default when the client sent none", () => {
    expect(maxTokensFor(target, undefined, 256)).toBe(256);
  });

  it("clamps to the target's cap", () => {
    expect(maxTokensFor(target, 100_000, 256)).toBe(512);
  });
});

describe("getEnabledProviders", () => {
  it("enables a provider only when its key or URL is set", () => {
    const enabled = getEnabledProviders({
      GEMINI_API_KEY: "key",
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
      OLLAMA_BASE_URL: "http://localhost:11434",
    });

    expect([...enabled].sort()).toEqual(["gemini", "ollama"]);
  });

  it("enables nothing when nothing is configured", () => {
    expect(getEnabledProviders({}).size).toBe(0);
  });
});
