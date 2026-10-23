import { prisma as defaultPrisma } from "../../config/db.js";

/**
 * The only module that reads or writes the api_keys table. Every dashboard query takes the
 * owner's userId, so one user can never read or change another user's keys.
 *
 * @param {import("@prisma/client").PrismaClient} [prisma]
 */
export function createKeysRepository(prisma = defaultPrisma) {
  const findForUser = (id, userId) => prisma.apiKey.findFirst({ where: { id, userId } });

  return {
    create({ userId, name, keyPrefix, keyHash, rateLimitPerMin }) {
      return prisma.apiKey.create({
        data: { userId, name, keyPrefix, keyHash, rateLimitPerMin },
      });
    },

    /** Newest first. Includes revoked keys, so their history stays visible. */
    listByUser(userId) {
      return prisma.apiKey.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
    },

    findForUser,

    /** Returns the updated key, or null if it does not exist or belongs to someone else. */
    async update(id, userId, data) {
      const { count } = await prisma.apiKey.updateMany({ where: { id, userId }, data });
      return count === 0 ? null : findForUser(id, userId);
    },

    /**
     * Soft delete: sets revoked_at once and keeps the row, so its usage history stays.
     * Revoking an already revoked key is a no-op that returns it unchanged.
     */
    async revoke(id, userId) {
      await prisma.apiKey.updateMany({
        where: { id, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return findForUser(id, userId);
    },

    /** Used on every /v1 request (through the cache): the hash has a unique index. */
    findByHash(keyHash) {
      return prisma.apiKey.findUnique({ where: { keyHash } });
    },

    touchLastUsed(id, at = new Date()) {
      return prisma.apiKey.update({ where: { id }, data: { lastUsedAt: at } });
    },
  };
}
