import { defineAdapter } from "../adapter.js";
import { OLLAMA_DEFAULT_BASE_URL, buildOllamaRequest } from "./request.js";
import { mapOllamaError, parseOllamaResponse } from "./response.js";

export const ollamaAdapter = defineAdapter({
  name: "ollama",
  defaultBaseUrl: OLLAMA_DEFAULT_BASE_URL,
  buildRequest: buildOllamaRequest,
  parseResponse: parseOllamaResponse,
  mapError: mapOllamaError,
});
