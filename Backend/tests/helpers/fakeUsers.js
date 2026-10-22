import { randomUUID } from "node:crypto";

/**
 * An in-memory users repository with the same interface as createUsersRepository(),
 * for route tests that should not need Postgres. The real repository is covered by the
 * auth integration tests against a real database.
 */
export function fakeUsers() {
  const rows = [];
  return {
    rows,
    async create({ email, name, passwordHash }) {
      if (rows.some((row) => row.email === email)) return null;
      const user = { id: randomUUID(), email, name, passwordHash, createdAt: new Date() };
      rows.push(user);
      return user;
    },
    async findByEmail(email) {
      return rows.find((row) => row.email === email) ?? null;
    },
    async findById(id) {
      return rows.find((row) => row.id === id) ?? null;
    },
  };
}
