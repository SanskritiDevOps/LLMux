import { env as defaultEnv } from "../config/env.js";
import { modelConfig } from "../config/models.js";
import { GatewayError } from "../utils/errors.js";

// Direct "provider:model" calls have no alias, so they get this default (still capped).
export const DIRECT_DEFAULT_MAX_TOKENS = 1024;

/**
 * A provider is enabled when the server has what it needs to call it: an API key,
 * or for Ollama a base URL. Disabled providers are skipped as if they did not exist.
 *
 * @returns {Set<string>}
 */
export function getEnabledProviders(env = defaultEnv) {
  const enabled = new Set();
  if (env.GEMINI_API_KEY) enabled.add("gemini");
  if (env.OPENAI_API_KEY) enabled.add("openai");
  if (env.ANTHROPIC_API_KEY) enabled.add("anthropic");
  if (env.OLLAMA_BASE_URL) enabled.add("ollama");
  return enabled;
}

function toTarget(key, config) {
  // Split at the first ":" only: Ollama model names contain ":" themselves (llama3.2:1b).
  const separator = key.indexOf(":");
  const { inputPerMTok, outputPerMTok, maxOutputTokens } = config.catalog[key];
  return {
    key,
    provider: key.slice(0, separator),
    model: key.slice(separator + 1),
    pricing: { inputPerMTok, outputPerMTok },
    maxOutputTokens,
  };
}

/**
 * Turns the request's `model` field into the ordered list of targets to try.
 * Pure apart from its defaults, and makes no network calls.
 *
 *   "fast"               → the alias's chain, minus disabled providers (fallback allowed)
 *   "ollama:llama3.2:1b" → exactly that catalog model (direct call, no fallback)
 *
 * @param {string} name
 * @param {{ config?: typeof modelConfig, enabledProviders?: Set<string> }} [options]
 */
export function resolveModel(
  name,
  { config = modelConfig, enabledProviders = getEnabledProviders() } = {},
) {
  // Object.hasOwn, not `in` or plain lookup: "constructor" or "__proto__" must not
  // resolve to properties inherited from Object.prototype.
  if (Object.hasOwn(config.aliases, name)) {
    const alias = config.aliases[name];
    const targets = alias.targets
      .map((key) => toTarget(key, config))
      .filter((target) => enabledProviders.has(target.provider));

    if (targets.length === 0) {
      throw new GatewayError(
        "UNKNOWN_MODEL",
        `Model "${name}" is not available: none of its providers are configured on this server`,
      );
    }
    return { alias: name, direct: false, defaultMaxTokens: alias.defaultMaxTokens, targets };
  }

  if (name.includes(":") && Object.hasOwn(config.catalog, name)) {
    const target = toTarget(name, config);
    if (!enabledProviders.has(target.provider)) {
      throw new GatewayError(
        "UNKNOWN_MODEL",
        `Provider "${target.provider}" is not configured on this server`,
      );
    }
    return {
      alias: null,
      direct: true,
      defaultMaxTokens: Math.min(DIRECT_DEFAULT_MAX_TOKENS, target.maxOutputTokens),
      targets: [target],
    };
  }

  throw new GatewayError(
    "UNKNOWN_MODEL",
    `Unknown model "${name}". Use an alias from GET /v1/models, or "provider:model" for a model in the catalog`,
  );
}

/**
 * The max tokens to send to one target: the client's value or the default, never more
 * than that target's cap. Computed per target because a fallback may have a lower cap.
 */
export function maxTokensFor(target, requested, defaultMaxTokens) {
  return Math.min(requested ?? defaultMaxTokens, target.maxOutputTokens);
}
