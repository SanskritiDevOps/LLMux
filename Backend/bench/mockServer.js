/**
 * The benchmark's provider: tests/mockProvider.js in its own process, so it never shares
 * a thread with LLMux or with the load generator. Driven over IPC by overhead.bench.js:
 *
 *   { op: "behave", provider, behavior }   { op: "reset" }   { op: "count" }   { op: "close" }
 */
import { startMockProvider } from "../tests/mockProvider.js";

const mock = await startMockProvider();

process.on("message", async ({ id, op, provider, behavior }) => {
  if (op === "behave") mock.behave(provider, behavior);
  if (op === "reset") mock.reset();
  if (op === "close") await mock.close();
  // `requests` is how many calls reached the provider since the last reset.
  process.send({ id, requests: mock.requests.length });
  if (op === "close") process.exit(0);
});

process.send({ ready: true, url: mock.url });
