import { keyCacheKey } from "./keys.service.js";

// README section 17: cached key lookups live for 5 minutes.
export const KEY_CACHE_TTL_SECONDS = 300;
// Unknown keys are remembered briefly, so someone retrying a wrong key does not hit
// Postgres on every request.
export const MISSING_KEY_CACHE_TTL_SECONDS = 60;
// last_used_at is for the dashboard ("used 3 minutes ago"), not an audit trail, so one
// write per key per minute is plenty.
export const TOUCH_INTERVAL_MS = 60_000;

const MISSING = JSON.stringify({ missing: true });

/**
 * Finds a gateway key by its hash on every /v1 request: Redis first, Postgres on a miss.
 *
 * - The cached record is { id, userId, rateLimitPerMin, revoked }: nothing secret, and
 *   never the hash's key.
 * - Revoking or editing a key deletes its cache entry (keys.service.js), so changes apply
 *   at once rather than when the entry expires.
 * - If Redis is down, every lookup goes to Postgres: slower, but keys keep working.
 *
 * @param {{ keys: ReturnType<typeof import("./keys.repository.js").createKeysRepository>,
 *   redis: import("ioredis").Redis }} deps
 */
export function createKeyLookup({ keys, redis }) {
  async function readCache(cacheKey, log) {
    try {
      return await redis.get(cacheKey);
    } catch (err) {
      log?.debug({ err }, "Key cache unavailable; reading from the database");
      return null;
    }
  }

  async function writeCache(cacheKey, value, ttlSeconds, log) {
    try {
      await redis.set(cacheKey, value, "EX", ttlSeconds);
    } catch (err) {
      log?.debug({ err }, "Could not cache the key lookup");
    }
  }

  /** Fire-and-forget: a slow or failed write must never delay or fail the request. */
  function touch(row, log) {
    const last = row.lastUsedAt ? new Date(row.lastUsedAt).getTime() : 0;
    if (Date.now() - last < TOUCH_INTERVAL_MS) return;
    Promise.resolve(keys.touchLastUsed(row.id)).catch((err) => {
      log?.warn({ err, keyId: row.id }, "Could not update the key's last_used_at");
    });
  }

  return {
    /**
     * @param {string} keyHash
     * @returns {Promise<{ id: string, userId: string, rateLimitPerMin: number | null,
     *   revoked: boolean } | null>}  null when no key has this hash
     */
    async find(keyHash, { log } = {}) {
      const cacheKey = keyCacheKey(keyHash);

      const cached = await readCache(cacheKey, log);
      if (cached !== null) {
        const record = JSON.parse(cached);
        return record.missing ? null : record;
      }

      const row = await keys.findByHash(keyHash);
      if (!row) {
        await writeCache(cacheKey, MISSING, MISSING_KEY_CACHE_TTL_SECONDS, log);
        return null;
      }

      const record = {
        id: row.id,
        userId: row.userId,
        rateLimitPerMin: row.rateLimitPerMin,
        revoked: row.revokedAt !== null,
      };
      await writeCache(cacheKey, JSON.stringify(record), KEY_CACHE_TTL_SECONDS, log);
      // Only on a cache miss, so with the 5-minute cache this is about one write per
      // key per 5 minutes per server: last_used_at is accurate to a few minutes.
      if (!record.revoked) touch(row, log);
      return record;
    },
  };
}
