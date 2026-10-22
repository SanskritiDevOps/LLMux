import { env } from "../config/env.js";
import { GatewayError } from "../utils/errors.js";

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF protection for cookie-authenticated routes. Browsers attach the session cookie to
 * cross-site requests (production needs SameSite=None), so another website could make a
 * logged-in user's browser send a POST here. Browsers always send an Origin header on such
 * requests, so anything state-changing from an origin other than the dashboard is refused.
 *
 * Requests without an Origin header (curl, server-side clients) carry no browser cookies
 * unless someone copied them by hand, so they are allowed.
 */
export function requireSameOrigin({ allowedOrigin = env.DASHBOARD_URL } = {}) {
  const allowed = new URL(allowedOrigin).origin;

  return (req, _res, next) => {
    const origin = req.get("origin");
    if (STATE_CHANGING.has(req.method) && origin && origin !== allowed) {
      return next(new GatewayError("FORBIDDEN", "Cross-site request blocked"));
    }
    next();
  };
}
