import { Writable } from "node:stream";
import { createLogger } from "../../src/utils/logger.js";

/**
 * A real Pino logger whose output is kept in memory as parsed JSON lines,
 * so tests can assert on exactly what would be written in production.
 */
export function captureLogs() {
  const lines = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(
        ...chunk
          .toString()
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      );
      callback();
    },
  });

  const logger = createLogger({ level: "info", pretty: false }, stream);

  // pino-http ends each request with one line that has a `res` field.
  const requestLines = () => lines.filter((line) => line.res);

  return { logger, lines, requestLines };
}
