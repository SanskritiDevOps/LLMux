import { describe, expect, it } from "vitest";
import { modelConfig, parseModelConfig } from "../../src/config/models.js";

const entry = { inputPerMTok: 300_000, outputPerMTok: 2_500_000, maxOutputTokens: 8192 };

const valid = () => ({
  catalog: { "gemini:g-1": entry, "ollama:llama3.2:1b": { ...entry, inputPerMTok: 0 } },
  aliases: {
    fast: {
      description: "Fast",
      targets: ["gemini:g-1", "ollama:llama3.2:1b"],
      defaultMaxTokens: 1024,
    },
  },
});

describe("the shipped model configuration", () => {
  it("passes validation (it was parsed on import)", () => {
    expect(Object.keys(modelConfig.aliases)).toEqual(["fast", "smart", "local"]);
  });

  it("gives every alias a primary target and only priced targets", () => {
    for (const alias of Object.values(modelConfig.aliases)) {
      expect(alias.targets.length).toBeGreaterThan(0);
      for (const target of alias.targets) {
        expect(modelConfig.catalog[target]).toBeDefined();
      }
    }
  });

  it("prices local Ollama models at zero", () => {
    for (const [key, price] of Object.entries(modelConfig.catalog)) {
      if (key.startsWith("ollama:")) {
        expect(price).toMatchObject({ inputPerMTok: 0, outputPerMTok: 0 });
      }
    }
  });

  it("is deeply frozen so nothing can change routing at runtime", () => {
    expect(Object.isFrozen(modelConfig)).toBe(true);
    expect(Object.isFrozen(modelConfig.aliases.fast.targets)).toBe(true);
    expect(Object.isFrozen(modelConfig.catalog["ollama:llama3.2:1b"])).toBe(true);
  });
});

describe("parseModelConfig", () => {
  it("accepts a valid configuration", () => {
    expect(() => parseModelConfig(valid())).not.toThrow();
  });

  it("rejects an alias target that has no price", () => {
    const config = valid();
    config.aliases.fast.targets.push("openai:unpriced");

    expect(() => parseModelConfig(config)).toThrow(/aliases\.fast\.targets\.2.*not in the catalog/);
  });

  it("rejects an unknown provider", () => {
    const config = valid();
    config.catalog["mistral:small"] = entry;

    expect(() => parseModelConfig(config)).toThrow(/provider:model/);
  });

  it("rejects fractional prices so cost math stays in integers", () => {
    const config = valid();
    config.catalog["gemini:g-1"] = { ...entry, inputPerMTok: 0.3 };

    expect(() => parseModelConfig(config)).toThrow(/inputPerMTok/);
  });

  it("rejects a default larger than a target's output cap", () => {
    const config = valid();
    config.aliases.fast.defaultMaxTokens = 9000;

    expect(() => parseModelConfig(config)).toThrow(/defaultMaxTokens.*exceeds maxOutputTokens/);
  });

  it.each([["Fast"], ["fa:st"], ["1fast"]])("rejects the alias name %s", (name) => {
    const config = valid();
    config.aliases[name] = config.aliases.fast;

    expect(() => parseModelConfig(config)).toThrow(/alias names/);
  });

  it("rejects an alias with no targets", () => {
    const config = valid();
    config.aliases.fast.targets = [];

    expect(() => parseModelConfig(config)).toThrow(/targets/);
  });

  it("rejects duplicate targets in one chain", () => {
    const config = valid();
    config.aliases.fast.targets = ["gemini:g-1", "gemini:g-1"];

    expect(() => parseModelConfig(config)).toThrow(/same target twice/);
  });

  it("rejects unknown fields so typos in the config fail loudly", () => {
    const config = valid();
    config.aliases.fast.defaultMaxToken = 10;

    expect(() => parseModelConfig(config)).toThrow(/defaultMaxToken/);
  });
});
