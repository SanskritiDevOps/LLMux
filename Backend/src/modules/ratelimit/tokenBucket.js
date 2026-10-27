import { readFileSync } from "node:fs";
import { logger as defaultLogger } from "../../utils/logger.js";

/**
 * Token buckets in Redis (README section 13): each bucket holds up to `limit` tokens and
 * refills at `limit` per minute; each request takes one. Bursts up to the limit are
 * allowed, while the long-term rate stays fixed.
 *
 * The work happens in src/scripts/rateLimit.lua, run atomically by Redis, so parallel
 * requests on any number of LLMux instances can't take the same token twice.
 *
 * If Redis is down, every request is allowed (and logged at debug level): the rate limit
 * protects fair use, but it must not take the whole gateway down with Redis.
 */

const SCRIPT = readFileSync(new URL("../../scripts/rateLimit.lua", import.meta.url), "utf8");
// Registered once per Redis client; ioredis sends EVALSHA and reloads the script if
// Redis has forgotten it (after a restart, say).
const COMMAND = "llmuxTakeToken";
const MS_PER_MINUTE = 60_000;

/**
 * @typedef {Object} TakeResult
 * @property {boolean} allowed
 * @property {number} limit  the bucket's capacity, for X-RateLimit-Limit
 * @property {number} remaining  whole tokens left, for X-RateLimit-Remaining
 * @property {number} retryAfterMs  how long until a request would be allowed (0 if allowed)
 * @property {boolean} [unavailable]  true when Redis couldn't be asked (always allowed)
 */

/**
 * @param {{ redis: import("ioredis").Redis, logger?: import("pino").Logger }} deps
 */
export function createTokenBucket({ redis, logger = defaultLogger }) {
  if (typeof redis?.defineCommand === "function" && !redis[COMMAND]) {
    redis.defineCommand(COMMAND, { numberOfKeys: 1, lua: SCRIPT });
  }

  return {
    /**
     * Takes one token from `key`'s bucket, if there is one.
     *
     * @param {string} key  e.g. "rl:key:<id>" or "rl:login:<ip>"
     * @param {{ limit: number, cost?: number, log?: import("pino").Logger }} options
     *   limit is both the capacity and the number of tokens refilled per minute
     * @returns {Promise<TakeResult>}
     */
    async take(key, { limit, cost = 1, log = logger }) {
      try {
        const [allowed, tokens, waitMs] = await redis[COMMAND](
          key,
          limit,
          limit / MS_PER_MINUTE,
          cost,
        );
        return {
          allowed: allowed === 1,
          limit,
          remaining: Math.max(0, Math.floor(Number(tokens))),
          retryAfterMs: Number(waitMs),
        };
      } catch (err) {
        log.debug({ err, key }, "Rate limiter unavailable (Redis); allowing the request");
        return { allowed: true, limit, remaining: limit, retryAfterMs: 0, unavailable: true };
      }
    },
  };
}

/** For code paths and tests that don't rate-limit: always allows. */
export const noRateLimit = Object.freeze({
  take: async (_key, { limit }) => ({ allowed: true, limit, remaining: limit, retryAfterMs: 0 }),
});
