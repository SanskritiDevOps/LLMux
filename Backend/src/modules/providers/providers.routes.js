import { Router } from "express";
import { PROVIDERS, modelConfig } from "../../config/models.js";
import { requireSession } from "../../middleware/jwtAuth.js";

export const HEALTH_WINDOW_MINUTES = 15;

/**
 * Provider health for the dashboard, mounted at /api/providers.
 *
 *   GET /health  → 200 { windowMinutes, providers: [{ provider, configured, models,
 *                          circuit, recent: { requests, errors, errorRate, p50LatencyMs } }] }
 *
 * `configured` says whether the server has the provider's key (or URL, for Ollama);
 * `models` are the provider's models in the catalog (config/models.js);
 * `circuit` is the breaker's live state; `recent` covers the last 15 minutes of everyone's
 * traffic, since a provider's health doesn't depend on who calls it. Only rates and counts
 * are shown, never other users' requests.
 *
 * @param {{ users: object, breaker: { state: (provider: string) => Promise<object> },
 *   enabledProviders: Set<string>,
 *   usageQueries: { providerStats: (since: Date) => Promise<Map<string, object>> } }} deps
 */
export function providersRoutes({ users, breaker, enabledProviders, usageQueries }) {
  const router = Router();

  router.use(requireSession({ users }));

  router.get("/health", async (_req, res) => {
    const since = new Date(Date.now() - HEALTH_WINDOW_MINUTES * 60_000);
    const [stats, circuits] = await Promise.all([
      usageQueries.providerStats(since),
      Promise.all(PROVIDERS.map((provider) => breaker.state(provider))),
    ]);

    res.json({
      windowMinutes: HEALTH_WINDOW_MINUTES,
      providers: PROVIDERS.map((provider, i) => ({
        provider,
        configured: enabledProviders.has(provider),
        models: modelsOf(provider),
        circuit: circuits[i],
        recent: stats.get(provider) ?? {
          requests: 0,
          errors: 0,
          errorRate: 0,
          p50LatencyMs: null,
        },
      })),
    });
  });

  return router;
}

function modelsOf(provider) {
  const prefix = `${provider}:`;
  return Object.keys(modelConfig.catalog)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
}
