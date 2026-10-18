import { pinoHttp } from "pino-http";

/**
 * One structured log line per request, tagged with the request ID.
 * Must run after requestId() so req.id is already set.
 *
 * @param {import("pino").Logger} logger
 */
export function httpLogger(logger) {
  return pinoHttp({
    logger,
    genReqId: (req) => req.id,
    customAttributeKeys: { reqId: "reqId" },
    // Logs written through req.log inside handlers carry only reqId, not the whole request.
    quietReqLogger: true,
    // Response headers are ours and add nothing when debugging; keep the status only.
    serializers: { res: (res) => ({ statusCode: res.statusCode }) },
    // Hosting platforms poll /health every few seconds; logging it would drown real traffic.
    autoLogging: { ignore: (req) => req.url === "/health" },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
  });
}
