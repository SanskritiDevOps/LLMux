import { Router } from "express";
import { requireSession } from "../../middleware/jwtAuth.js";
import { validate } from "../../middleware/validate.js";
import { GatewayError } from "../../utils/errors.js";
import { BreakdownQuery, LogsQuery, RangeQuery, TimeseriesQuery } from "./usage.schemas.js";

/**
 * Usage for the dashboard, mounted at /api/usage. Read-only, so a session is enough (no
 * origin check). Every query covers only the logged-in user's keys; a keyId filter that
 * isn't one of them gets 404, exactly like a key that doesn't exist.
 *
 *   GET /summary?from=&to=&keyId=                           totals for the range
 *   GET /timeseries?metric=&interval=&from=&to=&keyId=      one value per hour or day
 *   GET /breakdown?by=model|provider|key&from=&to=&keyId=   grouped totals
 *   GET /logs?cursor=&limit=&model=&provider=&status=&keyId=  recent requests, paginated
 *
 * @param {{ users: object, keys: object,
 *   usageQueries: ReturnType<typeof import("./usage.queries.js").createUsageQueries> }} deps
 */
export function usageRoutes({ users, keys, usageQueries }) {
  const router = Router();

  router.use(requireSession({ users }));

  const ownKeyOnly = async (req, _res, next) => {
    const { keyId } = req.validated.query;
    if (keyId && !(await keys.findForUser(keyId, req.user.id))) {
      return next(new GatewayError("NOT_FOUND", "Key not found"));
    }
    next();
  };

  const route = (path, schema, query) =>
    router.get(path, validate({ query: schema }), ownKeyOnly, async (req, res) => {
      res.json(await query(req.user.id, req.validated.query));
    });

  route("/summary", RangeQuery, usageQueries.summary);
  route("/timeseries", TimeseriesQuery, usageQueries.timeseries);
  route("/breakdown", BreakdownQuery, usageQueries.breakdown);
  route("/logs", LogsQuery, usageQueries.logs);

  return router;
}
