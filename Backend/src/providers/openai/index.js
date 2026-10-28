import { defineAdapter } from "../adapter.js";
import { mapOpenAIError } from "./errors.js";
import { OPENAI_DEFAULT_BASE_URL, buildOpenAIRequest } from "./request.js";
import { parseOpenAIResponse } from "./response.js";
import { parseOpenAIStreamChunk } from "./stream.js";

export const openaiAdapter = defineAdapter({
  name: "openai",
  defaultBaseUrl: OPENAI_DEFAULT_BASE_URL,
  buildRequest: buildOpenAIRequest,
  parseResponse: parseOpenAIResponse,
  mapError: mapOpenAIError,
  streamFormat: "sse",
  parseStreamChunk: parseOpenAIStreamChunk,
});
