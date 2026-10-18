import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { httpLogger } from "./middleware/httpLogger.js";
import { requestId } from "./middleware/requestId.js";
import { logger as defaultLogger } from "./utils/logger.js";

/**
 * Builds the Express app without starting a server, so tests can drive it
 * with Supertest and server.js can attach WebSockets to the same HTTP server.
 *
 * @param {{ logger?: import("pino").Logger }} [deps] tests pass a logger that writes to memory
 */
export function createApp({ logger = defaultLogger } = {}) {
  const app = express();

  // Request ID first, so every later log line and error can be traced.
  app.use(requestId());
  app.use(httpLogger(logger));

  app.use(helmet());
  // Only the dashboard is allowed to call the API from a browser.
  app.use(cors({ origin: env.DASHBOARD_URL }));
  app.use(express.json({ limit: env.MAX_BODY_SIZE }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  return app;
}
