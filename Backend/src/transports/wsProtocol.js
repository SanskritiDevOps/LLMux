import { z } from "zod";
import { ChatRequestSchema } from "../gateway/schemas.js";
import { formatIssues } from "../middleware/validate.js";
import { GatewayError } from "../utils/errors.js";

/**
 * The /v1/ws protocol (README section 19). Every message is one JSON object with a `type`.
 * Every incoming message is checked here before anything acts on it; unknown types and
 * unknown fields are rejected, the same as the HTTP API.
 *
 *   client → server   auth { apiKey } · chat { requestId, …POST /v1/chat body } ·
 *                     cancel { requestId } · ping
 *   server → client   auth_ok · start / delta / end / error (with requestId) ·
 *                     cancelled { requestId } · pong
 */

// Client-chosen, unique among the socket's requests in progress. Kept short and plain so
// it is safe to log and to echo back.
export const RequestIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, {
  error: "must be 1-64 letters, digits or _ . : -",
});

const AuthMessageSchema = z.strictObject({
  type: z.literal("auth"),
  apiKey: z.string().max(200),
});

// A chat is a POST /v1/chat body plus a requestId. WebSocket chats always stream, so the
// `stream` field does not exist here (sending it is an unknown-field error).
const ChatMessageSchema = ChatRequestSchema.omit({ stream: true }).extend({
  type: z.literal("chat"),
  requestId: RequestIdSchema,
});

const CancelMessageSchema = z.strictObject({
  type: z.literal("cancel"),
  requestId: RequestIdSchema,
});

const PingMessageSchema = z.strictObject({ type: z.literal("ping") });

export const ClientMessageSchema = z.discriminatedUnion("type", [
  AuthMessageSchema,
  ChatMessageSchema,
  CancelMessageSchema,
  PingMessageSchema,
]);

export const CLIENT_MESSAGE_TYPES = ["auth", "chat", "cancel", "ping"];

/**
 * Parses one incoming frame. Throws INVALID_REQUEST with a client-safe message (the same
 * wording as HTTP validation) for binary frames, bad JSON, unknown types or bad fields.
 * When the frame names a usable requestId, the error carries it, so the client can tell
 * which of its requests was refused.
 *
 * @param {import("ws").RawData} data
 * @param {boolean} isBinary
 */
export function parseClientMessage(data, isBinary) {
  if (isBinary) {
    throw new GatewayError("INVALID_REQUEST", "Messages must be text frames containing JSON");
  }

  let json;
  try {
    json = JSON.parse(data.toString());
  } catch {
    throw new GatewayError("INVALID_REQUEST", "Message is not valid JSON");
  }

  const result = ClientMessageSchema.safeParse(json);
  if (!result.success) {
    const error = new GatewayError("INVALID_REQUEST", invalidMessage(json, result.error));
    const requestId = RequestIdSchema.safeParse(json?.requestId);
    if (requestId.success) error.requestId = requestId.data;
    throw error;
  }
  return result.data;
}

function invalidMessage(json, zodError) {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return "Invalid request: message must be a JSON object";
  }
  if (!CLIENT_MESSAGE_TYPES.includes(json.type)) {
    return `Invalid request: type must be one of ${CLIENT_MESSAGE_TYPES.join(", ")}`;
  }
  return formatIssues(zodError.issues, "message");
}

/** The error message for one request, or for the socket when there is no requestId. */
export function errorMessage(error, requestId) {
  return {
    type: "error",
    ...(requestId !== undefined && { requestId }),
    code: error.code,
    message: error.message,
  };
}
