import { Router } from "express";
import { TimeoutError, withTimeout } from "../utils/withTimeout.js";

export const READY_CHECK_TIMEOUT_MS = 1_000;

/**
 * Runs every dependency check in parallel, each capped at READY_CHECK_TIMEOUT_MS.
 * Returns "ok", "timeout" or "error" per check. Error details are logged, never returned:
 * they can contain hostnames and connection strings.
 *
 * @param {Record<string, () => Promise<void>>} checks
 * @param {import("pino").Logger} log
 */
export async function runReadinessChecks(checks, log) {
  const names = Object.keys(checks);
  const results = await Promise.allSettled(
    names.map((name) => withTimeout(checks[name](), READY_CHECK_TIMEOUT_MS)),
  );

  const statuses = {};
  results.forEach((result, i) => {
    const name = names[i];
    if (result.status === "fulfilled") {
      statuses[name] = "ok";
      return;
    }
    statuses[name] = result.reason instanceof TimeoutError ? "timeout" : "error";
    log.warn({ check: name, err: result.reason }, "Readiness check failed");
  });

  return statuses;
}

/**
 * /health: liveness, the process is up. Never touches dependencies, so a database
 *   outage does not make the platform restart a healthy process.
 * /ready: readiness, Postgres and Redis answer. 503 tells the platform to stop
 *   routing traffic here until they recover.
 *
 * @param {Record<string, () => Promise<void>>} checks
 */
export function systemRoutes(checks) {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/ready", async (req, res) => {
    const statuses = await runReadinessChecks(checks, req.log);
    const ready = Object.values(statuses).every((status) => status === "ok");

    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", checks: statuses });
  });

  return router;
}
