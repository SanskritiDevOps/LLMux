import { defineConfig } from "vitest/config";
import { TEST_DATABASE_URL } from "./tests/setup/testDatabase.js";

// Tests that empty database tables. They share one database, so they must not run at the
// same time as each other, or one file wipes another's data mid-test.
const DATABASE_TESTS = "tests/**/*.db.test.js";

export default defineConfig({
  test: {
    // Fixed values so the env loader passes the same way in CI and locally.
    env: {
      NODE_ENV: "test",
      // A separate database: tests that touch Postgres wipe it between tests.
      DATABASE_URL: TEST_DATABASE_URL,
      // Redis database 1, so tests never read or write the dev cache in database 0.
      REDIS_URL: "redis://localhost:6379/1",
      JWT_SECRET: "test-secret-that-is-at-least-32-characters-long",
      LOG_LEVEL: "silent",
    },
    // Migrates the test database first when TEST_REAL_DEPS=1; otherwise does nothing.
    globalSetup: ["./tests/setup/testDatabase.js"],
    // expect.poll() waits for something asynchronous to happen (a cancel reaching the mock
    // provider, a log line). Vitest gives up after 1 s by default, which a busy machine can
    // exceed. A passing poll still returns as soon as its condition is true.
    expect: { poll: { timeout: 5000 } },
    projects: [
      {
        extends: true,
        test: { name: "unit-and-integration", exclude: [DATABASE_TESTS, "node_modules/**"] },
      },
      {
        extends: true,
        test: { name: "database", include: [DATABASE_TESTS], fileParallelism: false },
      },
    ],
  },
});
