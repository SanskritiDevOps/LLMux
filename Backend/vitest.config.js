import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests never read Backend/.env: these values make the env loader pass in CI and locally.
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://llmux:llmux@localhost:5432/llmux",
      REDIS_URL: "redis://localhost:6379",
      JWT_SECRET: "test-secret-that-is-at-least-32-characters-long",
      LOG_LEVEL: "silent",
    },
  },
});
