import { modelConfig } from "../config/models.js";
import { getEnabledProviders } from "./router.js";

/**
 * The model aliases a client can use right now, for GET /v1/models.
 *
 * - An alias is listed only if at least one of its providers is configured on this
 *   server; a provider with no key is hidden (README section 25).
 * - Only provider names are shown, never provider model IDs: aliases are the contract,
 *   and the server can change what sits behind them without telling clients.
 * - Direct "provider:model" names are not listed; they are an escape hatch, not the API.
 */
export function listModels({
  config = modelConfig,
  enabledProviders = getEnabledProviders(),
} = {}) {
  const models = [];

  for (const [id, alias] of Object.entries(config.aliases)) {
    const providers = [];
    for (const key of alias.targets) {
      const provider = key.slice(0, key.indexOf(":"));
      if (enabledProviders.has(provider) && !providers.includes(provider)) {
        providers.push(provider);
      }
    }
    if (providers.length > 0) {
      models.push({
        id,
        description: alias.description,
        providers,
        defaultMaxTokens: alias.defaultMaxTokens,
      });
    }
  }

  return { models };
}
