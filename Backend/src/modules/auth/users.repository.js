import { prisma as defaultPrisma } from "../../config/db.js";

// Postgres unique-constraint violation, as reported by Prisma.
const UNIQUE_VIOLATION = "P2002";

/**
 * The only module that reads or writes the users table. Business rules (validation,
 * hashing, what to expose) live in the services; this file only talks to the database.
 *
 * @param {import("@prisma/client").PrismaClient} [prisma]
 */
export function createUsersRepository(prisma = defaultPrisma) {
  return {
    /**
     * Inserts a user. Returns null if the email is already taken: the unique index decides,
     * so two simultaneous registrations for one email cannot both succeed.
     */
    async create({ email, name, passwordHash }) {
      try {
        return await prisma.user.create({ data: { email, name, passwordHash } });
      } catch (err) {
        if (err?.code === UNIQUE_VIOLATION) return null;
        throw err;
      }
    },

    findByEmail(email) {
      return prisma.user.findUnique({ where: { email } });
    },

    findById(id) {
      return prisma.user.findUnique({ where: { id } });
    },
  };
}
