import http from "node:http";

const SHUTDOWN_TIMEOUT_MS = 10_000;

// Imported dynamically so an invalid environment prints its readable message
// and exits, instead of crashing with a stack trace before any code runs.
// console is used here because the logger itself depends on a valid environment.
let env, createApp, logger, prisma, redis;
let createGateway, createKeysRepository, createKeyLookup, attachWebSocket, createUsageWriter;
let createCircuitBreaker, createTokenBucket;
try {
  ({ env } = await import("./config/env.js"));
  // Validates aliases, fallback chains and prices; a typo there stops startup here.
  await import("./config/models.js");
  ({ logger } = await import("./utils/logger.js"));
  ({ prisma } = await import("./config/db.js"));
  ({ redis } = await import("./config/redis.js"));
  ({ createApp } = await import("./app.js"));
  ({ createGateway } = await import("./gateway/gateway.service.js"));
  ({ createKeysRepository } = await import("./modules/keys/keys.repository.js"));
  ({ createKeyLookup } = await import("./modules/keys/keyLookup.js"));
  ({ attachWebSocket } = await import("./transports/websocket.js"));
  ({ createUsageWriter } = await import("./modules/usage/usageWriter.js"));
  ({ createCircuitBreaker } = await import("./gateway/circuitBreaker.js"));
  ({ createTokenBucket } = await import("./modules/ratelimit/tokenBucket.js"));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// One gateway and one key lookup for both transports, so HTTP and WebSocket behave alike.
// The circuit breaker keeps its state in Redis, so every instance skips the same providers.
const breaker = createCircuitBreaker({ redis, logger });
const gateway = createGateway({ breaker });
const keys = createKeysRepository();
const keyLookup = createKeyLookup({ keys, redis });
// Every chat on either transport writes one usage row, in batches, off the request path.
const usage = createUsageWriter({ logger });
// One rate limiter for both transports: a key's HTTP requests and WebSocket chats share a bucket.
const limiter = createTokenBucket({ redis, logger });

// A plain HTTP server (not app.listen) so the WebSocket server can share its port.
const server = http.createServer(
  createApp({ logger, gateway, keys, redis, usage, limiter, breaker }),
);
const websocket = attachWebSocket(server, { gateway, keyLookup, logger, usage, limiter });

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    logger.fatal(`Port ${env.PORT} is already in use. Stop the other process or change PORT.`);
  } else {
    logger.fatal({ err }, "Server error");
  }
  process.exit(1);
});

server.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, env: env.NODE_ENV },
    `LLMux listening on http://localhost:${env.PORT}`,
  );
});

/** Closes Postgres and Redis connections; never throws, so shutdown always completes. */
async function closeConnections() {
  const results = await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
  for (const result of results) {
    if (result.status === "rejected") {
      logger.warn({ err: result.reason }, "Error while closing a connection");
    }
  }
}

let shuttingDown = false;

function shutdown(signal) {
  // A second Ctrl+C while closing must not start a second shutdown.
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");

  // Stop accepting new connections and let in-flight requests finish,
  // write the usage rows they recorded, then close the database connections.
  // WebSockets would otherwise stay open until the forced exit; closing them also
  // cancels their provider calls, and clients see 1001 "going away" and can reconnect.
  // It resolves once their chats have recorded usage.
  const websocketClosed = websocket.close();
  server.close(async () => {
    await websocketClosed;
    await usage.close();
    await closeConnections();
    process.exit(0);
  });
  server.closeIdleConnections();

  // Long-lived streams must not block a deploy forever.
  setTimeout(() => {
    logger.error("Forcing shutdown after timeout");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
