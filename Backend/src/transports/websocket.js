import { randomBytes } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { env } from "../config/env.js";
import { authenticateKey } from "../middleware/apiKeyAuth.js";
import { toGatewayError } from "../middleware/errorHandler.js";
import { generateRequestId } from "../middleware/requestId.js";
import { discardUsage, trackUsage } from "../modules/usage/usageRecorder.js";
import { GatewayError } from "../utils/errors.js";
import { errorMessage, parseClientMessage } from "./wsProtocol.js";

/**
 * /v1/ws: streaming chat over one long-lived connection (README section 19). Transport
 * only, like sse.js: every chat goes through gateway.stream(), the same code as SSE.
 *
 * Lifecycle of a socket:
 *   1. upgrade on /v1/ws (any other path gets 404)
 *   2. the first message must be { type: "auth", apiKey } within 5 s, or the socket closes
 *   3. then chat / cancel / ping, several chats streaming at once, told apart by requestId
 *   4. closing the socket (or the heartbeat finding it dead) cancels every chat in progress
 */

export const WS_PATH = "/v1/ws";
export const AUTH_TIMEOUT_MS = 5_000;
// Protocol-level pings find connections that died without a close (a laptop lid shut,
// a mobile network change), so their provider calls are cancelled too.
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const MAX_IN_FLIGHT = 3;

// Application close codes live in 4000-4999 (RFC 6455 section 7.4.2).
export const CLOSE_CODES = Object.freeze({
  AUTH_FAILED: 4401,
  AUTH_TIMEOUT: 4408,
  GOING_AWAY: 1001,
  INTERNAL_ERROR: 1011,
});

// A cancel from the client is reported back; a closed socket has nobody to tell.
const CANCELLED_BY_CLIENT = "cancelled by client";
const SOCKET_CLOSED = "socket closed";

/** "1mb" → 1048576, matching the HTTP body limit (MAX_BODY_SIZE). */
export function sizeToBytes(size) {
  const [, amount, unit] = /^(\d+)(b|kb|mb)$/i.exec(size);
  return Number(amount) * { b: 1, kb: 1024, mb: 1024 * 1024 }[unit.toLowerCase()];
}

/**
 * @param {import("node:http").Server} server  the same server Express runs on
 * @param {{
 *   gateway: ReturnType<typeof import("../gateway/gateway.service.js").createGateway>,
 *   keyLookup: ReturnType<typeof import("../modules/keys/keyLookup.js").createKeyLookup>,
 *   logger: import("pino").Logger,
 *   usage?: { record: (row: object) => void },
 *   authTimeoutMs?: number, heartbeatMs?: number, maxInFlight?: number,
 * }} deps  the timings and limits can be lowered in tests; usage is the usage writer (each
 *   chat records one row with transport "ws"; without it, rows are discarded)
 * @returns {{ wss: WebSocketServer, close: () => Promise<void> }}
 */
