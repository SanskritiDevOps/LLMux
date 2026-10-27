import { env } from "../config/env.js";
import { modelConfig } from "../config/models.js";
import { openStream as openProviderStream, sendRequest } from "../providers/httpClient.js";
import { providerRegistry } from "../providers/index.js";
import { readStreamPayloads } from "../providers/streamReader.js";
import { GatewayError } from "../utils/errors.js";
import { costBreakdown, microUsdToUsd } from "./cost.js";
import { createDeadline } from "./deadline.js";
import { classifyError } from "./errorPolicy.js";
import { getProviderSettings } from "./providerSettings.js";
import { backoffDelay, retryAfterMs, sleep } from "./retry.js";
import { getEnabledProviders, maxTokensFor, resolveModel } from "./router.js";

// Provider error bodies can be large HTML pages; logs keep the first part only.
const MAX_LOGGED_BODY_CHARS = 1000;

// When another target could answer right away, waiting longer than this for the same
// provider (a long Retry-After, say) isn't worth it: move on to the next target instead.
export const MAX_WAIT_BEFORE_FALLBACK_MS = 2_000;

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
 * @property {{ provider: string, model: string } | null} target  the target that answered,
 *   or the last one tried; null if no provider was tried
 * @property {{ inputTokens: number, outputTokens: number, totalTokens: number }} usage
 * @property {boolean} usageEstimated
 * @property {number} costMicroUsd
 * @property {number} savedMicroUsd
 * @property {number} attempts  provider calls made, retries and fallbacks included
 * @property {boolean} fallbackUsed  the target in `target` isn't the first in the chain
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
    attempts: 0,
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
 * transport (routes turn its result into HTTP, SSE or WebSocket messages).
 *
 * Every call walks the alias's fallback chain (README section 14): each target is tried,
 * retried with backoff when the error allows it, and the next target is tried when it
 * doesn't answer, all inside one overall deadline. Every dependency, including the wait
 * between retries, can be swapped in tests.
 */
