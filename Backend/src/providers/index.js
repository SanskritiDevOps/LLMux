import { geminiAdapter } from "./gemini/index.js";
import { ollamaAdapter } from "./ollama/index.js";
import { openaiAdapter } from "./openai/index.js";
import { createAdapterRegistry } from "./registry.js";

// Every provider LLMux can call. Adding a provider: write its adapter, list it here,
// and add its models to config/models.js. Nothing else changes.
export const providerRegistry = createAdapterRegistry([
  geminiAdapter,
  ollamaAdapter,
  openaiAdapter,
]);
