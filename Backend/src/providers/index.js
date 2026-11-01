import { anthropicAdapter } from "./anthropic/index.js";
import { geminiAdapter } from "./gemini/index.js";
import { groqAdapter } from "./groq/index.js";
import { ollamaAdapter } from "./ollama/index.js";
import { openaiAdapter } from "./openai/index.js";
import { createAdapterRegistry } from "./registry.js";

// Every provider LLMux can call. Adding one: write its adapter, list it here, add its key
// to config/env.js, providerSettings.js and getEnabledProviders (router.js), and its models
// to config/models.js. The gateway, routes and transports don't change.
export const providerRegistry = createAdapterRegistry([
  geminiAdapter,
  ollamaAdapter,
  openaiAdapter,
  anthropicAdapter,
  groqAdapter,
]);
