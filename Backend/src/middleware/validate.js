import { GatewayError } from "../utils/errors.js";

const MAX_ISSUES_IN_MESSAGE = 5;

/**
 * Builds a client-safe message such as
 * "Invalid request: messages.0.role: Invalid option: expected one of "user"|"assistant"".
 * Zod messages describe the rule, not the rejected value, so nothing the client sent
 * (which could be a secret pasted into the wrong field) is echoed back.
 */
export function formatIssues(issues, root) {
  const parts = issues.slice(0, MAX_ISSUES_IN_MESSAGE).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : root;
    return `${path}: ${issue.message}`;
  });
  const more = issues.length - MAX_ISSUES_IN_MESSAGE;
  if (more > 0) parts.push(`and ${more} more`);
  return `Invalid request: ${parts.join("; ")}`;
}

/**
 * Validates parts of the request against Zod schemas before the handler runs.
 * Parsed values (with defaults applied and unknown fields rejected) are put on
 * `req.validated.{body,query,params}`; handlers read from there, never from the raw request.
 * Express 5 makes req.query read-only, which is why results are not written back in place.
 *
 * @param {{ body?: import("zod").ZodType, query?: import("zod").ZodType, params?: import("zod").ZodType }} schemas
 */
export function validate(schemas) {
  return (req, _res, next) => {
    req.validated ??= {};

    for (const part of ["params", "query", "body"]) {
      const schema = schemas[part];
      if (!schema) continue;

      // A request with no JSON body leaves req.body undefined; validate it as {} so the
      // client gets "model: required" rather than a confusing "expected object".
      const input = part === "body" ? (req.body ?? {}) : req[part];
      const result = schema.safeParse(input);
      if (!result.success) {
        return next(new GatewayError("INVALID_REQUEST", formatIssues(result.error.issues, part)));
      }
      req.validated[part] = result.data;
    }

    next();
  };
}
