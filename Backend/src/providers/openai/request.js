/**
 * Unified request → OpenAI Chat Completions request.
 * Reference: https://platform.openai.com/docs/api-reference/chat/create
 *
 *   unified                    OpenAI
 *   system               →     a leading message with role "system"
 *   messages             →     messages (roles already match: user / assistant)
 *   temperature          →     temperature
 *   maxTokens            →     max_completion_tokens (max_tokens is deprecated, and refused
 *                              by reasoning models)
 *   stream: true         →     stream: true, plus stream_options.include_usage so the last
 *                              chunk carries token counts (otherwise usage is estimated)
 */

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com";

/**
 * @param {import("../adapter.js").UnifiedRequest} request
 * @param {import("../adapter.js").Target} target
 * @param {import("../adapter.js").RequestContext} context
 * @returns {import("../adapter.js").ProviderRequest}
 */
export function buildOpenAIRequest(request, target, { maxTokens, apiKey, baseUrl }) {
  if (!apiKey) {
    // The router only returns providers that have a key, so reaching this is a bug.
    throw new TypeError("OpenAI request built without an API key");
  }

  const base = (baseUrl ?? OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const messages = request.messages.map(({ role, content }) => ({ role, content }));
  if (request.system) {
    messages.unshift({ role: "system", content: request.system });
  }

  const body = {
    model: target.model,
    messages,
    temperature: request.temperature,
    max_completion_tokens: maxTokens,
  };
  if (request.stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }

  return {
    url: `${base}/v1/chat/completions`,
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body,
  };
}
