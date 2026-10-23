import { z } from "zod";
import { GatewayError } from "../../utils/errors.js";
import { generateKey } from "./keyGenerator.js";

/** Redis key for a cached key lookup (README section 17: key:<hash>, 5 minutes). */
export function keyCacheKey(keyHash) {
  return `key:${keyHash}`;
}

// null clears a custom limit, so the key falls back to DEFAULT_RATE_LIMIT_PER_MIN.
const RateLimitSchema = z.int().min(1).max(10_000).nullable();

export const CreateKeySchema = z.strictObject({
  name: z.string().trim().min(1, { error: "must not be empty" }).max(100),
  rateLimitPerMin: RateLimitSchema.optional(),
});

export const UpdateKeySchema = z
  .strictObject({
    name: z.string().trim().min(1, { error: "must not be empty" }).max(100).optional(),
    rateLimitPerMin: RateLimitSchema.optional(),
  })
  .refine((body) => body.name !== undefined || body.rateLimitPerMin !== undefined, {
    error: "send name, rateLimitPerMin, or both",
  });

export const KeyIdParams = z.strictObject({ id: z.uuid({ error: "must be a key ID" }) });

/** What the dashboard may see about a key. Never the hash, and never the key itself. */
export function toPublicKey(row) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.keyPrefix,
    rateLimitPerMin: row.rateLimitPerMin,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

const notFound = () => new GatewayError("NOT_FOUND", "Key not found");

/**
 * Key management for the logged-in user. "Not found" covers both "no such key" and
 * "someone else's key", so the API never confirms that another user's key ID exists.
 *
 * @param {{ keys: ReturnType<typeof import("./keys.repository.js").createKeysRepository>,
 *   redis: import("ioredis").Redis, log?: import("pino").Logger }} deps
 */
export function createKeysService({ keys, redis }) {
  return {
    /** The only time the full key is ever returned. */
    async create(userId, { name, rateLimitPerMin }) {
      const { key, prefix, hash } = generateKey();
      const row = await keys.create({
        userId,
        name,
        keyPrefix: prefix,
        keyHash: hash,
        rateLimitPerMin: rateLimitPerMin ?? null,
      });
      return { apiKey: key, key: toPublicKey(row) };
    },

    async list(userId) {
      return (await keys.listByUser(userId)).map(toPublicKey);
    },

    async update(userId, id, changes) {
      const row = await keys.update(id, userId, changes);
      if (!row) throw notFound();
      // A cached lookup holds the old rate limit; drop it so the change applies at once.
      await forgetCachedLookup(row.keyHash);
      return toPublicKey(row);
    },

    async revoke(userId, id, { log } = {}) {
      const row = await keys.revoke(id, userId);
      if (!row) throw notFound();
      // Without this, a cached lookup would keep accepting the key for up to 5 minutes.
      await forgetCachedLookup(row.keyHash, log);
      return toPublicKey(row);
    },
  };

  async function forgetCachedLookup(keyHash, log) {
    try {
      await redis.del(keyCacheKey(keyHash));
    } catch (err) {
      // The database change already happened. If Redis is down nothing is being cached
      // either; the entry, if any, expires on its own within 5 minutes.
      log?.warn({ err }, "Could not clear the cached key lookup");
    }
  }
}
