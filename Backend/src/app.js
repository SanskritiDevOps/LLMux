import cors from "cors";
import express from "express";
import helmet from "helmet";
import { checkDatabase } from "./config/db.js";
import { env } from "./config/env.js";
import { checkRedis, redis as defaultRedis } from "./config/redis.js";
import { createGateway } from "./gateway/gateway.service.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { httpLogger } from "./middleware/httpLogger.js";
import { requestId } from "./middleware/requestId.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { createUsersRepository } from "./modules/auth/users.repository.js";
import { createKeysRepository } from "./modules/keys/keys.repository.js";
import { keysRoutes } from "./modules/keys/keys.routes.js";
import { systemRoutes } from "./routes/system.routes.js";
import { EXPOSED_HEADERS, v1Routes } from "./routes/v1.routes.js";
import { logger as defaultLogger } from "./utils/logger.js";

const defaultChecks = { database: checkDatabase, redis: checkRedis };

/**
 * Builds the Express app without starting a server, so tests can drive it
 * with Supertest and server.js can attach WebSockets to the same HTTP server.
 *
 * @param {object} [deps]
 * @param {import("pino").Logger} [deps.logger] tests pass a logger that writes to memory
 * @param {Record<string, () => Promise<void>>} [deps.readinessChecks] tests pass fakes
 *   so /ready can be tested without real Postgres or Redis
 * @param {ReturnType<typeof createGateway>} [deps.gateway] tests pass a fake or a gateway
 *   pointed at the mock provider
 * @param {ReturnType<typeof createUsersRepository>} [deps.users] tests pass an in-memory
 *   repository; the default uses Postgres
 * @param {ReturnType<typeof createKeysRepository>} [deps.keys] gateway keys; tests pass an
 *   in-memory repository
 * @param {import("ioredis").Redis} [deps.redis] used for cached key lookups; tests pass an
 *   in-memory stand-in
 * @param {{ record: (row: object) => void }} [deps.usage] the usage writer; server.js passes
 *   the real one, and without it usage rows are discarded (tests pass a fake to inspect them)
 * @param {(app: import("express").Express) => void} [deps.extraRoutes] tests register
 *   throwaway routes here so they sit before the 404 and error handlers
 */
export function createApp({
  logger = defaultLogger,
  readinessChecks = defaultChecks,
  gateway = createGateway(),
  users = createUsersRepository(),
  keys = createKeysRepository(),
  redis = defaultRedis,
  usage,
  extraRoutes,
} = {}) {
  const app = express();

  // Request ID first, so every later log line and error can be traced.
  app.use(requestId());
  app.use(httpLogger(logger));

  app.use(helmet());
  // Only the dashboard is allowed to call the API from a browser, and it may send its
  // session cookie (credentials). Credentials require an exact origin, never "*".
  // exposedHeaders lets the dashboard read X-Request-Id and the X-LLMux-* headers.
  app.use(
    cors({ origin: env.DASHBOARD_URL, credentials: true, exposedHeaders: [...EXPOSED_HEADERS] }),
  );
  app.use(express.json({ limit: env.MAX_BODY_SIZE }));

  app.use(systemRoutes(readinessChecks));
  // keys and redis are what /v1 uses to check gateway keys.
  app.use("/v1", v1Routes({ gateway, keys, redis, usage }));
  app.use("/api/auth", authRoutes({ users }));
  app.use("/api/keys", keysRoutes({ users, keys, redis }));

  extraRoutes?.(app);

  // Always last: anything unmatched becomes a 404, anything thrown becomes the unified error body.
  app.use(notFound());
  app.use(errorHandler());

  return app;
}
