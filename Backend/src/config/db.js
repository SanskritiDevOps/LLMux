import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { env } from "./env.js";

// Prisma connects lazily on the first query, so importing this file opens no connection.
export const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: env.DATABASE_URL,
    // Fail a query quickly when Postgres is unreachable instead of waiting on the OS timeout.
    connectionTimeoutMillis: 5_000,
  }),
});

/** Resolves when Postgres answers a trivial query; rejects otherwise. */
export async function checkDatabase() {
  await prisma.$queryRaw`SELECT 1`;
}
