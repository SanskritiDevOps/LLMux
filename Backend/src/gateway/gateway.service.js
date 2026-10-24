import { env } from "../config/env.js";
import { modelConfig } from "../config/models.js";
import { openStream as openProviderStream, sendRequest } from "../providers/httpClient.js";
import { providerRegistry } from "../providers/index.js";
import { readStreamPayloads } from "../providers/streamReader.js";
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

// A rough, provider-neutral rule (about 4 characters per token for English), used only
// when a stream ends without usage figures. Results are flagged usageEstimated.
const CHARS_PER_TOKEN = 4;

function estimateUsage(request, outputChars) {
  const promptChars =
    (request.system?.length ?? 0) +
    request.messages.reduce((sum, message) => sum + message.content.length, 0);
  const inputTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);
  const outputTokens = Math.ceil(outputChars / CHARS_PER_TOKEN);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

/**
 * The core of LLMux: resolve the model, translate with the adapter, call the provider,
 * translate back, attach cost. It knows no provider format (only adapters do) and no
 * transport (routes turn its result into HTTP).
 *
 * Today it calls the first configured target only. Retries and fallback down the chain
 * arrive on Day 10. Every dependency can be swapped in tests.
 */
export function createGateway({
  registry = providerRegistry,
  config = modelConfig,
  enabledProviders = getEnabledProviders(env),
  providerSettings = getProviderSettings(env),
  timeoutMs = env.REQUEST_TIMEOUT_MS,
  send = sendRequest,
  openStream = openProviderStream,
} = {}) {
  /** Resolves the model and builds the provider request; shared by chat and stream. */
  function prepare(request) {
    const resolved = resolveModel(request.model, { config, enabledProviders });
    const target = resolved.targets[0];
    const adapter = registry.get(target.provider);
    const providerRequest = adapter.buildRequest(request, target, {
      ...providerSettings[target.provider],
      maxTokens: maxTokensFor(target, request.maxTokens, resolved.defaultMaxTokens),
    });
    return { resolved, target, adapter, providerRequest };
  }

  /** A non-2xx from the provider: log its raw body, return the unified error to throw. */
  function providerFailure(adapter, result, callLog, log) {
    const error = adapter.mapError(result);
    // The raw body goes to the logs for debugging; the client only sees error.message.
    log.warn(
      { ...callLog, code: error.code, providerBody: truncateForLog(result.body) },
      "Provider returned an error",
    );
    return error;
  }

  /**
   * @param {import("../providers/adapter.js").UnifiedRequest} request  already validated
   * @param {{ requestId: string, signal?: AbortSignal, log: import("pino").Logger }} context
   */
  async function chat(request, { requestId, signal, log }) {
    if (request.stream) {
      // The route sends streaming requests to stream(); reaching this is a bug.
      throw new TypeError("gateway.chat() does not stream; use gateway.stream()");
    }

    const started = performance.now();
    const { resolved, target, adapter, providerRequest } = prepare(request);

    const result = await send(providerRequest, { provider: target.provider, timeoutMs, signal });
    const callLog = { provider: target.provider, model: target.model, status: result.status };

    if (!result.ok) {
      throw providerFailure(adapter, result, callLog, log);
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

  /**
   * Streams one request as unified events: start, then delta…, then end.
   *
   * Nothing is yielded until the provider has accepted the stream (a 2xx with headers), so
   * a failure up to that point (unknown model, provider error, timeout) is thrown before
   * the first event and the route can still answer with a normal HTTP error. A failure
   * after `start` is thrown mid-iteration; the route turns it into an `error` event,
   * because the status line has already been sent. Stopping the iteration early (the
   * client left) cancels the provider request.
   *
   * @param {import("../providers/adapter.js").UnifiedRequest} request  already validated
   * @param {{ requestId: string, signal?: AbortSignal, log: import("pino").Logger }} context
   * @returns {AsyncGenerator<import("zod").infer<typeof import("./schemas.js").StreamEventSchema>>}
   */
  async function* stream(request, { requestId, signal, log }) {
    const started = performance.now();
    const { target, adapter, providerRequest } = prepare({ ...request, stream: true });
    if (!adapter.parseStreamChunk) {
      throw new GatewayError(
        "INVALID_REQUEST",
        `${target.provider} does not support streaming yet; send stream: false`,
      );
    }

    // Aborted in `finally`, so the provider connection closes however the iteration ends,
    // even if the consumer stops right after `start`, before any chunk was read.
    const cancel = new AbortController();
    try {
      const result = await openStream(providerRequest, {
        provider: target.provider,
        timeoutMs,
        signal: signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal,
      });
      const callLog = { provider: target.provider, model: target.model, status: result.status };
      if (!result.ok) {
        throw providerFailure(adapter, result, callLog, log);
      }

      yield { type: "start", id: requestId, model: request.model, provider: target.provider };
      yield* relay(request, { started, target, adapter, result, callLog, log });
    } finally {
      cancel.abort();
    }
  }

  /** The body of stream(): provider payloads → delta events, then the final end event. */
  async function* relay(request, { started, target, adapter, result, callLog, log }) {
    let usage;
    let finishReason;
    let outputChars = 0;
    let timeToFirstTokenMs;
    for await (const payload of readStreamPayloads(result.chunks, adapter.streamFormat)) {
      let events;
      try {
        events = adapter.parseStreamChunk(payload);
      } catch (error) {
        log.warn(
          { ...callLog, code: error.code, providerBody: truncateForLog(payload) },
          "Provider stream failed",
        );
        throw error;
      }

      for (const event of events) {
        if (event.type === "delta") {
          timeToFirstTokenMs ??= Math.round(performance.now() - started);
          outputChars += event.text.length;
          yield { type: "delta", text: event.text };
        } else if (event.type === "usage") {
          usage = event.usage;
        } else if (event.type === "finish") {
          finishReason = event.finishReason;
        }
      }
    }

    if (!finishReason) {
      // The connection closed cleanly but the provider never said the answer was done,
      // so the client may have a truncated answer.
      log.warn(callLog, "Provider stream ended without finishing");
      throw new GatewayError(
        "PROVIDER_ERROR",
        `${target.provider} ended the stream before the answer was complete`,
        { provider: target.provider, retryable: true },
      );
    }

    const usageEstimated = usage === undefined;
    const finalUsage = usage ?? estimateUsage(request, outputChars);
    const { costMicroUsd } = costBreakdown(finalUsage, target.pricing);
    const latencyMs = Math.round(performance.now() - started);

    log.info(
      {
        ...callLog,
        streamed: true,
        latencyMs,
        timeToFirstTokenMs,
        inputTokens: finalUsage.inputTokens,
        outputTokens: finalUsage.outputTokens,
        usageEstimated,
        costMicroUsd,
      },
      "Provider stream completed",
    );

    yield {
      type: "end",
      finishReason,
      usage: finalUsage,
      ...(usageEstimated && { usageEstimated: true }),
      latencyMs,
    };
  }

  return { chat, stream };
}
