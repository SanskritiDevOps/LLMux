import { logger as defaultLogger } from "../../utils/logger.js";
import { createUsageRepository } from "./usage.repository.js";

// README section 16: "the log write happens after the response is sent. If the database is
// briefly unavailable, logs are buffered in memory and flushed in batches."
export const BATCH_SIZE = 100;
export const FLUSH_INTERVAL_MS = 1_000;
// About 10 MB of rows. Past this, during a long database outage, the oldest rows are
// dropped rather than letting memory grow without limit.
export const MAX_BUFFERED = 10_000;

/**
 * Prisma's P2xxx codes mean the database refused the data (a foreign key, a value too
 * long). Anything else (ECONNREFUSED, a timeout) means it couldn't be reached.
 */
function isRowError(err) {
  return typeof err?.code === "string" && /^P2\d{3}$/.test(err.code);
}

/**
 * Collects usage rows in memory and writes them in batches, off the request path.
 *
 *   record(row)  never waits and never throws: a request is never slowed down or failed
 *                because of usage logging
 *   a batch is written when BATCH_SIZE rows are waiting, or every FLUSH_INTERVAL_MS
 *   if the database is down, the batch stays at the front of the buffer and is retried
 *   on the next flush; if it refuses a row, only that row is dropped
 *   close()      writes everything left, for shutdown
 *
 * @param {{
 *   repository?: ReturnType<typeof createUsageRepository>,
 *   logger?: import("pino").Logger,
 *   batchSize?: number, flushIntervalMs?: number, maxBuffered?: number,
 * }} [options]  the sizes and interval can be lowered in tests
 */
export function createUsageWriter({
  repository = createUsageRepository(),
  logger = defaultLogger,
  batchSize = BATCH_SIZE,
  flushIntervalMs = FLUSH_INTERVAL_MS,
  maxBuffered = MAX_BUFFERED,
} = {}) {
  let buffer = [];
  let flushing = null;
  let failing = false;
  let closed = false;
  const counts = { written: 0, dropped: 0, failedBatches: 0 };

  const timer = setInterval(() => {
    flush();
  }, flushIntervalMs);
  // A pending flush must never keep the process alive on its own; close() drains it.
  timer.unref();

  function record(row) {
    if (closed) {
      logger.warn({ requestId: row.requestId }, "Usage row recorded after shutdown; dropped");
      counts.dropped += 1;
      return;
    }
    buffer.push(row);
    if (buffer.length > maxBuffered) {
      const excess = buffer.length - maxBuffered;
      buffer = buffer.slice(excess);
      counts.dropped += excess;
      logger.error(
        { dropped: excess, buffered: buffer.length },
        "Usage log buffer is full; dropped the oldest rows",
      );
    }
    if (buffer.length >= batchSize) flush();
  }

  /** Writes every waiting row, one batch at a time. Concurrent calls share one run. */
  function flush() {
    flushing ??= drain().finally(() => {
      flushing = null;
    });
    return flushing;
  }

  async function drain() {
    while (buffer.length > 0) {
      const batch = buffer.slice(0, batchSize);
      try {
        const inserted = await repository.insertMany(batch);
        if (inserted < batch.length) {
          // Either a retried batch that had partly been written already, or a client that
          // sent the same X-Request-Id for two requests (only the first is kept).
          logger.warn(
            { skipped: batch.length - inserted },
            "Skipped usage rows whose request_id was already stored",
          );
        }
        written(batch.length);
      } catch (err) {
        if (!isRowError(err)) return outage(err);
        // Postgres refused the data itself (a row whose key no longer exists, say), so
        // retrying the batch would fail forever and block every row behind it. Write
        // the rows one by one instead, and drop only the ones that are refused.
        for (const row of batch) {
          try {
            await repository.insertMany([row]);
            written(1);
          } catch (rowErr) {
            if (!isRowError(rowErr)) return outage(rowErr);
            buffer = buffer.slice(1);
            counts.dropped += 1;
            logger.error(
              { err: rowErr, requestId: row.requestId },
              "Usage row refused by the database; dropped",
            );
          }
        }
      }
    }
  }

  /** Removes `n` written rows from the front of the buffer. */
  function written(n) {
    buffer = buffer.slice(n);
    counts.written += n;
    if (failing) {
      failing = false;
      logger.info({ buffered: buffer.length }, "Usage log writes recovered");
    }
  }

  /** The database can't be reached: keep everything and try again on the next flush. */
  function outage(err) {
    counts.failedBatches += 1;
    // Logged once per outage, not once per retry.
    if (!failing) {
      logger.warn(
        { err, buffered: buffer.length },
        "Could not write usage logs; keeping them in memory and retrying",
      );
    }
    failing = true;
  }

  return {
    record,
    flush,
    /** For tests and the shutdown log line. */
    stats: () => ({ buffered: buffer.length, ...counts }),
    /**
     * Stops the timer and writes what's left. If the database is down at that moment,
     * the rows are lost, and the log line says how many.
     */
    async close() {
      closed = true;
      clearInterval(timer);
      await flushing;
      await flush();
      if (buffer.length > 0) {
        logger.error({ lost: buffer.length }, "Usage logs could not be written before shutdown");
      }
    },
  };
}
