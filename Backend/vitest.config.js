import { defineConfig } from "vitest/config";
import { TEST_DATABASE_URL } from "./tests/setup/testDatabase.js";

export default defineConfig({
  test: {
    // Fixed values so the env loader passes the same way in CI and locally.
    env: {
      NODE_ENV: "test",
      // A separate database: tests that touch Postgres wipe it between tests.
      DATABASE_URL: TEST_DATABASE_URL,
      REDIS_URL: "redis://localhost:6379",
      JWT_SECRET: "test-secret-that-is-at-least-32-characters-long",
      LOG_LEVEL: "silent",
    },
    // Migrates the test database first when TEST_REAL_DEPS=1; otherwise does nothing.
    globalSetup: ["./tests/setup/testDatabase.js"],
  },
});
