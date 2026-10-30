/**
 * The benchmark's LLMux: the real app in its own process, with real Postgres and Redis,
 * pointed at the mock provider (MOCK_URL). Started by overhead.bench.js, which sets the
 * database URLs before this file loads any config. Driven over IPC:
 *
 *   { op: "circuit", provider }   { op: "flushRedis" }   { op: "close" }
 *
 * It creates its own user and gateway key, and removes them (with their usage rows) on
 * close.
 */
import http from "node:http";
import { prisma } from "../src/config/db.js";
import { redis } from "../src/config/redis.js";
import { createApp } from "../src/app.js";
import { createCircuitBreaker } from "../src/gateway/circuitBreaker.js";
import { createGateway } from "../src/gateway/gateway.service.js";
import { createKeysRepository } from "../src/modules/keys/keys.repository.js";
import { generateKey } from "../src/modules/keys/keyGenerator.js";
import { createTokenBucket } from "../src/modules/ratelimit/tokenBucket.js";
import { createUsageWriter } from "../src/modules/usage/usageWriter.js";
import { createLogger } from "../src/utils/logger.js";

// Only errors: the fallback run makes Gemini fail on purpose, and its warnings are expected.
const logger = createLogger({ level: "error", pretty: false });
const mockUrl = process.env.MOCK_URL;

await redis.flushdb();
const user = await prisma.user.create({
  data: { email: `bench-${Date.now()}@example.com`, name: "Benchmark", passwordHash: "x" },
});
const { key, prefix, hash } = generateKey();
// Above the API's 10,000 a minute maximum, set directly, so the rate limit runs on every
// request without ever refusing one.
await prisma.apiKey.create({
  data: {
    userId: user.id,
    name: "bench",
    keyPrefix: prefix,
    keyHash: hash,
    rateLimitPerMin: 100_000_000,
  },
});

const usage = createUsageWriter({ logger });
const breaker = createCircuitBreaker({ redis, logger });
const gateway = createGateway({
  enabledProviders: new Set(["gemini", "ollama"]),
  providerSettings: {
    gemini: { apiKey: "bench-gemini-key", baseUrl: mockUrl },
    ollama: { baseUrl: mockUrl },
  },
  breaker,
});
const app = createApp({
  logger,
  gateway,
  keys: createKeysRepository(),
  redis,
  usage,
  limiter: createTokenBucket({ redis, logger }),
  breaker,
});

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

process.on("message", async ({ id, op, provider }) => {
  let result = {};
  if (op === "circuit") result = await breaker.state(provider);
  if (op === "flushRedis") await redis.flushdb();
  if (op === "close") {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await usage.close();
    // Deleting the user removes its key and usage rows too (ON DELETE CASCADE).
    await prisma.user.delete({ where: { id: user.id } });
    await redis.flushdb();
    await prisma.$disconnect();
    redis.disconnect();
  }
  process.send({ id, ...result });
  if (op === "close") process.exit(0);
});

process.send({ ready: true, url: `http://127.0.0.1:${server.address().port}`, apiKey: key });
