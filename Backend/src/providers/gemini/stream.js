import {
  FINISH_REASONS,
  GeminiResponseSchema,
  answerText,
  mapGeminiError,
  toUsage,
  unreadable,
} from "./response.js";

/**
 * One event of Gemini's streamGenerateContent?alt=sse → unified stream events.
 * Reference: https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
 *
 * Every event's data is a GenerateContentResponse holding the next piece of the answer:
 *   candidates[0].content.parts[].text  → delta (thought parts are skipped)
 *   usageMetadata                       → usage (running totals, so the last one wins)
 *   candidates[0].finishReason          → finish (only on the last event)
 *   promptFeedback.blockReason          → finish content_filter (the prompt was refused)
 *   { error: { code, message } }        → thrown, mapped like a non-streaming error
 *
 * @param {string} raw  one event's data, already complete (see streamReader.js)
 * @returns {import("../adapter.js").ProviderStreamEvent[]}
 */
export function parseGeminiStreamChunk(raw) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw unreadable(err);
  }

  // Once the HTTP status is 200 it cannot change, so Gemini reports a failure that
  // happens mid-answer as an event; its numeric code is the HTTP status it would have used.
  if (json?.error) {
    const status = Number.isInteger(json.error.code) ? json.error.code : 500;
    throw mapGeminiError({ status, body: json });
  }

  const result = GeminiResponseSchema.safeParse(json);
  if (!result.success || json === null || typeof json !== "object") {
    throw unreadable(result.error);
  }
  const { candidates, promptFeedback, usageMetadata } = result.data;

  const events = [];
  const candidate = candidates?.[0];
  const text = candidate ? answerText(candidate) : "";
  if (text !== "") events.push({ type: "delta", text });
  if (usageMetadata) events.push({ type: "usage", usage: toUsage(usageMetadata) });

  if (candidate?.finishReason) {
    events.push({
      type: "finish",
      finishReason: FINISH_REASONS[candidate.finishReason] ?? "error",
    });
  } else if (!candidate && promptFeedback?.blockReason) {
    events.push({ type: "finish", finishReason: "content_filter" });
  }
  return events;
}
