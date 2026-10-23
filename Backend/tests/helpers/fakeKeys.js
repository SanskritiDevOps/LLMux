import { randomUUID } from "node:crypto";

/**
 * An in-memory api_keys repository with the same interface as createKeysRepository(),
 * for tests that should not need Postgres. The real one is tested against a database.
 */
export function fakeKeys() {
  const rows = [];
  const forUser = (id, userId) => rows.find((row) => row.id === id && row.userId === userId);

  return {
    rows,
    async create({ userId, name, keyPrefix, keyHash, rateLimitPerMin }) {
      const row = {
        id: randomUUID(),
        userId,
        name,
        keyPrefix,
        keyHash,
        rateLimitPerMin,
        monthlyBudgetMicroUsd: null,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: new Date(Date.now() + rows.length),
      };
      rows.push(row);
      return row;
    },
    async listByUser(userId) {
      return rows.filter((row) => row.userId === userId).sort((a, b) => b.createdAt - a.createdAt);
    },
    async findForUser(id, userId) {
      return forUser(id, userId) ?? null;
    },
    async update(id, userId, data) {
      const row = forUser(id, userId);
      if (!row) return null;
      Object.assign(row, data);
      return row;
    },
    async revoke(id, userId) {
      const row = forUser(id, userId);
      if (!row) return null;
      row.revokedAt ??= new Date();
      return row;
    },
    async findByHash(keyHash) {
      return rows.find((row) => row.keyHash === keyHash) ?? null;
    },
    async touchLastUsed(id, at = new Date()) {
      const row = rows.find((r) => r.id === id);
      if (row) row.lastUsedAt = at;
      return row;
    },
  };
}
