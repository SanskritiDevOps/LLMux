import { hashKey, isWellFormedKey } from "../modules/keys/keyGenerator.js";
import { GatewayError } from "../utils/errors.js";

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Protects the gateway API (/v1/*): every request needs `Authorization: Bearer llmux_sk_…`.
 * Exposes { id, userId, rateLimitPerMin } as req.apiKey (used by rate limiting and usage
 * logging) and tags the request's logs with keyId. The key itself is never logged.
 *
 * @param {{ lookup: ReturnType<typeof import("../modules/keys/keyLookup.js").createKeyLookup> }} deps
 */
export function requireApiKey({ lookup }) {
  return async (req, _res, next) => {
    const match = BEARER.exec(req.get("authorization") ?? "");
    if (!match) {
      return next(
        new GatewayError(
          "UNAUTHORIZED",
          "Missing gateway key. Send the header Authorization: Bearer llmux_sk_…",
        ),
      );
    }

    // Malformed values are rejected before any cache or database lookup.
    const token = match[1];
    const record = isWellFormedKey(token)
      ? await lookup.find(hashKey(token), { log: req.log })
      : null;
    if (!record) {
      return next(new GatewayError("UNAUTHORIZED", "Invalid gateway key"));
    }
    if (record.revoked) {
      return next(new GatewayError("KEY_REVOKED", "This gateway key has been revoked"));
    }

    req.apiKey = { id: record.id, userId: record.userId, rateLimitPerMin: record.rateLimitPerMin };
    // req.log comes from pino-http; it is absent only when the router is mounted bare.
    if (req.log) req.log = req.log.child({ keyId: record.id });
    next();
  };
}
