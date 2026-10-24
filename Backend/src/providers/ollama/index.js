import { defineAdapter } from "../adapter.js";
import { OLLAMA_DEFAULT_BASE_URL, buildOllamaRequest } from "./request.js";
import { mapOllamaError, parseOllamaResponse } from "./response.js";
import { parseOllamaStreamChunk } from "./stream.js";

export const ollamaAdapter = defineAdapter({
  name: "ollama",
  defaultBaseUrl: OLLAMA_DEFAULT_BASE_URL,
  buildRequest: buildOllamaRequest,
  parseResponse: parseOllamaResponse,
  mapError: mapOllamaError,
  streamFormat: "ndjson",
  parseStreamChunk: parseOllamaStreamChunk,
});
