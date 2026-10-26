import { prisma as defaultPrisma } from "../../config/db.js";

/**
 * Writes rows to usage_logs. Only batch inserts: rows arrive from the usage writer in
 * groups, never one at a time on the request path.
 *
 * @param {import("@prisma/client").PrismaClient} [prisma]
 */
export function createUsageRepository(prisma = defaultPrisma) {
  return {
    /**
     * Inserts many rows in one statement. A row whose request_id is already stored is
     * skipped rather than failing the batch, so retrying a batch that half-succeeded (or
     * one whose answer was lost on the network) never writes a request twice.
     *
     * @param {object[]} rows  camelCase, as in the Prisma UsageLog model
     * @returns {Promise<number>} how many rows were inserted
     */
    async insertMany(rows) {
      const { count } = await prisma.usageLog.createMany({ data: rows, skipDuplicates: true });
      return count;
    },
  };
}
