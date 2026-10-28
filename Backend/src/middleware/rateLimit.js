import { env } from "../config/env.js";
import { GatewayError } from "../utils/errors.js";

/**
 * Rate limits on top of the token bucket (src/modules/ratelimit/tokenBucket.js):
 *
 *   per gateway key   every /v1 request and every WebSocket chat takes one token from
 *                     the key's bucket: its rateLimitPerMin, or DEFAULT_RATE_LIMIT_PER_MIN
 *   per IP on login   POST /api/auth/login, to slow down password guessing
 *
 * Responses say where the client stands (README section 13):
 *
 *   X-RateLimit-Limit: 60
 *   X-RateLimit-Remaining: 41
 *   Retry-After: 12        (only on 429)
 *
 * If Redis is down the limiter allows everything, and these headers are left out rather
 * than made up.
 */

export const RATE_LIMIT_HEADERS = Object.freeze({
  limit: "X-RateLimit-Limit",
  remaining: "X-RateLimit-Remaining",
  retryAfter: "Retry-After",
});

// Generous for a person mistyping a password, slow for a script guessing passwords.
export const LOGIN_LIMIT_PER_MIN = 10;

/** The bucket for one gateway key; HTTP and WebSocket share it. */
export const keyBucket = (apiKeyId) => `rl:key:${apiKeyId}`;

/** @param {{ rateLimitPerMin: number | null }} apiKey */
export const limitFor = (apiKey) => apiKey.rateLimitPerMin ?? env.DEFAULT_RATE_LIMIT_PER_MIN;

/** Whole seconds, never 0: "Retry-After: 0" would invite an immediate retry that fails. */
export const retryAfterSeconds = (result) => Math.max(1, Math.ceil(result.retryAfterMs / 1000));

/** The 429 for a refused request: RATE_LIMITED, retryable, saying when to try again. */
export function rateLimitError(result) {
  const seconds = retryAfterSeconds(result);
  return Object.assign(
    new GatewayError(
      "RATE_LIMITED",
      `Rate limit exceeded. Retry after ${seconds} ${seconds === 1 ? "second" : "seconds"}.`,
    ),
    { retryAfterSeconds: seconds },
  );
}

function setHeaders(res, result) {
  if (result.unavailable) return;
  res.set(RATE_LIMIT_HEADERS.limit, String(result.limit));
  res.set(RATE_LIMIT_HEADERS.remaining, String(result.remaining));
  if (!result.allowed) res.set(RATE_LIMIT_HEADERS.retryAfter, String(retryAfterSeconds(result)));
}

/**
 * For /v1: one token per request from the gateway key's bucket. Mount after requireApiKey.
 *
 * @param {{ limiter: ReturnType<typeof import("../modules/ratelimit/tokenBucket.js").createTokenBucket> }} deps
 */
export function rateLimitByKey({ limiter }) {
  return async (req, res, next) => {
    const result = await limiter.take(keyBucket(req.apiKey.id), {
      limit: limitFor(req.apiKey),
      log: req.log,
    });
    setHeaders(res, result);
    if (!result.allowed) {
      req.log?.info({ keyId: req.apiKey.id, limit: result.limit }, "Rate limit reached");
      return next(rateLimitError(result));
    }
    next();
  };
}

/**
 * One token per request from a bucket per client IP, for routes with no key to limit by.
 *
 * `req.ip` is the direct peer. Behind a proxy (Render, Fly.io), Express must be told to
 * trust it (app.set("trust proxy", 1)), or every client shares the proxy's address.
 *
 * @param {{ limiter: ReturnType<typeof import("../modules/ratelimit/tokenBucket.js").createTokenBucket>,
 *   name: string, limit: number }} options  name keeps different routes' buckets apart
 */
export function rateLimitByIp({ limiter, name, limit }) {
  return async (req, res, next) => {
    const result = await limiter.take(`rl:${name}:${req.ip}`, { limit, log: req.log });
    setHeaders(res, result);
    if (!result.allowed) {
      req.log?.warn({ ip: req.ip, route: name, limit }, "Rate limit reached for this address");
      return next(rateLimitError(result));
    }
    next();
  };
}
