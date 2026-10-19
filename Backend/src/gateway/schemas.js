import { z } from "zod";

/**
 * The unified contract from README section 8. Every client sends and receives these
 * shapes no matter which provider answers; only adapters translate them.
 * Objects are strict: an unknown field (for example a typo like `max_tokens`) is rejected
 * instead of being silently ignored.
 */

export const MAX_MESSAGES = 100;
export const MAX_METADATA_KEYS = 20;

export const ROLES = ["user", "assistant"];
export const FINISH_REASONS = ["stop", "length", "content_filter", "error"];

export const MessageSchema = z.strictObject({
  role: z.enum(ROLES),
  content: z.string().min(1, { error: "must not be empty" }),
});

// Flat tags only, so they stay small and can be filtered on in usage_logs.metadata.
const MetadataSchema = z
  .record(z.string().min(1).max(64), z.union([z.string().max(256), z.number(), z.boolean()]))
  .refine((tags) => Object.keys(tags).length <= MAX_METADATA_KEYS, {
    error: `must have at most ${MAX_METADATA_KEYS} keys`,
  });

export const ChatRequestSchema = z.strictObject({
  model: z.string().trim().min(1).max(200),
  system: z.string().min(1).optional(),
  messages: z
    .array(MessageSchema)
    .min(1, { error: "must contain at least one message" })
    .max(MAX_MESSAGES, { error: `must contain at most ${MAX_MESSAGES} messages` }),
  temperature: z.number().min(0).max(2).default(0.7),
  // Optional: the gateway fills in the model's default and caps it per model.
  maxTokens: z.int().positive().optional(),
  stream: z.boolean().default(false),
  cache: z.boolean().default(true),
  metadata: MetadataSchema.optional(),
});

export const UsageSchema = z.strictObject({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  totalTokens: z.int().nonnegative(),
});

export const ChatResponseSchema = z.strictObject({
  id: z.string(),
  model: z.string(),
  provider: z.string(),
  providerModel: z.string(),
  content: z.string(),
  finishReason: z.enum(FINISH_REASONS),
  usage: UsageSchema,
  costUsd: z.number().nonnegative(),
  latencyMs: z.int().nonnegative(),
  cached: z.boolean(),
  fallbackUsed: z.boolean(),
});

/**
 * Stream events, identical for SSE and WebSocket. `type` becomes the SSE `event:` name
 * (or the WebSocket message `type`); the remaining fields are the payload.
 */
export const StreamEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("start"),
    id: z.string(),
    model: z.string(),
    provider: z.string(),
  }),
  z.strictObject({
    type: z.literal("delta"),
    text: z.string(),
  }),
  z.strictObject({
    type: z.literal("end"),
    finishReason: z.enum(FINISH_REASONS),
    usage: UsageSchema,
    // True when the provider sent no final usage and the gateway had to estimate it.
    usageEstimated: z.boolean().optional(),
    latencyMs: z.int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
  }),
]);
