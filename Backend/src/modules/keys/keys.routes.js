import { Router } from "express";
import { requireSession } from "../../middleware/jwtAuth.js";
import { requireSameOrigin } from "../../middleware/originCheck.js";
import { validate } from "../../middleware/validate.js";
import {
  CreateKeySchema,
  KeyIdParams,
  UpdateKeySchema,
  createKeysService,
} from "./keys.service.js";

/**
 * Gateway key management for the dashboard, mounted at /api/keys. Every route needs a
 * logged-in session and only ever touches the session user's own keys.
 *
 *   GET    /       list my keys (prefix only)          → 200 { keys }
 *   POST   /       create a key                        → 201 { apiKey, key }  (apiKey shown once)
 *   PATCH  /:id    rename and/or change the rate limit → 200 { key }
 *   DELETE /:id    revoke (soft delete)                → 200 { key }
 */
export function keysRoutes({ users, keys, redis }) {
  const router = Router();
  const service = createKeysService({ keys, redis });

  router.use(requireSameOrigin(), requireSession({ users }));

  router.get("/", async (req, res) => {
    res.json({ keys: await service.list(req.user.id) });
  });

  router.post("/", validate({ body: CreateKeySchema }), async (req, res) => {
    res.status(201).json(await service.create(req.user.id, req.validated.body));
  });

  router.patch(
    "/:id",
    validate({ params: KeyIdParams, body: UpdateKeySchema }),
    async (req, res) => {
      const key = await service.update(req.user.id, req.validated.params.id, req.validated.body);
      res.json({ key });
    },
  );

  router.delete("/:id", validate({ params: KeyIdParams }), async (req, res) => {
    const key = await service.revoke(req.user.id, req.validated.params.id, { log: req.log });
    res.json({ key });
  });

  return router;
}
