import { Router } from "express";
import { listModels as defaultListModels } from "../gateway/catalog.js";
import { ChatRequestSchema } from "../gateway/schemas.js";
import { validate } from "../middleware/validate.js";

/**
 * The public gateway API. Versioned in the path so /v1 never changes underneath clients.
 * Authentication with gateway keys is added on Day 6.
 *
 * @param {{
 *   gateway: ReturnType<typeof import("../gateway/gateway.service.js").createGateway>,
 *   listModels?: typeof defaultListModels,
 * }} deps
 */
export function v1Routes({ gateway, listModels = defaultListModels }) {
  const router = Router();

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
