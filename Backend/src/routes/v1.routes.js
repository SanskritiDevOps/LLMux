import { Router } from "express";
import { listModels as defaultListModels } from "../gateway/catalog.js";
import { createResponseCache, withResponseCache } from "../gateway/responseCache.js";
import { ChatRequestSchema } from "../gateway/schemas.js";
import { requireApiKey } from "../middleware/apiKeyAuth.js";
import { toGatewayError } from "../middleware/errorHandler.js";
import { REQUEST_ID_HEADER } from "../middleware/requestId.js";
import { validate } from "../middleware/validate.js";
import { createKeyLookup } from "../modules/keys/keyLookup.js";
import { discardUsage, trackUsage } from "../modules/usage/usageRecorder.js";
import { createSseWriter } from "../transports/sse.js";

/**
 * Response headers that describe how a chat was answered (README section 7). They repeat
 * what the body says, so a client, proxy or curl -i can see it without parsing JSON, and
 * so a stream says who is answering before the first token.
 */
export const LLMUX_HEADERS = Object.freeze({
  provider: "X-LLMux-Provider",
  providerModel: "X-LLMux-Provider-Model",
  cache: "X-LLMux-Cache",
  attempts: "X-LLMux-Attempts",
  fallbackUsed: "X-LLMux-Fallback-Used",
  latencyMs: "X-LLMux-Latency-Ms",
});

/** Headers a browser app (the dashboard) may read; CORS hides all others. */
export const EXPOSED_HEADERS = Object.freeze([REQUEST_ID_HEADER, ...Object.values(LLMUX_HEADERS)]);

/**
 * The public gateway API. Versioned in the path so /v1 never changes underneath clients.
 * Every route needs a gateway key (Authorization: Bearer llmux_sk_…).
 *
 * @param {{
 *   gateway: ReturnType<typeof import("../gateway/gateway.service.js").createGateway>,
 *   listModels?: typeof defaultListModels,
 *   keys?: ReturnType<typeof import("../modules/keys/keys.repository.js").createKeysRepository>,
 *   redis?: import("ioredis").Redis,
 *   keyLookup?: ReturnType<typeof createKeyLookup>,
 *   usage?: { record: (row: object) => void },
 *   responseCache?: ReturnType<typeof createResponseCache>,
 * }} deps  keyLookup defaults to a Redis-cached lookup over `keys`; usage is the usage
 *   writer (server.js passes the real one; without it, rows are discarded); responseCache
 *   defaults to a Redis cache on the same `redis`
 */
export function v1Routes({
  gateway,
  listModels = defaultListModels,
  keys,
  redis,
  keyLookup = createKeyLookup({ keys, redis }),
  usage = discardUsage,
  responseCache = createResponseCache({ redis }),
}) {
  const router = Router();
  // JSON chats check the response cache first; streams go straight to the gateway.
  const chatGateway = withResponseCache(gateway, { cache: responseCache });

  // Before everything else, so no route here can be reached without a valid key.
  router.use(requireApiKey({ lookup: keyLookup }));

  router.get("/models", (_req, res) => {
    res.json(listModels());
  });

  router.post("/chat", validate({ body: ChatRequestSchema }), async (req, res) => {
    // If the client hangs up before the answer is complete, stop the provider call instead
    // of paying for tokens nobody will read.
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    const request = req.validated.body;
    // One usage row per chat, written after the response, whatever the outcome.
    const tracker = trackUsage({
      usage,
      requestId: req.id,
      apiKeyId: req.apiKey.id,
      request,
      transport: request.stream ? "sse" : "http",
      log: req.log,
    });
    const context = {
      requestId: req.id,
      signal: controller.signal,
      log: req.log,
      onFinish: tracker.onFinish,
      // Cached answers are per account, never shared between customers.
      cacheScope: req.apiKey.userId,
    };

    let outcome = {};
    try {
      if (request.stream) {
        outcome = await streamToSse(gateway.stream(request, context), res, req.log);
        return;
      }
      const { response, meta } = await chatGateway.chat(request, context);
      res.set({
        [LLMUX_HEADERS.provider]: response.provider,
        [LLMUX_HEADERS.providerModel]: response.providerModel,
        [LLMUX_HEADERS.cache]: response.cached ? "HIT" : "MISS",
        [LLMUX_HEADERS.attempts]: String(meta.attempts),
        [LLMUX_HEADERS.fallbackUsed]: String(response.fallbackUsed),
        [LLMUX_HEADERS.latencyMs]: String(response.latencyMs),
      });
      res.json(response);
    } catch (err) {
      if (controller.signal.aborted) {
        // Nobody is listening any more, so there is no response to send.
        req.log.info("Client disconnected; provider call cancelled");
        outcome = { cancelled: true };
        return;
      }
      outcome = { error: toGatewayError(err) };
      throw err;
    } finally {
      tracker.finish(outcome);
    }
  });

  return router;
}

/**
 * Delivers a gateway stream as SSE. The first event is awaited before any header is sent:
 * if the stream fails to open, the error propagates and the error handler answers with a
 * normal JSON error and the right status. After that, a failure can only be reported as
 * an `error` event, since the 200 status has already gone out.
 *
 * @param {AsyncGenerator<{ type: string }>} events  from gateway.stream()
 * @param {import("express").Response} res
 * @param {import("pino").Logger} log
 * @returns {Promise<{ error?: import("../utils/errors.js").GatewayError, cancelled?: boolean }>}
 *   how the stream ended, for the usage log
 */
async function streamToSse(events, res, log) {
  const first = await events.next();

  // Only what is known before the first token; the rest (latency, usage) is in `end`.
  res.set({
    [LLMUX_HEADERS.provider]: first.value.provider,
    [LLMUX_HEADERS.cache]: "MISS",
  });
  const sse = createSseWriter(res);
  sse.open();
  try {
    for (let step = first; !step.done; step = await events.next()) {
      // false means the client has gone: stop reading, which cancels the provider call.
      if (!(await sse.send(step.value))) return { cancelled: true };
    }
    return {};
  } catch (err) {
    if (res.destroyed) throw err;
    const error = toGatewayError(err);
    if (error.code === "INTERNAL_ERROR") {
      log.error({ err }, "Stream failed");
    }
    await sse.send({ type: "error", code: error.code, message: error.message });
    return { error };
  } finally {
    // Closes the provider connection if the loop stopped early; a no-op when it finished.
    await events.return();
    sse.close();
  }
}
