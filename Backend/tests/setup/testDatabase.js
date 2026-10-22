import { execSync } from "node:child_process";

/**
 * Tests that touch Postgres use their own database, never the development one, so running
 * the suite can never wipe real data. Prisma creates it on the first migrate.
 */
export const TEST_DATABASE_URL = "postgresql://llmux:llmux@localhost:5432/llmux_test";

export const realDependencies = process.env.TEST_REAL_DEPS === "1";

/**
 * Vitest global setup: runs once before any test file. When real-dependency tests are on,
 * apply the committed migrations to the test database, exactly as a deploy would.
 */
export default function setup() {
  if (!realDependencies) return;

  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "pipe",
  });
}
