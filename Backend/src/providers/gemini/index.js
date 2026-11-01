import { defineAdapter } from "../adapter.js";
import { GEMINI_DEFAULT_BASE_URL, buildGeminiRequest } from "./request.js";
import { mapGeminiError } from "./errors.js";
import { parseGeminiResponse } from "./response.js";
import { parseGeminiStreamChunk } from "./stream.js";

export const geminiAdapter = defineAdapter({
  name: "gemini",
  defaultBaseUrl: GEMINI_DEFAULT_BASE_URL,
  buildRequest: buildGeminiRequest,
  parseResponse: parseGeminiResponse,
  mapError: mapGeminiError,
  streamFormat: "sse",
  parseStreamChunk: parseGeminiStreamChunk,
});
