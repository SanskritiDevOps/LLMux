import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openStream } from "../../src/providers/httpClient.js";
import { GatewayError } from "../../src/utils/errors.js";

// A local server that streams like a provider; no real provider is ever called.
let server;
let baseUrl;
// Set when a streaming response's connection closes before it finished.
const closedEarly = new Set();

const write = (res, pieces, gapMs, then) => {
  const [first, ...rest] = pieces;
  if (first === undefined) return then();
  res.write(first);
  setTimeout(() => write(res, rest, gapMs, then), gapMs);
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.on("close", () => {
        if (!res.writableFinished) closedEarly.add(req.url);
      });
      const stream = () => res.writeHead(200, { "content-type": "text/event-stream" });

      const routes = {
        "/stream": () => {
          stream();
          write(res, ["one ", "two ", "three"], 20, () => res.end());
        },
        // The whole answer takes longer than the idle limit, but no single gap does.
        "/stream-long": () => {
          stream();
          write(res, ["a", "b", "c", "d", "e"], 300, () => res.end());
        },
        "/stream-stall": () => {
          stream();
          res.write("first");
        },
        "/stream-drop": () => {
          stream();
          res.write("first");
          setTimeout(() => res.socket.destroy(), 50);
        },
        "/stream-endless": () => {
          stream();
          const timer = setInterval(() => res.write("tick "), 20);
          res.on("close", () => clearInterval(timer));
        },
        "/error": () => {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "overloaded" } }));
        },
        "/slow-headers": () => setTimeout(() => res.end("late"), 1000),
      };
      // Query strings only label requests, so tests can tell their connections apart.
      routes[req.url.split("?")[0]]();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const open = (path, options = {}) =>
  openStream(
    { url: `${baseUrl}${path}`, body: { q: 1 } },
    // Generous unless a test is about timeouts (see the timing rule in the testing doc).
    { provider: "gemini", timeoutMs: options.timeoutMs ?? 5000, signal: options.signal },
  );

async function readAll(chunks) {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
  return text;
}

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the stream to fail");
}

describe("openStream", () => {
  it("resolves when the headers arrive and yields the body as it streams", async () => {
    const res = await open("/stream");

    expect(res).toMatchObject({ ok: true, status: 200, body: null });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await readAll(res.chunks)).toBe("one two three");
  });

  it("reads an error response whole, like sendRequest, so mapError can use it", async () => {
    const res = await open("/error");

    expect(res).toMatchObject({
      ok: false,
      status: 503,
      body: { error: { message: "overloaded" } },
    });
    expect(res.chunks).toBeUndefined();
  });

  it("applies the timeout to each gap, not to the whole answer", async () => {
    const res = await open("/stream-long", { timeoutMs: 1000 });

    expect(await readAll(res.chunks)).toBe("abcde");
  });

  it("turns a provider that goes silent mid-stream into a retryable TIMEOUT", async () => {
    const res = await open("/stream-stall", { timeoutMs: 200 });
    const err = await rejection(readAll(res.chunks));

    expect(err).toBeInstanceOf(GatewayError);
    expect(err).toMatchObject({ code: "TIMEOUT", provider: "gemini", retryable: true });
    expect(err.message).toBe("gemini went silent for 200 ms");
  });

  it("times out a provider that never sends headers", async () => {
    const err = await rejection(open("/slow-headers", { timeoutMs: 100 }));

    expect(err).toMatchObject({ code: "TIMEOUT" });
    expect(err.message).toBe("gemini did not respond within 100 ms");
  });

  it("turns a dropped connection mid-stream into PROVIDER_UNAVAILABLE", async () => {
    const res = await open("/stream-drop");
    const err = await rejection(readAll(res.chunks));

    expect(err).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      provider: "gemini",
      retryable: true,
    });
    expect(err.message).toBe("Lost the connection to gemini");
  });

  it("turns an unreachable provider into PROVIDER_UNAVAILABLE", async () => {
    const err = await rejection(
      openStream({ url: "http://127.0.0.1:1/never", body: {} }, { provider: "ollama" }),
    );

    expect(err).toMatchObject({ code: "PROVIDER_UNAVAILABLE", provider: "ollama" });
  });

  it("rethrows the caller's abort mid-stream unchanged", async () => {
    const controller = new AbortController();
    const res = await open("/stream-endless", { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);

    const err = await rejection(readAll(res.chunks));

    expect(err).not.toBeInstanceOf(GatewayError);
    expect(err.name).toBe("AbortError");
  });

  it("closes the upstream connection when the reader stops early", async () => {
    const res = await open("/stream-endless?stops-early");
    await res.chunks.next();
    await res.chunks.return();

    await expect.poll(() => closedEarly.has("/stream-endless?stops-early")).toBe(true);
  });
});
