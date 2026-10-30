import { useCallback, useRef, useState } from "react";
import { apiUrl, readResponse } from "../../api/client.js";
import { readSseEvents } from "../../lib/sse.js";

const IDLE = { status: "idle", text: "", provider: null, ttftMs: null, end: null, error: null };

/**
 * One playground panel's stream: POST /api/playground/chat, then the SSE events as they
 * arrive.
 *
 *   status  idle → waiting (sent, nothing back yet) → streaming (first token in)
 *           → done | error | stopped
 *
 * An error before the stream starts is a normal JSON error (an ApiError, with its
 * requestId). An `error` event after it starts keeps the text so far, as the API does.
 * The time to first token is measured here, from sending to the first `delta`; the total
 * latency, usage and cost come from the server's `end` event.
 */
export function usePlaygroundStream() {
  const [state, setState] = useState(IDLE);
  const controller = useRef(null);

  const run = useCallback(async (body) => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const sentAt = performance.now();
    setState({ ...IDLE, status: "waiting" });

    try {
      const res = await fetch(apiUrl("/api/playground/chat"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      // Not a stream: a JSON error, thrown as an ApiError.
      if (!res.ok || !res.headers.get("content-type")?.startsWith("text/event-stream")) {
        await readResponse(res);
        return;
      }

      for await (const event of readSseEvents(res.body)) {
        if (event.type === "start") {
          setState((s) => ({ ...s, provider: event.provider, requestId: event.id }));
        } else if (event.type === "delta") {
          setState((s) => ({
            ...s,
            status: "streaming",
            text: s.text + event.text,
            ttftMs: s.ttftMs ?? Math.round(performance.now() - sentAt),
          }));
        } else if (event.type === "end") {
          setState((s) => ({ ...s, status: "done", end: event }));
        } else if (event.type === "error") {
          setState((s) => ({
            ...s,
            status: "error",
            error: { code: event.code, message: event.message, requestId: s.requestId },
          }));
        }
      }
      // The connection closed without `end` or `error`: the answer may be cut off.
      setState((s) =>
        s.status === "waiting" || s.status === "streaming"
          ? {
              ...s,
              status: "error",
              error: { code: "STREAM_CLOSED", message: "The stream ended before the answer did." },
            }
          : s,
      );
    } catch (error) {
      if (abort.signal.aborted) {
        setState((s) => ({ ...s, status: "stopped" }));
        return;
      }
      setState((s) => ({ ...s, status: "error", error }));
    }
  }, []);

  const stop = useCallback(() => controller.current?.abort(), []);
  const reset = useCallback(() => {
    controller.current?.abort();
    setState(IDLE);
  }, []);

  return { ...state, run, stop, reset };
}
