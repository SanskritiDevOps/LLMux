/**
 * Unified request → Gemini generateContent request.
 * Reference: https://ai.google.dev/api/generate-content
 *
 *   unified                          Gemini
 *   system                     →     systemInstruction.parts[].text (separate field)
 *   messages[].role "assistant" →    contents[].role "model"
 *   messages[].content         →     contents[].parts[].text
 *   temperature, maxTokens     →     generationConfig.temperature, .maxOutputTokens
 *   stream: true               →     :streamGenerateContent?alt=sse instead of :generateContent
 */

export const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

const ROLE_TO_GEMINI = { user: "user", assistant: "model" };

/**
 * @param {import("../adapter.js").UnifiedRequest} request
 * @param {import("../adapter.js").Target} target
 * @param {import("../adapter.js").RequestContext} context
 * @returns {import("../adapter.js").ProviderRequest}
 */
export function buildGeminiRequest(request, target, { maxTokens, apiKey, baseUrl }) {
  if (!apiKey) {
    // The router only returns providers that have a key, so reaching this is a bug.
    throw new TypeError("Gemini request built without an API key");
  }

  const base = (baseUrl ?? GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = encodeURIComponent(target.model);
  const action = request.stream ? "streamGenerateContent?alt=sse" : "generateContent";

  const body = {
    contents: request.messages.map((message) => ({
      role: ROLE_TO_GEMINI[message.role],
      parts: [{ text: message.content }],
    })),
    generationConfig: {
      temperature: request.temperature,
      maxOutputTokens: maxTokens,
    },
  };
  if (request.system) {
    body.systemInstruction = { parts: [{ text: request.system }] };
  }

  return {
    url: `${base}/v1beta/models/${model}:${action}`,
    method: "POST",
    // A header rather than ?key=..., so the key never appears in URLs, proxy logs or traces.
    headers: { "x-goog-api-key": apiKey },
    body,
  };
}
