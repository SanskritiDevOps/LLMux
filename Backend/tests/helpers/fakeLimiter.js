/**
 * An in-memory stand-in for the token bucket: each bucket starts with `limit` tokens and
 * never refills, so a test can use one up and see exactly when requests are refused.
 * `unavailable: true` plays Redis being down (everything allowed, no figures).
 * The real Lua script is tested against real Redis in tokenBucket.redis.test.js.
 */
export function fakeLimiter({ unavailable = false, retryAfterMs = 12_000 } = {}) {
  const used = new Map();
  const calls = [];
  return {
    calls,
    async take(key, { limit, cost = 1 }) {
      calls.push({ key, limit });
      if (unavailable)
        return { allowed: true, limit, remaining: limit, retryAfterMs: 0, unavailable: true };
      const spent = used.get(key) ?? 0;
      if (spent + cost > limit) {
        return { allowed: false, limit, remaining: 0, retryAfterMs };
      }
      used.set(key, spent + cost);
      return { allowed: true, limit, remaining: limit - spent - cost, retryAfterMs: 0 };
    },
  };
}
