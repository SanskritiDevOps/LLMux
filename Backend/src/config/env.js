import dotenv from "dotenv";
import { z } from "zod";

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().min(0);

const booleanString = z
  .enum(["true", "false"], { error: 'must be "true" or "false"' })
  .transform((value) => value === "true");

// Provider keys are optional: a provider with no key is disabled at startup.
const optionalSecret = z.string().min(1).optional();

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: port.default(5000),
    DASHBOARD_URL: z.url().default("http://localhost:5173"),

    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: "must be a postgresql:// URL" }),
    REDIS_URL: z.url({ protocol: /^rediss?$/, error: "must be a redis:// or rediss:// URL" }),

    JWT_SECRET: z.string().min(32, {
      error:
        "must be at least 32 characters. Generate one with: " +
        "node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"",
    }),

    GEMINI_API_KEY: optionalSecret,
    OPENAI_API_KEY: optionalSecret,
    ANTHROPIC_API_KEY: optionalSecret,
    OLLAMA_BASE_URL: z.url().optional(),

    DEFAULT_RATE_LIMIT_PER_MIN: positiveInt.default(60),
    REQUEST_TIMEOUT_MS: positiveInt.default(30_000),
    REQUEST_DEADLINE_MS: positiveInt.default(60_000),
    MAX_RETRIES: nonNegativeInt.max(10).default(2),
    CACHE_TTL_SECONDS: positiveInt.default(3600),
    CACHE_ONLY_DETERMINISTIC: booleanString.default(true),
    MAX_BODY_SIZE: z
      .string()
      .regex(/^\d+(b|kb|mb)$/i, { error: 'must look like "100kb" or "1mb"' })
      .default("1mb"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
  })
  .refine((env) => env.REQUEST_TIMEOUT_MS <= env.REQUEST_DEADLINE_MS, {
    path: ["REQUEST_TIMEOUT_MS"],
    error: "must not exceed REQUEST_DEADLINE_MS",
  });

/**
 * Validates a raw environment object and returns a frozen config.
 * Empty strings are treated as unset, so `GEMINI_API_KEY=` in .env disables Gemini
 * instead of failing validation. Error messages name variables, never their values.
 *
 * @param {Record<string, string | undefined>} source
 */
export function parseEnv(source) {
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ""),
  );

  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `  - ${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${problems.join("\n")}`);
  }

  return Object.freeze(result.data);
}

dotenv.config({ quiet: true });

export const env = parseEnv(process.env);
