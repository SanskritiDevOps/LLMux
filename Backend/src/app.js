import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";

/**
 * Builds the Express app without starting a server, so tests can drive it
 * with Supertest and server.js can attach WebSockets to the same HTTP server.
 */
export function createApp() {
  const app = express();

  app.use(helmet());
  // Only the dashboard is allowed to call the API from a browser.
  app.use(cors({ origin: env.DASHBOARD_URL }));
  app.use(express.json({ limit: env.MAX_BODY_SIZE }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  return app;
}
