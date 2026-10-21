/**
 * Unified request → Ollama native chat request.
 * Reference: https://github.com/ollama/ollama/blob/main/docs/api.md#generate-a-chat-completion
 *
 *   unified                    Ollama
 *   system               →     a leading message with role "system"
 *   messages             →     messages (roles already match: user / assistant)
 *   temperature          →     options.temperature
 *   maxTokens            →     options.num_predict
 *   stream               →     stream (Ollama streams by default, so false is always sent)
 */

export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";

/**
 * @param {import("../adapter.js").UnifiedRequest} request
 * @param {import("../adapter.js").Target} target
 * @param {import("../adapter.js").RequestContext} context
 * @returns {import("../adapter.js").ProviderRequest}
 */
export function buildOllamaRequest(request, target, { maxTokens, baseUrl }) {
  const base = (baseUrl ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, "");

  const messages = request.messages.map(({ role, content }) => ({ role, content }));
  if (request.system) {
    messages.unshift({ role: "system", content: request.system });
  }

  return {
    url: `${base}/api/chat`,
    method: "POST",
    // A local server: no auth header.
    headers: {},
    body: {
      model: target.model,
      messages,
      // Ollama's default is true; non-streaming calls must say so explicitly.
      stream: request.stream,
      options: {
        temperature: request.temperature,
        num_predict: maxTokens,
      },
    },
  };
}
