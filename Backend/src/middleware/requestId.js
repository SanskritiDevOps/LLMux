import { randomBytes } from "node:crypto";

export const REQUEST_ID_HEADER = "X-Request-Id";

// Client-supplied IDs end up in logs and headers, so only short, plain IDs are trusted.
const SAFE_ID = /^[\w.:-]{1,128}$/;

export function generateRequestId() {
  return `req_${randomBytes(12).toString("hex")}`;
}

/**
 * Reuses the caller's X-Request-Id when it is safe, so one ID can trace a request
 * across services; otherwise generates one. Exposes it as req.id and echoes it back.
 */
export function requestId() {
  return (req, res, next) => {
    const incoming = req.get(REQUEST_ID_HEADER);
    req.id = incoming && SAFE_ID.test(incoming) ? incoming : generateRequestId();
    res.set(REQUEST_ID_HEADER, req.id);
    next();
  };
}
