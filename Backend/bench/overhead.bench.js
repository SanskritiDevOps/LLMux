/**
 * Measures what LLMux itself costs (README section 28), against a mock provider that
 * answers instantly, so the time measured is the gateway's own.
 *
 *   npm run bench          (needs Docker: Postgres and Redis)
 *
 * Three processes, so none competes with another for its thread:
 *   - bench/mockServer.js     the mock provider (tests/mockProvider.js)
 *   - bench/gatewayServer.js  the real LLMux app: gateway key check (Redis-cached), the
 *                             rate limit (the real Lua script), validation, routing, the
 *                             adapter, the HTTP call, cost, and a usage row written to
 *                             Postgres in batches. Only the provider is fake.
 *   - this file               the requests, sequential timings and load (autocannon)
 *
 * What it reports:
 *   1. Latency one request at a time, direct versus through LLMux. The difference is the
 *      gateway's overhead, and it depends least on the machine.
 *   2. Throughput under load, with LLMux's /health as the machine's ceiling: an endpoint
 *      that does nothing shows how many requests a second this machine can serve at all.
 *   3. Time to first token for streams, direct versus through LLMux.
 *   4. Fallback time when the primary provider is down, before and after its circuit opens.
 *
 * It uses the llmux_test database and Redis database 2, and LLMux creates its own user and
 * key and removes them at the end, so development data is never touched.
 *
 * Settings: BENCH_CONNECTIONS (default 50), BENCH_DURATION in seconds (default 10),
 * BENCH_SAMPLES for the sequential runs (default 200).
 */
import { fork } from "node:child_process";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import autocannon from "autocannon";

const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS ?? 50);
const DURATION = Number(process.env.BENCH_DURATION ?? 10);
const SAMPLES = Number(process.env.BENCH_SAMPLES ?? 200);
// The fallback run waits out retries before the circuit opens, so it uses fewer samples.
const FALLBACK_SAMPLES = Math.min(SAMPLES, 30);

const childEnv = {
  ...process.env,
  DATABASE_URL: "postgresql://llmux:llmux@localhost:5432/llmux_test",
  REDIS_URL: "redis://localhost:6379/2",
  JWT_SECRET: process.env.JWT_SECRET ?? "bench-only-secret-at-least-32-characters-long",
  NODE_ENV: "production",
  LOG_LEVEL: "error",
};

/** Forks a bench process and returns its ready message plus a request/reply `call`. */
async function start(file, env) {
  const child = fork(new URL(file, import.meta.url), { env, stdio: "inherit" });
  const pending = new Map();
  let nextId = 0;
  const ready = await new Promise((resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`${file} exited with code ${code}`)));
    child.on("message", (message) => {
      if (message.ready) return resolve(message);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    });
  });
  const call = (message) =>
    new Promise((resolve) => {
      nextId += 1;
      pending.set(nextId, resolve);
      child.send({ id: nextId, ...message });
    });
  return { ...ready, call };
}

const sorted = (values) => [...values].sort((a, b) => a - b);
const percentile = (values, p) => {
  const s = sorted(values);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const median = (values) => percentile(values, 50);

/** Sends `count` requests one after another; returns each one's time in ms. */
async function sequential(count, send) {
  const times = [];
  for (let i = 0; i < count; i += 1) {
    const started = performance.now();
    await send();
    times.push(performance.now() - started);
  }
  return times;
}

/** One autocannon run; returns latency percentiles (ms) and throughput. */
async function load(label, { url, method = "POST", headers, body }) {
  const result = await autocannon({
    url,
    method,
    headers: body ? { "content-type": "application/json", ...headers } : headers,
    body: body && JSON.stringify(body),
    connections: CONNECTIONS,
    duration: DURATION,
  });
  // Requests still in flight when the run ends finish now, so they aren't counted in the
  // next run (they would show up there as provider calls).
  await sleep(1000);
  return {
    label,
    p50: result.latency.p50,
    p99: result.latency.p99,
    rps: Math.round(result.requests.average),
    failed: result.non2xx + result.errors + result.timeouts,
  };
}

/** Milliseconds from sending a streaming request to the first piece of answer text. */
async function timeToFirstText(url, { headers, body }, marker) {
  const started = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const decoder = new TextDecoder();
  let seen = "";
  let first = null;
  for await (const chunk of res.body) {
    seen += decoder.decode(chunk, { stream: true });
    if (first === null && seen.includes(marker)) first = performance.now() - started;
  }
  return first;
}

// ---- Setup ---------------------------------------------------------------------------

const mock = await start("./mockServer.js", process.env);
const llmux = await start("./gatewayServer.js", { ...childEnv, MOCK_URL: mock.url });

const auth = { authorization: `Bearer ${llmux.apiKey}` };
const messages = [{ role: "user", content: "Plan one day in Jaipur." }];
const noCache = { model: "gemini:gemini-3.5-flash-lite", messages, cache: false };
const cacheable = { model: "gemini:gemini-3.5-flash-lite", messages, temperature: 0 };
const geminiBody = { contents: [{ role: "user", parts: [{ text: "Plan one day in Jaipur." }] }] };
const directUrl = `${mock.url}/v1beta/models/gemini-3.5-flash-lite:generateContent`;
const chatUrl = `${llmux.url}/v1/chat`;

const postJson = (url, body, headers = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }).then((res) => res.json());
const chat = (body) => postJson(chatUrl, body, auth);

