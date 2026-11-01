import { buildOpenAIRequest } from "../openai/request.js";

/**
 * Groq serves open models through OpenAI's Chat Completions format, so the request is
 * OpenAI's, sent to Groq's base URL with a Groq key.
 * Reference: https://console.groq.com/docs/api-reference
 *
 * One difference: Groq's docs don't say whether stream_options.include_usage is
 * supported, so it isn't sent. Usage is read from wherever a stream carries it (see
 * stream.js), and estimated when it doesn't.
 */

export const GROQ_DEFAULT_BASE_URL = "https://api.groq.com/openai";

/**
 * @param {import("../adapter.js").UnifiedRequest} request
 * @param {import("../adapter.js").Target} target
 * @param {import("../adapter.js").RequestContext} context
 */
export function buildGroqRequest(request, target, context) {
  return buildOpenAIRequest(request, target, context, {
    provider: "groq",
    defaultBaseUrl: GROQ_DEFAULT_BASE_URL,
    streamUsage: false,
  });
}
