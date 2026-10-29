import { defineAdapter } from "../adapter.js";
import { mapAnthropicError } from "./errors.js";
import { ANTHROPIC_DEFAULT_BASE_URL, buildAnthropicRequest } from "./request.js";
import { parseAnthropicResponse } from "./response.js";
import { parseAnthropicStreamChunk } from "./stream.js";

export const anthropicAdapter = defineAdapter({
  name: "anthropic",
  defaultBaseUrl: ANTHROPIC_DEFAULT_BASE_URL,
  buildRequest: buildAnthropicRequest,
  parseResponse: parseAnthropicResponse,
  mapError: mapAnthropicError,
  streamFormat: "sse",
  parseStreamChunk: parseAnthropicStreamChunk,
});
