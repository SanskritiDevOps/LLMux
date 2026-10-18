import { Redis } from "ioredis";
import { logger } from "../utils/logger.js";
import { env } from "./env.js";

export const redis = new Redis(env.REDIS_URL, {
  // Connect on the first command, so importing this file (for example in tests) opens nothing.
  lazyConnect: true,
  // Fail a command after one reconnect attempt instead of queueing it for ~20 retries.
  // Callers (cache, rate limiter) decide what to do when Redis is down.
  maxRetriesPerRequest: 1,
  connectTimeout: 5_000,
});

// ioredis emits an error on every failed reconnect attempt (about every 2 s while Redis
// is down). Log only the transitions, so an outage is one warning, not a flood.
let healthy = true;
redis.on("error", (err) => {
  if (healthy) {
    logger.warn({ err }, "Redis connection lost; retrying in the background");
    healthy = false;
  }
});
redis.on("ready", () => {
  if (!healthy) {
    logger.info("Redis connection restored");
    healthy = true;
  }
});

/** Resolves when Redis answers PING; rejects otherwise. */
export async function checkRedis() {
  const reply = await redis.ping();
  if (reply !== "PONG") {
    throw new Error(`Unexpected PING reply: ${reply}`);
  }
}
