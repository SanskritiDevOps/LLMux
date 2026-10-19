import http from "node:http";

const SHUTDOWN_TIMEOUT_MS = 10_000;

// Imported dynamically so an invalid environment prints its readable message
// and exits, instead of crashing with a stack trace before any code runs.
// console is used here because the logger itself depends on a valid environment.
let env, createApp, logger, prisma, redis;
try {
  ({ env } = await import("./config/env.js"));
  // Validates aliases, fallback chains and prices; a typo there stops startup here.
  await import("./config/models.js");
  ({ logger } = await import("./utils/logger.js"));
  ({ prisma } = await import("./config/db.js"));
  ({ redis } = await import("./config/redis.js"));
  ({ createApp } = await import("./app.js"));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// A plain HTTP server (not app.listen) so the WebSocket server can share it later.
const server = http.createServer(createApp({ logger }));

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
  // then close the database connections those requests were using.
  server.close(async () => {
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
