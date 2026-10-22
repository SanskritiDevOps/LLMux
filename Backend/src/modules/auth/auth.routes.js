import { Router } from "express";
import { requireSession } from "../../middleware/jwtAuth.js";
import { requireSameOrigin } from "../../middleware/originCheck.js";
import { validate } from "../../middleware/validate.js";
import { LoginSchema, loginUser } from "./login.js";
import { RegisterSchema, registerUser } from "./registration.js";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "./tokens.js";

/**
 * Dashboard account endpoints, mounted at /api/auth.
 *
 *   POST /register  create an account and log in       → 201 { user } + session cookie
 *   POST /login     log in                              → 200 { user } + session cookie
 *   POST /logout    end the session in this browser     → 204, cookie cleared
 *   GET  /me        who is logged in                    → 200 { user }, or 401
 *
 * @param {{ users: ReturnType<typeof import("./users.repository.js").createUsersRepository> }} deps
 */
export function authRoutes({ users }) {
  const router = Router();

  // Every POST here changes session state, so none may be triggered from another site.
  router.use(requireSameOrigin());

  const startSession = (res, user) => {
    res.cookie(SESSION_COOKIE, signSession(user.id), sessionCookieOptions());
  };

  router.post("/register", validate({ body: RegisterSchema }), async (req, res) => {
    const user = await registerUser(req.validated.body, { users });
    startSession(res, user);
    res.status(201).json({ user });
  });

  router.post("/login", validate({ body: LoginSchema }), async (req, res) => {
    const user = await loginUser(req.validated.body, { users });
    startSession(res, user);
    res.json({ user });
  });

  // A JWT cannot be revoked before it expires; logging out removes it from this browser.
  // That is the README's design (stateless sessions); a server-side denylist is Future scope.
  router.post("/logout", (_req, res) => {
    // Same name, path and flags as when it was set, or the browser keeps the old cookie;
    // without maxAge, so the immediate expiry clearCookie sets is not overridden.
    const options = sessionCookieOptions();
    delete options.maxAge;
    res.clearCookie(SESSION_COOKIE, options);
    res.status(204).end();
  });

  router.get("/me", requireSession({ users }), (req, res) => {
    res.json({ user: req.user });
  });

  return router;
}