console.log(
  `LLMux benchmark · ${os.cpus()[0].model.trim()} · ${os.cpus().length} threads · ` +
    `${Math.round(os.totalmem() / 2 ** 30)} GB RAM · ${os.type()} · Node ${process.version}\n`,
);

// Warm-up, so JIT compilation and connection pools don't count.
await sequential(50, () => chat(noCache));
await sequential(50, () => postJson(directUrl, geminiBody));
await chat(cacheable); // the one miss that fills the cache
await mock.call({ op: "reset" });

// ---- 1. One request at a time ---------------------------------------------------------

const seqDirect = await sequential(SAMPLES, () => postJson(directUrl, geminiBody));
const seqLlmux = await sequential(SAMPLES, () => chat(noCache));
const seqHit = await sequential(SAMPLES, () => chat(cacheable));
await mock.call({ op: "reset" });

// ---- 2. Under load ------------------------------------------------------------------

const ceiling = await load("LLMux GET /health (this machine's ceiling)", {
  url: `${llmux.url}/health`,
  method: "GET",
});
const loadDirect = await load("Mock provider, called directly", {
  url: directUrl,
  body: geminiBody,
});
await mock.call({ op: "reset" });
const loadLlmux = await load("Through LLMux, no cache", {
  url: chatUrl,
  headers: auth,
  body: noCache,
});
await mock.call({ op: "reset" });
const loadHit = await load("Through LLMux, cache hit", {
  url: chatUrl,
  headers: auth,
  body: cacheable,
});
const { requests: providerCallsDuringHits } = await mock.call({ op: "count" });
await mock.call({ op: "reset" });

// ---- 3. Streaming: time to first token --------------------------------------------

const streamUrl = `${mock.url}/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse`;
const ttftDirect = [];
const ttftLlmux = [];
for (let i = 0; i < Math.min(SAMPLES, 100); i += 1) {
  // The first complete event (the mock ends events with a blank line), since that is what
  // LLMux waits for before it can send its own first delta.
  ttftDirect.push(await timeToFirstText(streamUrl, { body: geminiBody }, "\r\n\r\n"));
  ttftLlmux.push(
    await timeToFirstText(
      chatUrl,
      { headers: auth, body: { ...noCache, stream: true } },
      "event: delta",
    ),
  );
}
await mock.call({ op: "reset" });

// ---- 4. Fallback: Gemini down, Ollama answers ------------------------------------

await llmux.call({ op: "flushRedis" }); // a closed circuit and an empty cache to start from
await mock.call({
  op: "behave",
  provider: "gemini",
  behavior: { type: "status", status: 503, body: { error: { code: 503 } } },
});
const fallback = await sequential(FALLBACK_SAMPLES, () =>
  chat({ model: "fast", messages, cache: false }),
);
const circuit = await llmux.call({ op: "circuit", provider: "gemini" });

// ---- Report -----------------------------------------------------------------------

const ms = (value) => (value === null || value === undefined ? "—" : `${value.toFixed(2)} ms`);

console.log(`One request at a time (${SAMPLES} each):\n`);
console.log("| Path | Median | p95 |");
console.log("|---|---|---|");
console.log(
  `| Mock provider, called directly | ${ms(median(seqDirect))} | ${ms(percentile(seqDirect, 95))} |`,
);
console.log(
  `| Through LLMux, no cache | ${ms(median(seqLlmux))} | ${ms(percentile(seqLlmux, 95))} |`,
);
console.log(`| Through LLMux, cache hit | ${ms(median(seqHit))} | ${ms(percentile(seqHit, 95))} |`);
console.log(
  `\nGateway overhead (median, LLMux minus direct): ${ms(median(seqLlmux) - median(seqDirect))}`,
);

console.log(`\nUnder load (${CONNECTIONS} connections × ${DURATION} s each):\n`);
console.log("| Run | p50 | p99 | Requests/s | Failed |");
console.log("|---|---|---|---|---|");
for (const r of [ceiling, loadDirect, loadLlmux, loadHit]) {
  console.log(
    `| ${r.label} | ${ms(r.p50)} | ${ms(r.p99)} | ${r.rps.toLocaleString("en-US")} | ${r.failed} |`,
  );
}
console.log(`\nProvider calls during the cache-hit run: ${providerCallsDuringHits}`);
console.log(
  `\nTime to first token, median of ${ttftDirect.length}: direct ${ms(median(ttftDirect))}, ` +
    `through LLMux ${ms(median(ttftLlmux))}`,
);
console.log(
  `Fallback with Gemini answering 503: first request ${ms(fallback[0])} (3 tries with ` +
    `backoff, then Ollama); median of requests 6–${FALLBACK_SAMPLES} ` +
    `${ms(median(fallback.slice(5)))} (circuit ${circuit.state}, Gemini skipped)`,
);

// ---- Cleanup ----------------------------------------------------------------------

await llmux.call({ op: "close" });
await mock.call({ op: "close" });
