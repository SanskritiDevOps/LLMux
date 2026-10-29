/**
 * Unified request → Anthropic Messages API request.
 * Reference: https://platform.claude.com/docs/en/api/messages
 *
 *   unified                    Anthropic
 *   system               →     system (a top-level field, not a message)
 *   messages             →     messages (roles already match: user / assistant)
 *   maxTokens            →     max_tokens (required by Anthropic; covers thinking and text)
 *   stream: true         →     stream: true (usage arrives in message_start / message_delta)
 *   temperature          →     not sent: API version 2026-10-21 rejects temperature, top_p
 *                              and top_k on every model, so the model's default is used
 *
 * Auth is the x-api-key header; anthropic-version pins the API behaviour LLMux was
 * written against.
 */

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_API_VERSION = "2026-10-21";

/**
 * @param {import("../adapter.js").UnifiedRequest} request
 * @param {import("../adapter.js").Target} target
 * @param {import("../adapter.js").RequestContext} context
 * @returns {import("../adapter.js").ProviderRequest}
 */
export function buildAnthropicRequest(request, target, { maxTokens, apiKey, baseUrl }) {
  if (!apiKey) {
    // The router only returns providers that have a key, so reaching this is a bug.
    throw new TypeError("Anthropic request built without an API key");
  }

  const base = (baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const body = {
    model: target.model,
    max_tokens: maxTokens,
    messages: request.messages.map(({ role, content }) => ({ role, content })),
  };
  if (request.system) body.system = request.system;
  if (request.stream) body.stream = true;

  return {
    url: `${base}/v1/messages`,
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_API_VERSION },
    body,
  };
}
