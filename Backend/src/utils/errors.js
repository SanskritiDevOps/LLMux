/**
 * Every error LLMux returns has one of these stable codes. Clients branch on `code`,
 * never on message text, so codes must not be renamed once released.
 * `retryable` is the default for the code; a specific error can override it.
 */
export const ERROR_CODES = Object.freeze({
  INVALID_REQUEST: { status: 400, retryable: false },
  UNKNOWN_MODEL: { status: 400, retryable: false },
  UNAUTHORIZED: { status: 401, retryable: false },
  KEY_REVOKED: { status: 401, retryable: false },
  BUDGET_EXCEEDED: { status: 402, retryable: false },
  NOT_FOUND: { status: 404, retryable: false },
  PAYLOAD_TOO_LARGE: { status: 413, retryable: false },
  RATE_LIMITED: { status: 429, retryable: true },
  INTERNAL_ERROR: { status: 500, retryable: false },
  PROVIDER_ERROR: { status: 502, retryable: false },
  PROVIDER_UNAVAILABLE: { status: 503, retryable: true },
  PROVIDER_RATE_LIMITED: { status: 503, retryable: true },
  TIMEOUT: { status: 504, retryable: true },
});

export class GatewayError extends Error {
  /**
   * @param {keyof typeof ERROR_CODES} code
   * @param {string} message safe to show to clients; never put provider bodies or secrets here
   * @param {{ provider?: string | null, retryable?: boolean, cause?: unknown }} [options]
   */
  constructor(code, message, { provider = null, retryable, cause } = {}) {
    const definition = ERROR_CODES[code];
    if (!definition) {
      throw new TypeError(`Unknown error code: ${code}`);
    }

    super(message, { cause });
    this.name = "GatewayError";
    this.code = code;
    this.status = definition.status;
    this.provider = provider;
    this.retryable = retryable ?? definition.retryable;
  }

  /** The unified error body from README section 8. */
  toBody(requestId) {
    return {
      error: {
        code: this.code,
        message: this.message,
        requestId,
        provider: this.provider,
        retryable: this.retryable,
      },
    };
  }
}
