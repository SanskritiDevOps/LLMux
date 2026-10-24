/**
 * Writes unified stream events to an HTTP response as Server-Sent Events.
 * Transport only: it never knows which provider produced the events (README section 11).
 *
 *   event: delta
 *   data: {"text":"Morning: "}
 *   (blank line)
 *
 * Two rules keep long streams healthy:
 *   - backpressure: when res.write() returns false the client is reading slower than the
 *     provider writes, so send() waits for "drain" instead of buffering without limit
 *   - heartbeat: an SSE comment every 15 s keeps idle proxies and load balancers from
 *     closing a connection while a slow model is still thinking
 */

export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * @param {import("express").Response} res
 * @param {{ heartbeatMs?: number }} [options]
 */
export function createSseWriter(res, { heartbeatMs = HEARTBEAT_INTERVAL_MS } = {}) {
  let heartbeat;
  let waitingForDrain = false;

  const isOpen = () => !res.destroyed && !res.writableEnded;

  function stopHeartbeat() {
    clearInterval(heartbeat);
    heartbeat = undefined;
  }

  /** Resolves true once the client has caught up, or false if the connection closed. */
  function drained() {
    waitingForDrain = true;
    return new Promise((resolve) => {
      const finish = (caughtUp) => {
        res.off("drain", onDrain);
        res.off("close", onClose);
        waitingForDrain = false;
        resolve(caughtUp);
      };
      const onDrain = () => finish(true);
      const onClose = () => finish(false);
      res.on("drain", onDrain);
      res.on("close", onClose);
    });
  }

  return {
    /** Sends the headers straight away, so the client knows the stream has started. */
    open() {
      res.status(200);
      res.set({
        "Content-Type": "text/event-stream; charset=utf-8",
        // no-transform stops proxies from compressing (and so buffering) the stream.
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // nginx buffers proxied responses unless told not to.
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();

      heartbeat = setInterval(() => {
        // Skipped while backpressured: the client is behind, and the connection is clearly
        // not idle.
        if (isOpen() && !waitingForDrain) res.write(": heartbeat\n\n");
      }, heartbeatMs);
      heartbeat.unref();
      res.once("close", stopHeartbeat);
    },

    /**
     * @param {{ type: string } & Record<string, unknown>} event  a StreamEventSchema event
     * @returns {Promise<boolean>} false when the client has gone and nothing more can be sent
     */
    async send({ type, ...data }) {
      if (!isOpen()) return false;
      // JSON.stringify never emits a raw newline, so one data: line always holds the event.
      const ok = res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      if (ok) return true;
      return drained();
    },

    /** Ends the response. Safe to call more than once, and after the client has gone. */
    close() {
      stopHeartbeat();
      if (isOpen()) res.end();
    },
  };
}
