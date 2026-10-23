import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendRequest } from "../../src/providers/httpClient.js";
import { GatewayError } from "../../src/utils/errors.js";

// A tiny local server standing in for a provider; no real provider is ever called.
let server;
let baseUrl;
const received = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      received.push({ url: req.url, method: req.method, headers: req.headers, raw });

      const routes = {
        "/ok": () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ hello: "world" }));
        },
        "/error-json": () => {
          res.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
          res.end(JSON.stringify({ error: { code: "rate_limit_exceeded" } }));
        },
        "/error-html": () => {
          res.writeHead(502, { "content-type": "text/html" });
          res.end("<html>Bad gateway</html>");
        },
        "/truncated-json": () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"candidates": [');
        },
        "/empty": () => {
          res.writeHead(204);
          res.end();
        },
        "/slow-headers": () => setTimeout(() => res.end("{}"), 1000),
        "/slow-body": () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.write('{"partial":');
          setTimeout(() => res.end("true}"), 1000);
        },
      };
      (routes[req.url] ?? routes["/ok"])();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const send = (path, options = {}) =>
  sendRequest(
    { url: `${baseUrl}${path}`, headers: options.headers, body: options.body ?? { q: 1 } },
    // Generous unless a test is about timeouts: the first connection on a busy machine can
    // take a few hundred milliseconds, which once made this suite flaky.
    { provider: "gemini", timeoutMs: options.timeoutMs ?? 5000, signal: options.signal },
  );

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the request to fail");
}

describe("sendRequest", () => {
  it("POSTs a JSON body with the given headers and returns the parsed response", async () => {
    const res = await send("/ok", { headers: { "x-goog-api-key": "k" }, body: { a: 1 } });

    expect(res).toMatchObject({ ok: true, status: 200, body: { hello: "world" } });
    expect(res.durationMs).toBeTypeOf("number");
    const request = received.at(-1);
    expect(request.method).toBe("POST");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.headers["x-goog-api-key"]).toBe("k");
    expect(JSON.parse(request.raw)).toEqual({ a: 1 });
  });

  it("resolves (does not throw) for HTTP errors so the adapter can map them", async () => {
    const res = await send("/error-json");

    expect(res).toMatchObject({
      ok: false,
      status: 429,
      body: { error: { code: "rate_limit_exceeded" } },
    });
    expect(res.headers.get("retry-after")).toBe("7");
  });

  it("returns non-JSON error pages as text", async () => {
    const res = await send("/error-html");

    expect(res).toMatchObject({ ok: false, status: 502, body: "<html>Bad gateway</html>" });
  });

  it("returns a truncated JSON body as text instead of crashing", async () => {
    const res = await send("/truncated-json");

    expect(res.body).toBe('{"candidates": [');
  });

  it("returns null for an empty body", async () => {
    expect((await send("/empty")).body).toBeNull();
  });

  it("turns a provider that never answers into a retryable TIMEOUT", async () => {
    const err = await rejection(send("/slow-headers", { timeoutMs: 100 }));

    expect(err).toBeInstanceOf(GatewayError);
    expect(err).toMatchObject({ code: "TIMEOUT", provider: "gemini", retryable: true });
    expect(err.message).toBe("gemini did not respond within 100 ms");
  });

  it("also times out a provider that stalls in the middle of the body", async () => {
    const err = await rejection(send("/slow-body", { timeoutMs: 100 }));

    expect(err.code).toBe("TIMEOUT");
  });

  it("turns an unreachable provider into a retryable PROVIDER_UNAVAILABLE", async () => {
    const err = await rejection(
      sendRequest(
        { url: "http://127.0.0.1:1/never", body: {} },
        { provider: "ollama", timeoutMs: 2000 },
      ),
    );

    expect(err).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      provider: "ollama",
      retryable: true,
    });
    expect(err.cause).toBeInstanceOf(Error);
  });

  it("rethrows the caller's abort unchanged, not as a provider failure", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const err = await rejection(
      send("/slow-headers", { timeoutMs: 5000, signal: controller.signal }),
    );

    expect(err).not.toBeInstanceOf(GatewayError);
    expect(err.name).toBe("AbortError");
  });

  it("fails immediately when the caller already aborted", async () => {
    const err = await rejection(send("/ok", { signal: AbortSignal.abort() }));

    expect(err.name).toBe("AbortError");
  });
});
