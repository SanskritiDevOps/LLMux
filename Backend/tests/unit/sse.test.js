import { EventEmitter } from "node:events";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSseWriter, HEARTBEAT_INTERVAL_MS } from "../../src/transports/sse.js";

/**
 * Enough of an Express response to drive the writer by hand: `write` returns whatever
 * `accepting` says, so a test can play a slow client.
 */
function fakeResponse() {
  const res = new EventEmitter();
  Object.assign(res, {
    written: [],
    headers: {},
    statusCode: undefined,
    accepting: true,
    destroyed: false,
    writableEnded: false,
    status(code) {
      res.statusCode = code;
      return res;
    },
    set(headers) {
      Object.assign(res.headers, headers);
      return res;
    },
    flushHeaders: vi.fn(),
    write(text) {
      res.written.push(text);
      return res.accepting;
    },
    end() {
      res.writableEnded = true;
    },
    hangUp() {
      res.destroyed = true;
      res.emit("close");
    },
  });
  return res;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createSseWriter", () => {
  it("sends SSE headers immediately when opened", () => {
    const res = fakeResponse();
    createSseWriter(res).open();

    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    expect(res.flushHeaders).toHaveBeenCalledOnce();
  });

  it("writes each event as an event line, one data line and a blank line", async () => {
    const res = fakeResponse();
    const sse = createSseWriter(res);
    sse.open();

    expect(await sse.send({ type: "delta", text: "line one\nline two" })).toBe(true);
    expect(res.written).toEqual(['event: delta\ndata: {"text":"line one\\nline two"}\n\n']);
  });

  it("waits for drain when the client is reading slowly", async () => {
    const res = fakeResponse();
    const sse = createSseWriter(res);
    sse.open();
    res.accepting = false;

    let settled = false;
    const sent = sse.send({ type: "delta", text: "a" }).then((value) => {
      settled = true;
      return value;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    res.emit("drain");
    expect(await sent).toBe(true);
    expect(res.listenerCount("drain")).toBe(0);
  });

  it("resolves false when the client disconnects while it is waiting", async () => {
    const res = fakeResponse();
    const sse = createSseWriter(res);
    sse.open();
    res.accepting = false;

    const sent = sse.send({ type: "delta", text: "a" });
    res.hangUp();

    expect(await sent).toBe(false);
  });

  it("returns false and writes nothing once the client has gone", async () => {
    const res = fakeResponse();
    const sse = createSseWriter(res);
    sse.open();
    res.hangUp();

    expect(await sse.send({ type: "delta", text: "a" })).toBe(false);
    expect(res.written).toEqual([]);
  });

  it("sends a heartbeat comment every 15 seconds", () => {
    vi.useFakeTimers();
    const res = fakeResponse();
    createSseWriter(res).open();

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS - 1);
    expect(res.written).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(res.written).toEqual([": heartbeat\n\n"]);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(res.written).toHaveLength(2);
  });

  it("skips heartbeats while waiting for drain", () => {
    vi.useFakeTimers();
    const res = fakeResponse();
    const sse = createSseWriter(res, { heartbeatMs: 100 });
    sse.open();
    res.accepting = false;
    sse.send({ type: "delta", text: "a" });

    vi.advanceTimersByTime(500);

    expect(res.written).toHaveLength(1);
  });

  it("stops the heartbeat on close and when the client disconnects", () => {
    vi.useFakeTimers();
    const closed = fakeResponse();
    const sse = createSseWriter(closed, { heartbeatMs: 100 });
    sse.open();
    sse.close();
    sse.close();

    const gone = fakeResponse();
    createSseWriter(gone, { heartbeatMs: 100 }).open();
    gone.hangUp();

    vi.advanceTimersByTime(1000);
    expect(closed.written).toEqual([]);
    expect(closed.writableEnded).toBe(true);
    expect(gone.written).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("streams events a real HTTP client can read as they arrive", async () => {
    const server = http.createServer(async (_req, res) => {
      // Node's own response has no Express helpers, so add the two the writer uses.
      res.status = (code) => ((res.statusCode = code), res);
      res.set = (headers) => {
        for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
        return res;
      };
      const sse = createSseWriter(res);
      sse.open();
      await sse.send({ type: "start", id: "req_1" });
      await sse.send({ type: "delta", text: "Hi" });
      sse.close();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}`);

      expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      expect(await response.text()).toBe(
        'event: start\ndata: {"id":"req_1"}\n\nevent: delta\ndata: {"text":"Hi"}\n\n',
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
