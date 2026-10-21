import { env as defaultEnv } from "../config/env.js";

/**
 * What each adapter needs from the server's environment, passed in by the gateway so
 * adapters never read env themselves. A missing baseUrl means "use the adapter's default".
 *
 * @returns {Record<string, { apiKey?: string, baseUrl?: string }>}
 */
export function getProviderSettings(env = defaultEnv) {
  return {
    gemini: { apiKey: env.GEMINI_API_KEY },
    openai: { apiKey: env.OPENAI_API_KEY },
    anthropic: { apiKey: env.ANTHROPIC_API_KEY },
    ollama: { baseUrl: env.OLLAMA_BASE_URL },
  };
}
