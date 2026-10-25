import { hashKey, isWellFormedKey } from "../modules/keys/keyGenerator.js";
import { GatewayError } from "../utils/errors.js";

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Checks one gateway key and returns { id, userId, rateLimitPerMin }, or throws
 * UNAUTHORIZED / KEY_REVOKED. Shared by the HTTP middleware below and the WebSocket
 * auth handshake, so both transports accept and reject exactly the same keys.
 *
 * @param {string | undefined} token  the full llmux_sk_… key
 * @param {{ lookup: ReturnType<typeof import("../modules/keys/keyLookup.js").createKeyLookup>,
 *   log?: import("pino").Logger }} deps
 */
export async function authenticateKey(token, { lookup, log }) {
  // Malformed values are rejected before any cache or database lookup.
  const record = isWellFormedKey(token) ? await lookup.find(hashKey(token), { log }) : null;
  if (!record) {
    throw new GatewayError("UNAUTHORIZED", "Invalid gateway key");
  }
  if (record.revoked) {
    throw new GatewayError("KEY_REVOKED", "This gateway key has been revoked");
  }
  return { id: record.id, userId: record.userId, rateLimitPerMin: record.rateLimitPerMin };
}

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

    try {
      req.apiKey = await authenticateKey(match[1], { lookup, log: req.log });
    } catch (err) {
      return next(err);
    }
    // req.log comes from pino-http; it is absent only when the router is mounted bare.
    if (req.log) req.log = req.log.child({ keyId: req.apiKey.id });
    next();
  };
}
