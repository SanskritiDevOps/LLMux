import http from "node:http";

const SHUTDOWN_TIMEOUT_MS = 10_000;

// Imported dynamically so an invalid environment prints its readable message
// and exits, instead of crashing with a stack trace before any code runs.
let env, createApp;
try {
  ({ env } = await import("./config/env.js"));
  ({ createApp } = await import("./app.js"));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// A plain HTTP server (not app.listen) so the WebSocket server can share it later.
const server = http.createServer(createApp());

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${env.PORT} is already in use. Stop the other process or change PORT.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(env.PORT, () => {
  console.log(`LLMux listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

function shutdown(signal) {
  console.log(`${signal} received, closing server`);

  // Stop accepting new connections and let in-flight requests finish.
  server.close(() => process.exit(0));
  server.closeIdleConnections();

  // Long-lived streams must not block a deploy forever.
  setTimeout(() => {
    console.error("Forcing shutdown after timeout");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
