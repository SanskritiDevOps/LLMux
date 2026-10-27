import { env } from "../config/env.js";
import { logger as defaultLogger } from "../utils/logger.js";
import { cacheKey, isCacheable } from "./cacheKey.js";

/**
 * The response cache (README section 12): an identical, deterministic request is answered
 * from Redis instead of calling a provider again.
 *
 *   - only JSON chats: streams are always served live (replaying them is a P1 stretch)
 *   - only requests isCacheable() allows: `cache` not false, and temperature 0 unless
 *     CACHE_ONLY_DETERMINISTIC is false
 *   - only complete answers (finishReason "stop") are stored, for CACHE_TTL_SECONDS (1 h)
 *   - a hit costs nothing and records what it saved: `cached: true`, `costUsd: 0`,
 *     `X-LLMux-Cache: HIT`, and the original cost as saved_micro_usd in the usage log
 *   - entries are per account (cacheKey's scope): customers never share answers
 *
 * If Redis is down, every request is simply a miss: the cache only ever saves time and
 * money, it never fails a request.
 */

/**
 * @param {{ redis: import("ioredis").Redis, ttlSeconds?: number,
 *   logger?: import("pino").Logger }} options
 */
export function createResponseCache({
  redis,
  ttlSeconds = env.CACHE_TTL_SECONDS,
  logger = defaultLogger,
}) {
  return {
    /** The stored entry, or null for a miss (including when Redis can't be reached). */
    async get(key, log = logger) {
      try {
        const value = await redis.get(key);
        return value ? JSON.parse(value) : null;
      } catch (err) {
        log.debug({ err }, "Response cache unavailable; treating as a miss");
        return null;
      }
    },
    /** Never throws: a failed write only means the next identical request is a miss too. */
    async set(key, entry, log = logger) {
      try {
        await redis.set(key, JSON.stringify(entry), "EX", ttlSeconds);
      } catch (err) {
        log.debug({ err }, "Could not store the response in the cache");
      }
    },
  };
}

/**
 * Wraps a gateway so chat() checks the cache first. stream() is passed through unchanged.
 *
 * @param {ReturnType<typeof import("./gateway.service.js").createGateway>} gateway
 * @param {{ cache: ReturnType<typeof createResponseCache>, onlyDeterministic?: boolean }} options
 */
export function withResponseCache(gateway, { cache, onlyDeterministic }) {
  /**
   * @param {import("../providers/adapter.js").UnifiedRequest} request
   * @param {import("./gateway.service.js").CallContext & { cacheScope?: string }} context
   *   cacheScope is the account that owns the gateway key; without it, nothing is cached
   */
  async function chat(request, context) {
    if (!context.cacheScope || !isCacheable(request, { onlyDeterministic })) {
      return gateway.chat(request, context);
    }

    const started = performance.now();
    const key = cacheKey(request, { scope: context.cacheScope });
    const hit = await cache.get(key, context.log);
    if (hit) return fromCache(request, context, hit, started);

    const result = await gateway.chat(request, context);
    // Only complete answers: a cut-off one ("length") or a filtered one shouldn't be
    // repeated to the next caller.
    if (result.response.finishReason === "stop") {
      const { response, meta } = result;
      // Not awaited: storing the answer must not delay sending it.
      cache.set(
        key,
        {
          alias: meta.alias,
          provider: response.provider,
          providerModel: response.providerModel,
          content: response.content,
          finishReason: response.finishReason,
          usage: response.usage,
          usageEstimated: meta.usageEstimated,
          costMicroUsd: meta.costMicroUsd,
        },
        context.log,
      );
    }
    return result;
  }

  /** A stored answer, as a fresh response: new request ID, cached, free. */
  function fromCache(request, { requestId, log, onFinish }, hit, started) {
    const latencyMs = Math.round(performance.now() - started);
    const target = { provider: hit.provider, model: hit.providerModel };
    onFinish?.({
      alias: hit.alias,
      target,
      usage: hit.usage,
      usageEstimated: hit.usageEstimated,
      costMicroUsd: 0,
      // What the provider charged the first time: the money this hit saved.
      savedMicroUsd: hit.costMicroUsd,
      attempts: 0,
      fallbackUsed: false,
      cached: true,
      providerLatencyMs: null,
      timeToFirstTokenMs: null,
    });
    log.info(
      {
        provider: hit.provider,
        model: hit.providerModel,
        latencyMs,
        savedMicroUsd: hit.costMicroUsd,
      },
      "Answered from cache",
    );

    return {
      response: {
        id: requestId,
        model: request.model,
        provider: hit.provider,
        providerModel: hit.providerModel,
        content: hit.content,
        finishReason: hit.finishReason,
        usage: hit.usage,
        costUsd: 0,
        latencyMs,
        cached: true,
        fallbackUsed: false,
      },
      meta: {
        alias: hit.alias,
        target,
        attempts: 0,
        providerLatencyMs: null,
        usageEstimated: hit.usageEstimated,
        costMicroUsd: 0,
        savedMicroUsd: hit.costMicroUsd,
      },
    };
  }

  return { chat, stream: gateway.stream };
}
