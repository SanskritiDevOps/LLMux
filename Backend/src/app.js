import cors from "cors";
import express from "express";
import helmet from "helmet";
import { checkDatabase } from "./config/db.js";
import { env } from "./config/env.js";
import { checkRedis } from "./config/redis.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { httpLogger } from "./middleware/httpLogger.js";
import { requestId } from "./middleware/requestId.js";
import { systemRoutes } from "./routes/system.routes.js";
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
 * @param {(app: import("express").Express) => void} [deps.extraRoutes] tests register
 *   throwaway routes here so they sit before the 404 and error handlers
 */
export function createApp({
  logger = defaultLogger,
  readinessChecks = defaultChecks,
  extraRoutes,
} = {}) {
  const app = express();

  // Request ID first, so every later log line and error can be traced.
  app.use(requestId());
  app.use(httpLogger(logger));

  app.use(helmet());
  // Only the dashboard is allowed to call the API from a browser.
  app.use(cors({ origin: env.DASHBOARD_URL }));
  app.use(express.json({ limit: env.MAX_BODY_SIZE }));

  app.use(systemRoutes(readinessChecks));

  extraRoutes?.(app);

  // Always last: anything unmatched becomes a 404, anything thrown becomes the unified error body.
  app.use(notFound());
  app.use(errorHandler());

  return app;
}
