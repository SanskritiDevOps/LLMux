import { mapAnthropicError, statusForErrorType } from "./errors.js";
import { AnthropicUsageSchema, FINISH_REASONS, toUsage, unreadable } from "./response.js";

/**
 * One SSE event of an Anthropic Messages stream → unified stream events.
 * Reference: https://platform.claude.com/docs/en/build-with-claude/streaming
 *
 * Every event's data carries its own `type`, so the SSE `event:` line isn't needed.
 *
 *   message_start                 → usage: the input tokens (output is only a placeholder)
 *   content_block_delta
 *     with delta.type text_delta  → delta. Thinking and tool-input deltas are skipped:
 *                                   they aren't part of the answer.
 *   message_delta                 → usage (output_tokens, a running total) and finish
 *                                   (delta.stop_reason)
 *   error                         → thrown, mapped by its error type
 *   ping, content_block_start,
 *   content_block_stop,
 *   message_stop                  → nothing
 *
 * Input and output tokens arrive in different events, so usage events here can carry only
 * one of the two counts; the gateway keeps the other from the earlier event.
 *
 * @param {string} raw  one event's data, already complete (see streamReader.js)
 * @returns {import("../adapter.js").ProviderStreamEvent[]}
 */
export function parseAnthropicStreamChunk(raw) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw unreadable(err);
  }
  if (json === null || typeof json !== "object") throw unreadable(new Error("Not an object"));

  switch (json.type) {
    case "message_start":
      return usageEvents(json.message?.usage);

    case "content_block_delta": {
      const text = json.delta?.type === "text_delta" ? json.delta.text : undefined;
      return typeof text === "string" && text !== "" ? [{ type: "delta", text }] : [];
    }

    case "message_delta": {
      const events = usageEvents(json.usage);
      const stopReason = json.delta?.stop_reason;
      if (stopReason) {
        events.push({ type: "finish", finishReason: FINISH_REASONS[stopReason] ?? "error" });
      }
      return events;
    }

    case "error":
      throw mapAnthropicError({ status: statusForErrorType(json.error?.type), body: json });

    default:
      return [];
  }
}

function usageEvents(usage) {
  if (usage === undefined || usage === null) return [];
  const result = AnthropicUsageSchema.safeParse(usage);
  if (!result.success) throw unreadable(result.error);

  const counted = toUsage(result.data);
  return Object.keys(counted).length === 0 ? [] : [{ type: "usage", usage: counted }];
}
