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

const NO_USAGE = Object.freeze({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });

/**
 * What a request did, for the usage log, whatever its outcome. The gateway passes it to
 * `context.onFinish` exactly once per chat() or stream(), on success, failure or cancel.
 *
 * @typedef {Object} CallSummary
 * @property {string | null} alias  null for a direct provider:model call, or an unknown model
 * @property {{ provider: string, model: string } | null} target  null if no provider was chosen
 * @property {{ inputTokens: number, outputTokens: number, totalTokens: number }} usage
 * @property {boolean} usageEstimated
 * @property {number} costMicroUsd
 * @property {number} savedMicroUsd
 * @property {number} attempts
 * @property {boolean} fallbackUsed
 * @property {boolean} cached
 * @property {number | null} providerLatencyMs  until the answer (JSON) or the headers (stream)
 * @property {number | null} timeToFirstTokenMs  streams only
 */
function emptySummary() {
  return {
    alias: null,
    target: null,
    usage: NO_USAGE,
    usageEstimated: false,
    costMicroUsd: 0,
    savedMicroUsd: 0,
    attempts: 1,
    fallbackUsed: false,
    cached: false,
    providerLatencyMs: null,
    timeToFirstTokenMs: null,
  };
}

/** The provider's figures when it sent them, otherwise an estimate. */
function finalUsage(request, progress) {
  return progress.usage
    ? { usage: progress.usage, usageEstimated: false }
    : { usage: estimateUsage(request, progress.outputChars), usageEstimated: true };
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

  /** Records which provider a request went to, as soon as it is known. */
  function chosen(summary, resolved, target) {
    summary.alias = resolved.alias;
    summary.target = { provider: target.provider, model: target.model };
  }

  /**
   * @typedef {{ requestId: string, signal?: AbortSignal, log: import("pino").Logger,
   *   onFinish?: (summary: CallSummary) => void }} CallContext
   */

  /**
   * @param {import("../providers/adapter.js").UnifiedRequest} request  already validated
   * @param {CallContext} context
   */
  async function chat(request, { requestId, signal, log, onFinish }) {
    if (request.stream) {
      // The route sends streaming requests to stream(); reaching this is a bug.
      throw new TypeError("gateway.chat() does not stream; use gateway.stream()");
    }

    const summary = emptySummary();
    try {
      return await answer(request, { requestId, signal, log, summary });
    } finally {
      onFinish?.(summary);
    }
  }

  /** The body of chat(); fills in `summary` as it goes. */
  async function answer(request, { requestId, signal, log, summary }) {
    const started = performance.now();
    const { resolved, target, adapter, providerRequest } = prepare(request);
    chosen(summary, resolved, target);

    const result = await send(providerRequest, { provider: target.provider, timeoutMs, signal });
    summary.providerLatencyMs = result.durationMs;
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
    Object.assign(summary, {
      usage: parsed.usage,
      usageEstimated: parsed.usageEstimated,
      costMicroUsd,
      savedMicroUsd,
    });

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
   * The usage summary passed to `context.onFinish` covers streams that end early too: once
   * the provider has accepted the stream, the tokens used so far are counted (estimated
   * when the provider hadn't sent figures yet), because the provider bills them anyway.
   *
   * @param {import("../providers/adapter.js").UnifiedRequest} request  already validated
   * @param {CallContext} context
   * @returns {AsyncGenerator<import("zod").infer<typeof import("./schemas.js").StreamEventSchema>>}
   */
  async function* stream(request, { requestId, signal, log, onFinish }) {
    const started = performance.now();
    const summary = emptySummary();
    // Shared with relay(), so `finally` can see how far the stream got.
    const progress = {
      accepted: false,
      usage: undefined,
      outputChars: 0,
      timeToFirstTokenMs: null,
    };
    let target;
    // Aborted in `finally`, so the provider connection closes however the iteration ends,
    // even if the consumer stops right after `start`, before any chunk was read.
    const cancel = new AbortController();
    try {
      const prepared = prepare({ ...request, stream: true });
      ({ target } = prepared);
      const { resolved, adapter, providerRequest } = prepared;
      chosen(summary, resolved, target);
      if (!adapter.parseStreamChunk) {
        throw new GatewayError(
          "INVALID_REQUEST",
          `${target.provider} does not support streaming yet; send stream: false`,
        );
      }

      const result = await openStream(providerRequest, {
        provider: target.provider,
        timeoutMs,
        signal: signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal,
      });
      summary.providerLatencyMs = result.durationMs;
      const callLog = { provider: target.provider, model: target.model, status: result.status };
      if (!result.ok) {
        throw providerFailure(adapter, result, callLog, log);
      }

      progress.accepted = true;
      yield { type: "start", id: requestId, model: request.model, provider: target.provider };
      yield* relay(request, { started, target, adapter, result, callLog, log, progress });
    } finally {
      cancel.abort();
      if (progress.accepted) {
        const { usage, usageEstimated } = finalUsage(request, progress);
        Object.assign(summary, { usage, usageEstimated }, costBreakdown(usage, target.pricing));
        summary.timeToFirstTokenMs = progress.timeToFirstTokenMs;
      }
      onFinish?.(summary);
    }
  }

  /** The body of stream(): provider payloads → delta events, then the final end event. */
  async function* relay(request, { started, target, adapter, result, callLog, log, progress }) {
    let finishReason;
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
          progress.timeToFirstTokenMs ??= Math.round(performance.now() - started);
          progress.outputChars += event.text.length;
          yield { type: "delta", text: event.text };
        } else if (event.type === "usage") {
          progress.usage = event.usage;
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

    const { usage, usageEstimated } = finalUsage(request, progress);
    const { costMicroUsd } = costBreakdown(usage, target.pricing);
    const latencyMs = Math.round(performance.now() - started);

    log.info(
      {
        ...callLog,
        streamed: true,
        latencyMs,
        timeToFirstTokenMs: progress.timeToFirstTokenMs,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        usageEstimated,
        costMicroUsd,
      },
      "Provider stream completed",
    );

    yield {
      type: "end",
      finishReason,
      usage,
      ...(usageEstimated && { usageEstimated: true }),
      latencyMs,
    };
  }

  return { chat, stream };
}
