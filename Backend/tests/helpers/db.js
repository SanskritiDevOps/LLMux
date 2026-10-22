import { prisma } from "../../src/config/db.js";

/**
 * Empties every table so each test starts from nothing. Refuses to run against any
 * database whose name does not end in "_test", so a misconfigured DATABASE_URL can never
 * wipe development or production data.
 */
export async function resetDatabase() {
  const name = new URL(process.env.DATABASE_URL).pathname.slice(1);
  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to wipe database "${name}": test databases must end in _test`);
  }
  await prisma.$executeRawUnsafe("TRUNCATE TABLE usage_logs, api_keys, users CASCADE");
}

export { prisma };
