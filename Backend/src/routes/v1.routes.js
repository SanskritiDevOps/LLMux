import { Router } from "express";
import { listModels as defaultListModels } from "../gateway/catalog.js";
import { ChatRequestSchema } from "../gateway/schemas.js";
import { requireApiKey } from "../middleware/apiKeyAuth.js";
import { toGatewayError } from "../middleware/errorHandler.js";
import { validate } from "../middleware/validate.js";
import { createKeyLookup } from "../modules/keys/keyLookup.js";
import { createSseWriter } from "../transports/sse.js";

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
 * }} deps  keyLookup defaults to a Redis-cached lookup over `keys`
 */
export function v1Routes({
  gateway,
  listModels = defaultListModels,
  keys,
  redis,
  keyLookup = createKeyLookup({ keys, redis }),
}) {
  const router = Router();

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
    const context = { requestId: req.id, signal: controller.signal, log: req.log };

    try {
      if (request.stream) {
        await streamToSse(gateway.stream(request, context), res, req.log);
        return;
      }
      const { response } = await gateway.chat(request, context);
      res.json(response);
    } catch (err) {
      if (controller.signal.aborted) {
        // Nobody is listening any more, so there is no response to send.
        req.log.info("Client disconnected; provider call cancelled");
        return;
      }
      throw err;
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
 */
async function streamToSse(events, res, log) {
  const first = await events.next();

  const sse = createSseWriter(res);
  sse.open();
  try {
    for (let step = first; !step.done; step = await events.next()) {
      // false means the client has gone: stop reading, which cancels the provider call.
      if (!(await sse.send(step.value))) break;
    }
  } catch (err) {
    if (res.destroyed) throw err;
    const error = toGatewayError(err);
    if (error.code === "INTERNAL_ERROR") {
      log.error({ err }, "Stream failed");
    }
    await sse.send({ type: "error", code: error.code, message: error.message });
  } finally {
    // Closes the provider connection if the loop stopped early; a no-op when it finished.
    await events.return();
    sse.close();
  }
}
