import { describe, expect, it } from "vitest";
import { modelConfig, parseModelConfig } from "../../src/config/models.js";
import { listModels } from "../../src/gateway/catalog.js";

const price = { inputPerMTok: 1, outputPerMTok: 1, maxOutputTokens: 4096 };
const config = parseModelConfig({
  catalog: {
    "gemini:g": price,
    "gemini:g-pro": price,
    "ollama:llama3.2:1b": { ...price, inputPerMTok: 0, outputPerMTok: 0 },
    "openai:o": price,
  },
  aliases: {
    fast: {
      description: "Fast",
      targets: ["gemini:g", "ollama:llama3.2:1b"],
      defaultMaxTokens: 1024,
    },
    pro: {
      description: "Pro",
      targets: ["openai:o", "gemini:g-pro", "gemini:g"],
      defaultMaxTokens: 2048,
    },
    paid: { description: "Paid only", targets: ["openai:o"], defaultMaxTokens: 512 },
  },
});

const list = (...enabled) => listModels({ config, enabledProviders: new Set(enabled) });

describe("listModels", () => {
  it("lists aliases with the providers that can answer them, in fallback order", () => {
    expect(list("gemini", "ollama", "openai").models).toEqual([
      { id: "fast", description: "Fast", providers: ["gemini", "ollama"], defaultMaxTokens: 1024 },
      { id: "pro", description: "Pro", providers: ["openai", "gemini"], defaultMaxTokens: 2048 },
      { id: "paid", description: "Paid only", providers: ["openai"], defaultMaxTokens: 512 },
    ]);
  });

  it("hides providers that have no key", () => {
    const fast = list("ollama").models.find((model) => model.id === "fast");

    expect(fast.providers).toEqual(["ollama"]);
  });

  it("hides aliases that no configured provider can answer", () => {
    expect(list("ollama").models.map((model) => model.id)).toEqual(["fast"]);
  });

  it("lists nothing when no provider is configured", () => {
    expect(list().models).toEqual([]);
  });

  it("never reveals provider model IDs", () => {
    expect(JSON.stringify(list("gemini", "ollama", "openai"))).not.toMatch(/g-pro|llama3\.2/);
  });

  it("works with the shipped configuration", () => {
    const ids = listModels({
      config: modelConfig,
      enabledProviders: new Set(["ollama"]),
    }).models.map((model) => model.id);

    expect(ids).toEqual(["fast", "local"]);
  });
});