export function attachWebSocket(
  server,
  {
    gateway,
    keyLookup,
    logger,
    authTimeoutMs = AUTH_TIMEOUT_MS,
    heartbeatMs = HEARTBEAT_INTERVAL_MS,
    maxInFlight = MAX_IN_FLIGHT,
    usage = discardUsage,
  },
) {
  // A frame larger than this closes the socket (code 1009), like a 413 over HTTP.
  const wss = new WebSocketServer({ noServer: true, maxPayload: sizeToBytes(env.MAX_BODY_SIZE) });

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname !== WS_PATH) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => handleConnection(ws));

  // Every chat still running on any socket, so close() can wait until each has finished
  // and recorded its usage row.
  const chats = new Set();
  function track(chat) {
    chats.add(chat);
    chat.finally(() => chats.delete(chat));
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        // No pong since the last ping: the peer is gone. terminate() fires "close",
        // which cancels its requests.
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  function handleConnection(ws) {
    const started = performance.now();
    let log = logger.child({ connId: `ws_${randomBytes(8).toString("hex")}` });
    let apiKey = null;
    let requestsStarted = 0;
    // Chats that stopped on their own because the socket was already closing.
    let stoppedBySocket = 0;
    /** requestId → AbortController of each chat still in progress */
    const inFlight = new Map();

    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    /** Resolves true once written, false if the socket is no longer open. */
    function send(message) {
      if (ws.readyState !== WebSocket.OPEN) return Promise.resolve(false);
      return new Promise((resolve) => {
        // The callback runs once the frame is handed to the OS, so awaiting it applies
        // backpressure: a slow client slows down reading from the provider.
        ws.send(JSON.stringify(message), (err) => resolve(!err));
      });
    }

    function refuse(error, closeCode, reason) {
      send(errorMessage(error));
      ws.close(closeCode, reason);
    }

    const authTimer = setTimeout(() => {
      log.info("WebSocket closed: no auth message in time");
      refuse(
        new GatewayError(
          "UNAUTHORIZED",
          `Send { "type": "auth", "apiKey": "llmux_sk_…" } within ${authTimeoutMs / 1000} seconds of connecting`,
        ),
        CLOSE_CODES.AUTH_TIMEOUT,
        "Authentication timeout",
      );
    }, authTimeoutMs);

    async function authenticate(message) {
      if (message.type !== "auth") {
        refuse(
          new GatewayError("UNAUTHORIZED", 'The first message must be { "type": "auth" }'),
          CLOSE_CODES.AUTH_FAILED,
          "Authentication required",
        );
        return;
      }
      try {
        apiKey = await authenticateKey(message.apiKey, { lookup: keyLookup, log });
      } catch (err) {
        const error = toGatewayError(err);
        if (error.code === "INTERNAL_ERROR") {
          log.error({ err }, "WebSocket authentication failed");
          refuse(error, CLOSE_CODES.INTERNAL_ERROR, "Internal error");
        } else {
          refuse(error, CLOSE_CODES.AUTH_FAILED, "Authentication failed");
        }
        return;
      }
      clearTimeout(authTimer);
      // The timer may have closed the socket while the key was being looked up.
      if (ws.readyState !== WebSocket.OPEN) return;
      log = log.child({ keyId: apiKey.id });
      log.info("WebSocket authenticated");
      send({ type: "auth_ok" });
    }

    async function runChat({ type: _type, requestId, ...body }) {
      if (inFlight.has(requestId)) {
        send(
          errorMessage(
            new GatewayError(
              "INVALID_REQUEST",
              "A request with this requestId is already in progress",
            ),
            requestId,
          ),
        );
        return;
      }
      if (inFlight.size >= maxInFlight) {
        send(
          errorMessage(
            new GatewayError(
              "RATE_LIMITED",
              `At most ${maxInFlight} requests can be in progress on one socket; wait for one to end`,
            ),
            requestId,
          ),
        );
        return;
      }

      const controller = new AbortController();
      inFlight.set(requestId, controller);
      requestsStarted += 1;
      const id = generateRequestId();
      const chatLog = log.child({ reqId: id, wsRequestId: requestId });
      const request = { ...body, stream: true };
      // One usage row per chat, under the server's request ID (client requestIds repeat
      // across sockets).
      const tracker = trackUsage({
        usage,
        requestId: id,
        apiKeyId: apiKey.id,
        request,
        transport: "ws",
        log: chatLog,
      });

      let outcome = {};
      try {
        const events = gateway.stream(request, {
          requestId: id,
          signal: controller.signal,
          log: chatLog,
          onFinish: tracker.onFinish,
        });
        for await (const event of events) {
          // false: the socket is closing or closed. Stopping the loop cancels the provider
          // call. This can happen before the socket's "close" event, so the chat is counted
          // here for that event's log line.
          if (!(await send({ ...event, requestId }))) {
            outcome = { cancelled: true };
            stoppedBySocket += 1;
            break;
          }
        }
      } catch (err) {
        if (controller.signal.aborted) {
          outcome = { cancelled: true };
          if (controller.signal.reason === CANCELLED_BY_CLIENT) {
            chatLog.info("Client cancelled; provider call cancelled");
            send({ type: "cancelled", requestId });
          }
          return;
        }
        const error = toGatewayError(err);
        outcome = { error };
        if (error.code === "INTERNAL_ERROR") chatLog.error({ err }, "WebSocket chat failed");
        send(errorMessage(error, requestId));
      } finally {
        inFlight.delete(requestId);
        tracker.finish(outcome);
      }
    }

    function cancel({ requestId }) {
      const controller = inFlight.get(requestId);
      if (!controller) {
        send(
          errorMessage(
            new GatewayError("NOT_FOUND", "No request with this requestId is in progress"),
            requestId,
          ),
        );
        return;
      }
      controller.abort(CANCELLED_BY_CLIENT);
    }

    async function handle(data, isBinary) {
      let message;
      try {
        message = parseClientMessage(data, isBinary);
      } catch (err) {
        if (!apiKey) {
          refuse(err, CLOSE_CODES.AUTH_FAILED, "Authentication required");
        } else {
          send(errorMessage(err, err.requestId));
        }
        return;
      }

      if (!apiKey) return authenticate(message);

      switch (message.type) {
        case "chat":
          // Not awaited: the chat streams in the background so the socket keeps
          // handling other messages (a cancel, another chat) meanwhile.
          track(runChat(message).catch((err) => log.error({ err }, "WebSocket chat crashed")));
          return;
        case "cancel":
          return cancel(message);
        case "ping":
          return send({ type: "pong" });
        case "auth":
          return send(errorMessage(new GatewayError("INVALID_REQUEST", "Already authenticated")));
      }
    }

    // Messages are handled one after another, so a chat sent straight after auth (before
    // auth_ok arrives) waits for the key check instead of being refused.
    let queue = Promise.resolve();
    ws.on("message", (data, isBinary) => {
      queue = queue
        .then(() => handle(data, isBinary))
        .catch((err) => log.error({ err }, "WebSocket message handler failed"));
    });

    ws.on("close", (code) => {
      clearTimeout(authTimer);
      // Those still running now, plus those that already stopped because the socket was
      // closing: both were cut off by the client going away.
      const cancelled = inFlight.size + stoppedBySocket;
      for (const controller of inFlight.values()) controller.abort(SOCKET_CLOSED);
      log.info(
        {
          code,
          requests: requestsStarted,
          cancelled,
          durationMs: Math.round(performance.now() - started),
        },
        cancelled > 0 ? "WebSocket closed; provider calls cancelled" : "WebSocket closed",
      );
    });

    ws.on("error", (err) => log.warn({ err }, "WebSocket error"));
  }

  return {
    wss,
    /**
     * For shutdown: closes every socket (cancelling their chats) and stops the heartbeat.
     * Resolves once the sockets are closed and every chat has recorded its usage.
     */
    async close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.close(CLOSE_CODES.GOING_AWAY, "Server shutting down");
      await new Promise((resolve) => wss.close(() => resolve()));
      await Promise.allSettled([...chats]);
    },
  };
}
