import { Router } from "express";
import { z } from "zod";
import { listModels as defaultListModels } from "../../gateway/catalog.js";
import { microUsdToUsd } from "../../gateway/cost.js";
import { ChatRequestSchema } from "../../gateway/schemas.js";
import { toGatewayError } from "../../middleware/errorHandler.js";
import { requireSession } from "../../middleware/jwtAuth.js";
import { requireSameOrigin } from "../../middleware/originCheck.js";
import { rateLimitByKey } from "../../middleware/rateLimit.js";
import { validate } from "../../middleware/validate.js";
import { streamToSse } from "../../routes/v1.routes.js";
import { GatewayError } from "../../utils/errors.js";
import { discardUsage, trackUsage } from "../usage/usageRecorder.js";

// Every POST /v1/chat field except stream (the playground always streams), plus the key
// the chat runs as.
export const PlaygroundChatSchema = ChatRequestSchema.omit({ stream: true }).extend({
  keyId: z.uuid({ error: "must be a key ID" }),
});

/**
 * The dashboard playground, mounted at /api/playground.
 *
 *   GET  /models                               → 200 { models }, exactly like GET /v1/models
 *               (the browser has no gateway key to call that one with)
 *   POST /chat  { keyId, model, messages, … }  → an SSE stream, exactly like
 *               POST /v1/chat with stream: true, except that `end` also has costUsd
 *
 * The browser has a session cookie, not a gateway key, so the chat runs as one of the
 * user's own keys (keyId): it takes a token from that key's rate limit and writes a usage
 * row under it, tagged metadata.source = "playground". The full key is never needed.
 *
 * @param {{ users: object, keys: object, gateway: object, limiter: object,
 *   usage?: { record: (row: object) => void }, listModels?: typeof defaultListModels }} deps
 */
export function playgroundRoutes({
  users,
  keys,
  gateway,
  limiter,
  usage = discardUsage,
  listModels = defaultListModels,
}) {
  const router = Router();

  router.use(requireSameOrigin(), requireSession({ users }));

  router.get("/models", (_req, res) => {
    res.json(listModels());
  });

  // Sets req.apiKey like requireApiKey does for /v1, so the same rate limit applies.
  const ownActiveKey = async (req, _res, next) => {
    const key = await keys.findForUser(req.validated.body.keyId, req.user.id);
    if (!key) return next(new GatewayError("NOT_FOUND", "Key not found"));
    if (key.revokedAt) {
      return next(new GatewayError("KEY_REVOKED", "This gateway key has been revoked"));
    }
    req.apiKey = { id: key.id, userId: key.userId, rateLimitPerMin: key.rateLimitPerMin };
    next();
  };

  router.post(
    "/chat",
    validate({ body: PlaygroundChatSchema }),
    ownActiveKey,
    rateLimitByKey({ limiter }),
    async (req, res) => {
      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) controller.abort();
      });
      const request = {
        ...req.validated.body,
        stream: true,
        metadata: { ...req.validated.body.metadata, source: "playground" },
      };
      // The key is who runs the chat, not part of it.
      delete request.keyId;
      const tracker = trackUsage({
        usage,
        requestId: req.id,
        apiKeyId: req.apiKey.id,
        request,
        transport: "sse",
        log: req.log,
      });
      let summary = null;
      const context = {
        requestId: req.id,
        signal: controller.signal,
        log: req.log,
        onFinish(call) {
          summary = call;
          tracker.onFinish(call);
        },
      };

      let outcome = {};
      try {
        const events = gateway.stream(request, context);
        outcome = await streamToSse(
          withCost(events, () => summary),
          res,
          req.log,
        );
      } catch (err) {
        if (controller.signal.aborted) {
          req.log.info("Client disconnected; provider call cancelled");
          outcome = { cancelled: true };
          return;
        }
        outcome = { error: toGatewayError(err) };
        throw err;
      } finally {
        tracker.finish(outcome);
      }
    },
  );

  return router;
}

/**
 * Passes stream events through, holding `end` back until the stream has finished: the
 * gateway reports the call's cost (onFinish) only then, and the playground shows it.
 */
async function* withCost(events, getSummary) {
  let end = null;
  // for await closes the gateway stream if the client leaves early.
  for await (const event of events) {
    if (event.type === "end") end = event;
    else yield event;
  }
  if (end) yield { ...end, costUsd: microUsdToUsd(getSummary()?.costMicroUsd ?? 0) };
}
