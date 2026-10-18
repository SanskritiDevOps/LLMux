export class TimeoutError extends Error {
  constructor(ms) {
    super(`Timed out after ${ms} ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Rejects with TimeoutError if `promise` has not settled within `ms`.
 * The underlying work is not cancelled; this only stops the caller from waiting.
 */
export function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
