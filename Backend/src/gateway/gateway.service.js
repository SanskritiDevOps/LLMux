import { env } from "../config/env.js";
import { modelConfig } from "../config/models.js";
import { sendRequest } from "../providers/httpClient.js";
import { providerRegistry } from "../providers/index.js";
import { GatewayError } from "../utils/errors.js";
import { costBreakdown, microUsdToUsd } from "./cost.js";
import { getProviderSettings } from "./providerSettings.js";
import { getEnabledProviders, maxTokensFor, resolveModel } from "./router.js";

// Provider error bodies can be large HTML pages; logs keep the first part only.
const MAX_LOGGED_BODY_CHARS = 1000;

function truncateForLog(body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text && text.length > MAX_LOGGED_BODY_CHARS
    ? `${text.slice(0, MAX_LOGGED_BODY_CHARS)}…`
    : text;
}

/**
 * The core of LLMux: resolve the model, translate with the adapter, call the provider,
 * translate back, attach cost. It knows no provider format (only adapters do) and no
 * transport (routes turn its result into HTTP).
 *
 * Today it calls the first configured target only. Retries and fallback down the chain
 * arrive on Day 10, streaming on Day 7. Every dependency can be swapped in tests.
 */
export function createGateway({
  registry = providerRegistry,
  config = modelConfig,
  enabledProviders = getEnabledProviders(env),
  providerSettings = getProviderSettings(env),
  timeoutMs = env.REQUEST_TIMEOUT_MS,
  send = sendRequest,
} = {}) {
  /**
   * @param {import("../providers/adapter.js").UnifiedRequest} request  already validated
   * @param {{ requestId: string, signal?: AbortSignal, log: import("pino").Logger }} context
   */
  async function chat(request, { requestId, signal, log }) {
    if (request.stream) {
      throw new GatewayError(
        "INVALID_REQUEST",
        "Streaming is not supported yet; send stream: false",
      );
    }

    const started = performance.now();
    const resolved = resolveModel(request.model, { config, enabledProviders });
    const target = resolved.targets[0];
    const adapter = registry.get(target.provider);

    const providerRequest = adapter.buildRequest(request, target, {
      ...providerSettings[target.provider],
      maxTokens: maxTokensFor(target, request.maxTokens, resolved.defaultMaxTokens),
    });

    const result = await send(providerRequest, { provider: target.provider, timeoutMs, signal });
    const callLog = { provider: target.provider, model: target.model, status: result.status };

    if (!result.ok) {
      const error = adapter.mapError(result);
      // The raw body goes to the logs for debugging; the client only sees error.message.
      log.warn(
        { ...callLog, code: error.code, providerBody: truncateForLog(result.body) },
        "Provider returned an error",
      );
      throw error;
    }

    let parsed;
    try {
      parsed = adapter.parseResponse(result.body);
    } catch (error) {
      // A 200 the adapter cannot read usually means the provider changed its format;
      // the raw body in the log is what is needed to write the fixture and the fix.
      log.warn(
        { ...callLog, code: error.code, providerBody: truncateForLog(result.body) },
        "Provider response could not be parsed",
      );
      throw error;
    }
    const { costMicroUsd, savedMicroUsd } = costBreakdown(parsed.usage, target.pricing);
    const latencyMs = Math.round(performance.now() - started);

    log.info(
      {
        ...callLog,
        providerLatencyMs: result.durationMs,
        latencyMs,
        inputTokens: parsed.usage.inputTokens,
        outputTokens: parsed.usage.outputTokens,
        costMicroUsd,
      },
      "Provider call completed",
    );

    return {
      response: {
        id: requestId,
        model: request.model,
        provider: target.provider,
        providerModel: target.model,
        content: parsed.content,
        finishReason: parsed.finishReason,
        usage: parsed.usage,
        costUsd: microUsdToUsd(costMicroUsd),
        latencyMs,
        cached: false,
        fallbackUsed: false,
      },
      // For usage logging (Day 9) and response headers: not part of the client contract.
      meta: {
        alias: resolved.alias,
        target,
        attempts: 1,
        providerLatencyMs: result.durationMs,
        usageEstimated: parsed.usageEstimated,
        costMicroUsd,
        savedMicroUsd,
      },
    };
  }

  return { chat };
}
