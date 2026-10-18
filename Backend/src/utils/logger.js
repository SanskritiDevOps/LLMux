import pino from "pino";
import { env } from "../config/env.js";

// Anything that can carry a credential is masked before it is written.
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'req.headers["x-goog-api-key"]',
  'res.headers["set-cookie"]',
  "*.apiKey",
  "*.password",
];

/**
 * @param {{ level?: string, pretty?: boolean }} [options]
 * @param {import("pino").DestinationStream} [destination] where to write; tests pass a capture stream
 */
export function createLogger(options = {}, destination) {
  const { level = env.LOG_LEVEL, pretty = env.NODE_ENV === "development" } = options;

  const config = {
    level,
    base: { service: "llmux" },
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  };

  // pino-pretty is a dev dependency, so it is only loaded in development.
  if (pretty && !destination) {
    config.transport = { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss" } };
  }

  return destination ? pino(config, destination) : pino(config);
}

export const logger = createLogger();
