import { Router } from "express";
import { listModels as defaultListModels } from "../gateway/catalog.js";
import { ChatRequestSchema } from "../gateway/schemas.js";
import { requireApiKey } from "../middleware/apiKeyAuth.js";
import { validate } from "../middleware/validate.js";
import { createKeyLookup } from "../modules/keys/keyLookup.js";

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
    // If the client hangs up before the answer is ready, stop the provider call instead
    // of paying for tokens nobody will read.
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });

    try {
      const { response } = await gateway.chat(req.validated.body, {
        requestId: req.id,
        signal: controller.signal,
        log: req.log,
      });
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
