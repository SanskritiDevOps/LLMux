/**
 * Turns one finished chat into one usage_logs row, for every transport:
 *
 *   transport "http"  POST /v1/chat answered as JSON
 *   transport "sse"   POST /v1/chat with stream: true
 *   transport "ws"    a chat message on /v1/ws
 *
 * The transport starts a tracker when the chat begins, passes `onFinish` to the gateway
 * (which reports what the request did, see CallSummary in gateway.service.js), and calls
 * `finish()` once with the outcome. The row goes to the usage writer, which batches it;
 * nothing here waits for the database.
 *
 * Message text is never stored (README section 17): only counts, cost and timings.
 */

export const STATUSES = Object.freeze(["success", "error", "cancelled"]);

const NO_SUMMARY = Object.freeze({
  target: null,
  usage: { inputTokens: 0, outputTokens: 0 },
  usageEstimated: false,
  costMicroUsd: 0,
  savedMicroUsd: 0,
  attempts: 1,
  fallbackUsed: false,
  cached: false,
  timeToFirstTokenMs: null,
});

/**
 * @param {{
 *   requestId: string, apiKeyId: string,
 *   request: { model: string, metadata?: Record<string, unknown> },
 *   transport: "http" | "sse" | "ws", streamed: boolean, latencyMs: number,
 *   summary?: import("../../gateway/gateway.service.js").CallSummary | null,
 *   error?: import("../../utils/errors.js").GatewayError, cancelled?: boolean,
 * }} input  `summary` is missing only if the gateway was never reached
 */
export function buildUsageRow({
  requestId,
  apiKeyId,
  request,
  transport,
  streamed,
  latencyMs,
  summary,
  error,
  cancelled = false,
}) {
  const call = summary ?? NO_SUMMARY;
  const status = cancelled ? "cancelled" : error ? "error" : "success";

  return {
    requestId,
    apiKeyId,
    // What the client asked for: an alias such as "fast", or a direct "ollama:llama3.2:1b".
    modelAlias: request.model,
    provider: call.target?.provider ?? error?.provider ?? null,
    providerModel: call.target?.model ?? null,
    inputTokens: call.usage.inputTokens,
    outputTokens: call.usage.outputTokens,
    usageEstimated: call.usageEstimated,
    costMicroUsd: call.costMicroUsd,
    savedMicroUsd: call.savedMicroUsd,
    latencyMs,
    timeToFirstTokenMs: streamed ? call.timeToFirstTokenMs : null,
    status,
    errorCode: status === "error" ? error.code : null,
    cached: call.cached,
    fallbackUsed: call.fallbackUsed,
    attempts: call.attempts,
    streamed,
    transport,
    // Prisma rejects a plain null for a JSON column, so it's left out when absent.
    ...(request.metadata && { metadata: request.metadata }),
  };
}

/**
 * @param {{
 *   usage: { record: (row: object) => void },
 *   requestId: string, apiKeyId: string, request: { model: string, metadata?: object },
 *   transport: "http" | "sse" | "ws", log?: import("pino").Logger,
 * }} options
 */
export function trackUsage({ usage, requestId, apiKeyId, request, transport, log }) {
  const started = performance.now();
  let summary = null;
  let finished = false;

  return {
    /** Pass to gateway.chat() / gateway.stream() as context.onFinish. */
    onFinish(callSummary) {
      summary = callSummary;
    },

    /**
     * Records the row. Called once, after the gateway has finished; later calls do nothing.
     * Never throws: usage logging must not break a request.
     *
     * @param {{ error?: import("../../utils/errors.js").GatewayError, cancelled?: boolean }} [outcome]
     */
    finish({ error, cancelled = false } = {}) {
      if (finished) return;
      finished = true;
      try {
        usage.record(
          buildUsageRow({
            requestId,
            apiKeyId,
            request,
            transport,
            streamed: transport !== "http",
            latencyMs: Math.round(performance.now() - started),
            summary,
            error,
            cancelled,
          }),
        );
      } catch (err) {
        log?.error({ err, requestId }, "Could not record usage");
      }
    },
  };
}

/** For tests and for code paths that don't log usage: accepts rows and drops them. */
export const discardUsage = Object.freeze({ record() {} });
