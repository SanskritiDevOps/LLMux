import { GatewayError } from "../utils/errors.js";

/** Turns any unmatched route into the unified 404 body. Register after all routes. */
export function notFound() {
  return (req, _res, next) => {
    next(new GatewayError("NOT_FOUND", `Route ${req.method} ${req.path} not found`));
  };
}

/**
 * Converts anything thrown or passed to next() into a GatewayError. Errors we did not
 * create are reported as INTERNAL_ERROR with a generic message: their text can contain
 * stack details or provider responses, so it only goes to the logs.
 */
export function toGatewayError(err) {
  if (err instanceof GatewayError) return err;

  // Errors raised by express.json() before any route runs.
  switch (err?.type) {
    case "entity.too.large":
      return new GatewayError("PAYLOAD_TOO_LARGE", "Request body is too large", { cause: err });
    case "entity.parse.failed":
      return new GatewayError("INVALID_REQUEST", "Request body is not valid JSON", { cause: err });
    case "encoding.unsupported":
    case "charset.unsupported":
      return new GatewayError("INVALID_REQUEST", "Unsupported request body encoding", {
        cause: err,
      });
  }

  return new GatewayError("INTERNAL_ERROR", "Internal server error", { cause: err });
}

/** Central error handler. Register last. */
export function errorHandler() {
  // Express recognises error handlers by having four parameters, so `_next` must stay.
  return (err, req, res, _next) => {
    const error = toGatewayError(err);

    // Hand the real error to pino-http so the request's log line shows what actually
    // failed. 4xx errors are expected client mistakes and would only add stack noise.
    if (error.status >= 500) {
      res.err = err;
    }

    // A response that already started (for example a stream) cannot change its status;
    // closing the socket is the only honest signal left.
    if (res.headersSent) {
      req.socket.destroy();
      return;
    }

    res.status(error.status).json(error.toBody(req.id));
  };
}