export function createGateway({
  registry = providerRegistry,
  config = modelConfig,
  enabledProviders = getEnabledProviders(env),
  providerSettings = getProviderSettings(env),
  timeoutMs = env.REQUEST_TIMEOUT_MS,
  deadlineMs = env.REQUEST_DEADLINE_MS,
  maxRetries = env.MAX_RETRIES,
  send = sendRequest,
  openStream = openProviderStream,
  wait = sleep,
  random = Math.random,
} = {}) {
  /** Builds one target's provider request. */
  function build(request, target, resolved) {
    const adapter = registry.get(target.provider);
    const providerRequest = adapter.buildRequest(request, target, {
      ...providerSettings[target.provider],
      maxTokens: maxTokensFor(target, request.maxTokens, resolved.defaultMaxTokens),
    });
    return { adapter, providerRequest };
  }

  /** A non-2xx from the provider: log its raw body, return the unified error to throw. */
  function providerFailure(adapter, result, callLog, log) {
    const error = adapter.mapError(result);
    // A 429 or 503 may say how long to wait before asking again.
    const after = retryAfterMs(result.headers);
    if (after !== null) error.retryAfterMs = after;
    // The raw body goes to the logs for debugging; the client only sees error.message.
    log.warn(
      { ...callLog, code: error.code, providerBody: truncateForLog(result.body) },
      "Provider returned an error",
    );
    return error;
  }

  /**
   * Runs `attempt` down the alias's chain until one succeeds (README section 14):
   *
   *   - each target gets up to 1 + maxRetries attempts, while its errors are retryable
   *   - between retries: backoffDelay() (about 250 ms, then 500 ms), or the provider's
   *     Retry-After if that is longer
   *   - a wait that would pass the deadline, or that is longer than
   *     MAX_WAIT_BEFORE_FALLBACK_MS while another target could answer now, moves on to the
   *     next target instead
   *   - an error that allows no fallback (a 400, a bug) is thrown at once
   *   - the deadline caps everything: each attempt's timeout is cut to the time left
   *
   * `summary` is kept up to date (attempts, fallbackUsed, the target being tried), so the
   * usage log is right whichever way the call ends.
   *
   * @template T
   * @param {(attempt: { target: object, resolved: object, attempt: number,
   *   fallbackUsed: boolean, timeoutMs: number }) => Promise<T>} attempt
   * @returns {Promise<T>}
   */
  async function withFallback(request, { signal, log, summary, deadline }, attempt) {
    const resolved = resolveModel(request.model, { config, enabledProviders });
    summary.alias = resolved.alias;

    let attempts = 0;
    let lastError;
    for (const [index, target] of resolved.targets.entries()) {
      const hasNext = index < resolved.targets.length - 1;
      for (let retry = 0; retry <= maxRetries; retry += 1) {
        if (retry > 0) {
          const pause = Math.max(backoffDelay(retry, { random }), lastError.retryAfterMs ?? 0);
          if (!deadline.allowsWait(pause) || (hasNext && pause > MAX_WAIT_BEFORE_FALLBACK_MS)) {
            break;
          }
          log.info({ provider: target.provider, retry, waitMs: pause }, "Retrying provider");
          await wait(pause, signal);
        }
        if (deadline.expired()) throw deadline.error({ attempts, lastError });

        attempts += 1;
        Object.assign(summary, {
          attempts,
          fallbackUsed: index > 0,
          target: { provider: target.provider, model: target.model },
        });
        try {
          return await attempt({
            target,
            resolved,
            attempt: attempts,
            fallbackUsed: index > 0,
            timeoutMs: deadline.timeoutFor(timeoutMs),
          });
        } catch (err) {
          // The client left: not the provider's fault, so no retry and no fallback.
          if (signal?.aborted) throw err;
          lastError = err;
          const decision = classifyError(err);
          log.warn(
            {
              provider: target.provider,
              model: target.model,
              attempt: attempts,
              code: err.code,
              retry: decision.retry,
              fallback: decision.fallback && hasNext,
            },
            "Provider attempt failed",
          );
          if (decision.alert) {
            log.error(
              { provider: target.provider },
              "Provider rejected LLMux's credentials; check its API key",
            );
          }
          if (!decision.fallback) throw err;
          if (!decision.retry) break;
        }
      }
    }
    // Every target failed. If time ran out along the way, say so; otherwise the last
    // provider's own error is the most useful thing to report.
    if (deadline.expired()) throw deadline.error({ attempts, lastError });
    throw lastError;
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

    const started = performance.now();
    const summary = emptySummary();
    const deadline = createDeadline(deadlineMs);
    try {
      return await withFallback(request, { signal, log, summary, deadline }, (attempt) =>
        answer(request, { requestId, signal, log, summary, started }, attempt),
      );
    } finally {
      onFinish?.(summary);
    }
  }

  /** One attempt of chat(): call one target, translate its answer. */
  async function answer(
    request,
    { requestId, signal, log, summary, started },
    { target, resolved, attempt, fallbackUsed, timeoutMs: attemptTimeoutMs },
  ) {
    const { adapter, providerRequest } = build(request, target, resolved);

    const result = await send(providerRequest, {
      provider: target.provider,
      timeoutMs: attemptTimeoutMs,
      signal,
    });
    summary.providerLatencyMs = result.durationMs;
    const callLog = {
      provider: target.provider,
      model: target.model,
      status: result.status,
      attempt,
    };

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
    // From the start of the call, so retries and fallbacks are included.
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
        fallbackUsed,
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
        fallbackUsed,
      },
      // For the X-LLMux-* headers: not part of the client contract.
      meta: {
        alias: resolved.alias,
        target,
        attempts: attempt,
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
   * A stream commits to a provider at its first token (README section 14: fall back "only
   * before the first token is sent"). Until then, an error, a refusal, a timeout or a
   * stream that fails before saying anything is retried or falls back exactly like
   * chat(), and the client sees none of it. So `start` is yielded only once the first
   * token has arrived (or the provider finished without any text), naming the provider
   * that is really answering.
   *
   * If every target fails, the error is thrown before the first event, so the route can
   * still answer with a normal HTTP error. A failure after `start` is thrown mid-iteration;
   * the route turns it into an `error` event. Stopping the iteration early (the client
   * left) cancels the provider request.
   *
   * The usage summary passed to `context.onFinish` covers streams that end early too:
   * once a stream has committed, the tokens used so far are counted (estimated when the
   * provider hadn't sent figures yet), because the provider bills them anyway.
   *
   * @param {import("../providers/adapter.js").UnifiedRequest} request  already validated
   * @param {CallContext} context
   * @returns {AsyncGenerator<import("zod").infer<typeof import("./schemas.js").StreamEventSchema>>}
   */
  async function* stream(request, { requestId, signal, log, onFinish }) {
    const started = performance.now();
    const summary = emptySummary();
    const deadline = createDeadline(deadlineMs);
    let committed = null;
    try {
      committed = await withFallback(request, { signal, log, summary, deadline }, (attempt) =>
        openUntilFirstToken(request, { signal, log, started }, attempt),
      );
      const { target, events, first, progress, callLog } = committed;
      summary.providerLatencyMs = committed.durationMs;

      yield { type: "start", id: requestId, model: request.model, provider: target.provider };
      if (!first.done) yield first.value;
      for await (const event of events) yield event;

      const { usage, usageEstimated } = finalUsage(request, progress);
      const { costMicroUsd } = costBreakdown(usage, target.pricing);
      const latencyMs = Math.round(performance.now() - started);
      log.info(
        {
          ...callLog,
          streamed: true,
          fallbackUsed: summary.fallbackUsed,
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
        finishReason: progress.finishReason,
        usage,
        ...(usageEstimated && { usageEstimated: true }),
        latencyMs,
      };
    } finally {
      if (committed) {
        // Closes the provider connection however the iteration ended.
        committed.cancel.abort();
        const { usage, usageEstimated } = finalUsage(request, committed.progress);
        Object.assign(
          summary,
          { usage, usageEstimated },
          costBreakdown(usage, committed.target.pricing),
        );
        summary.timeToFirstTokenMs = committed.progress.timeToFirstTokenMs;
      }
      onFinish?.(summary);
    }
  }

  /**
   * One attempt of stream(): open the target's stream and read it up to its first token.
   * Anything that goes wrong in here is still a failed attempt, so withFallback() can
   * retry or move on, and this attempt's connection is closed.
   */
  async function openUntilFirstToken(
    request,
    { signal, log, started },
    { target, resolved, attempt, timeoutMs: attemptTimeoutMs },
  ) {
    const { adapter, providerRequest } = build({ ...request, stream: true }, target, resolved);
    if (!adapter.parseStreamChunk) {
      // Another provider in the chain may stream, so this is a provider limitation, not a
      // bad request.
      throw new GatewayError("PROVIDER_ERROR", `${target.provider} does not support streaming`, {
        provider: target.provider,
        retryable: false,
      });
    }

    // Aborted if this attempt fails here, and by stream() when the stream ends.
    const cancel = new AbortController();
    try {
      const result = await openStream(providerRequest, {
        provider: target.provider,
        // An idle limit: it covers the wait for the headers and for each chunk.
        timeoutMs: attemptTimeoutMs,
        signal: signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal,
      });
      const callLog = {
        provider: target.provider,
        model: target.model,
        status: result.status,
        attempt,
      };
      if (!result.ok) {
        throw providerFailure(adapter, result, callLog, log);
      }

      const progress = {
        usage: undefined,
        outputChars: 0,
        timeToFirstTokenMs: null,
        finishReason: null,
      };
      const events = providerEvents({ started, target, adapter, result, callLog, log, progress });
      const first = await events.next();
      return { target, events, first, progress, callLog, cancel, durationMs: result.durationMs };
    } catch (err) {
      cancel.abort();
      throw err;
    }
  }

  /**
   * Provider payloads → unified delta events. Usage and the finish reason are kept in
   * `progress`. Throws if the provider fails mid-stream, or if the stream ends without the
   * provider saying the answer was complete.
   */
  async function* providerEvents({ started, target, adapter, result, callLog, log, progress }) {
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
          progress.finishReason = event.finishReason;
        }
      }
    }

    if (!progress.finishReason) {
      // The connection closed cleanly but the provider never said the answer was done,
      // so the client may have a truncated answer.
      log.warn(callLog, "Provider stream ended without finishing");
      throw new GatewayError(
        "PROVIDER_ERROR",
        `${target.provider} ended the stream before the answer was complete`,
        { provider: target.provider, retryable: true },
      );
    }
  }

  return { chat, stream };
}
