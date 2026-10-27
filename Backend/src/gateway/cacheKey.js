import { createHash } from "node:crypto";
import { env } from "../config/env.js";

/**
 * Which requests may be answered from the cache, and the key they're stored under
 * (README section 12):
 *
 *   cache:v1:<sha256 of the normalized { model, system, messages, temperature, maxTokens }>
 *
 * Normalizing (sorted keys, trimmed text, defaults filled in) makes requests that mean the
 * same thing share one key. Fields that don't change the answer are left out: `metadata`,
 * `cache` and `stream`.
 *
 * Every key is scoped to one account (the owner of the gateway key), so one customer is
 * never answered from another customer's cache.
 */

// Bump to "v2" if the stored format changes: every old entry is ignored at once, and
// expires on its own.
export const CACHE_KEY_VERSION = "v1";

/**
 * @param {import("../providers/adapter.js").UnifiedRequest} request  already validated
 * @param {{ onlyDeterministic?: boolean }} [options]  CACHE_ONLY_DETERMINISTIC by default
 */
export function isCacheable(request, { onlyDeterministic = env.CACHE_ONLY_DETERMINISTIC } = {}) {
  if (request.cache === false || request.stream) return false;
  // With temperature above 0 the client asked for variety; replaying one answer would
  // quietly take that away.
  return !onlyDeterministic || request.temperature === 0;
}

/**
 * The parts of a request that decide its answer, in one canonical shape.
 *
 * @param {import("../providers/adapter.js").UnifiedRequest} request
 * @param {{ scope: string }} options  the account the entry belongs to
 */
export function normalizeForCache(request, { scope }) {
  return {
    scope,
    model: request.model.trim(),
    system: request.system?.trim() || null,
    messages: request.messages.map(({ role, content }) => ({ role, content: content.trim() })),
    temperature: request.temperature,
    maxTokens: request.maxTokens ?? null,
  };
}

/** JSON with object keys sorted at every level, so key order never changes the hash. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * @param {import("../providers/adapter.js").UnifiedRequest} request
 * @param {{ scope: string }} options
 * @returns {string} for example "cache:v1:3f5a…" (64 hex characters)
 */
export function cacheKey(request, { scope }) {
  const hash = createHash("sha256")
    .update(canonicalJson(normalizeForCache(request, { scope })))
    .digest("hex");
  return `cache:${CACHE_KEY_VERSION}:${hash}`;
}
