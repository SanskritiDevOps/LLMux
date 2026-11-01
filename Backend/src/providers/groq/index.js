import { defineAdapter } from "../adapter.js";
import { mapGroqError } from "./errors.js";
import { GROQ_DEFAULT_BASE_URL, buildGroqRequest } from "./request.js";
import { parseGroqResponse } from "./response.js";
import { parseGroqStreamChunk } from "./stream.js";

export const groqAdapter = defineAdapter({
  name: "groq",
  defaultBaseUrl: GROQ_DEFAULT_BASE_URL,
  buildRequest: buildGroqRequest,
  parseResponse: parseGroqResponse,
  mapError: mapGroqError,
  streamFormat: "sse",
  parseStreamChunk: parseGroqStreamChunk,
});
