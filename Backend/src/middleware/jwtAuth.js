import { toPublicUser } from "../modules/auth/registration.js";
import { SESSION_COOKIE, readCookie, verifySession } from "../modules/auth/tokens.js";
import { GatewayError } from "../utils/errors.js";

/**
 * Protects dashboard routes (/api/*). Requires a valid session cookie and a user that still
 * exists, then exposes the public user as req.user.
 *
 * The user is looked up on every request rather than trusted from the token alone, so a
 * deleted account loses access at once instead of when its token expires.
 *
 * @param {{ users: ReturnType<typeof import("../modules/auth/users.repository.js").createUsersRepository> }} deps
 */
export function requireSession({ users }) {
  return async (req, _res, next) => {
    const session = verifySession(readCookie(req.get("cookie"), SESSION_COOKIE));
    if (!session) {
      return next(new GatewayError("UNAUTHORIZED", "Log in to continue"));
    }

    const user = await users.findById(session.userId);
    if (!user) {
      return next(new GatewayError("UNAUTHORIZED", "Log in to continue"));
    }

    req.user = toPublicUser(user);
    next();
  };
}
