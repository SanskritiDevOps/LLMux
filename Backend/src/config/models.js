import { z } from "zod";

export const PROVIDERS = ["gemini", "ollama", "openai", "anthropic"];

/**
 * Every provider model LLMux may call, keyed "provider:model".
 *
 * Prices are micro-dollars (1 USD = 1,000,000) per 1 million tokens, as integers, so cost
 * math never touches floating point. Copied from the official pricing pages on 2026-10-19:
 *   https://ai.google.dev/gemini-api/docs/pricing (page dated 2026-10-16)
 *   https://developers.openai.com/api/docs/pricing
 *   https://platform.claude.com/docs/en/about-claude/pricing
 * Tiered models are priced at their base tier (Gemini 2.5 Pro: prompts up to 200k tokens).
 *
 * maxOutputTokens is LLMux's own cap per request, not the model's hard limit: it bounds
 * what one call can cost. Requests asking for more are clamped to it.
 */
const catalog = {
  "gemini:gemini-3.5-flash-lite": {
    inputPerMTok: 300_000, // $0.30
    outputPerMTok: 2_500_000, // $2.50
    maxOutputTokens: 8192,
  },
  "gemini:gemini-2.5-pro": {
    inputPerMTok: 1_250_000, // $1.25
    outputPerMTok: 10_000_000, // $10.00
    maxOutputTokens: 8192,
  },
  "openai:gpt-6.1-sol": {
    inputPerMTok: 2_000_000, // $2.00
    outputPerMTok: 10_000_000, // $10.00
    maxOutputTokens: 8192,
  },
  "anthropic:claude-sonnet-5-5": {
    inputPerMTok: 2_000_000, // $2.00
    outputPerMTok: 10_000_000, // $10.00
    maxOutputTokens: 8192,
  },
  // Local models are free to run.
  "ollama:llama3.2:1b": {
    inputPerMTok: 0,
    outputPerMTok: 0,
    maxOutputTokens: 4096,
  },
};

/**
 * Aliases clients use in the `model` field. targets[0] is the primary; the rest are the
 * fallback chain, tried in order. Changing a target here switches every client at once.
 */
const aliases = {
  fast: {
    description: "Cheap and quick; falls back to a local model",
    targets: ["gemini:gemini-3.5-flash-lite", "ollama:llama3.2:1b"],
    defaultMaxTokens: 1024,
  },
  smart: {
    description: "Strongest available model across providers",
    targets: ["anthropic:claude-sonnet-5-5", "openai:gpt-6.1-sol", "gemini:gemini-2.5-pro"],
    defaultMaxTokens: 2048,
  },
  local: {
    description: "Runs on the local Ollama server only",
    targets: ["ollama:llama3.2:1b"],
    defaultMaxTokens: 1024,
  },
};

// "provider:model". The model part may itself contain ":" (Ollama tags like llama3.2:1b).
const targetKey = z.string().regex(new RegExp(`^(${PROVIDERS.join("|")}):.+$`), {
  error: `must look like "provider:model" with provider one of ${PROVIDERS.join(", ")}`,
});

const microDollars = z.int().nonnegative();

const ModelConfigSchema = z
  .strictObject({
    catalog: z.record(
      targetKey,
      z.strictObject({
        inputPerMTok: microDollars,
        outputPerMTok: microDollars,
        maxOutputTokens: z.int().positive(),
      }),
    ),
    aliases: z.record(
      // Lowercase names without ":", so an alias can never be mistaken for a direct call.
      z.string().regex(/^[a-z][a-z0-9-]*$/, {
        error: "alias names must be lowercase letters, digits and dashes",
      }),
      z.strictObject({
        description: z.string().min(1),
        targets: z.array(targetKey).min(1),
        defaultMaxTokens: z.int().positive(),
      }),
    ),
  })
  .superRefine((config, ctx) => {
    for (const [name, alias] of Object.entries(config.aliases)) {
      alias.targets.forEach((target, i) => {
        const entry = config.catalog[target];
        if (!entry) {
          ctx.addIssue({
            code: "custom",
            path: ["aliases", name, "targets", i],
            message: `"${target}" is not in the catalog, so it has no price`,
          });
        } else if (alias.defaultMaxTokens > entry.maxOutputTokens) {
          ctx.addIssue({
            code: "custom",
            path: ["aliases", name, "defaultMaxTokens"],
            message: `exceeds maxOutputTokens (${entry.maxOutputTokens}) of "${target}"`,
          });
        }
      });
      if (new Set(alias.targets).size !== alias.targets.length) {
        ctx.addIssue({
          code: "custom",
          path: ["aliases", name, "targets"],
          message: "lists the same target twice",
        });
      }
    }
  });

/**
 * Validates a model configuration and returns it deeply frozen. Pure, so tests can
 * feed it broken configs; the module below runs it once on import, which makes a typo
 * in this file stop the server at startup instead of failing at request time.
 */
export function parseModelConfig(raw) {
  const result = ModelConfigSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      // Zod reports a bad record key as "Invalid key in record" and nests the reason.
      const message =
        issue.code === "invalid_key"
          ? `invalid name: ${issue.issues.map((inner) => inner.message).join(", ")}`
          : issue.message;
      return `  - ${issue.path.join(".")}: ${message}`;
    });
    throw new Error(`Invalid model configuration:\n${problems.join("\n")}`);
  }
  return deepFreeze(result.data);
}

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") deepFreeze(child);
  }
  return Object.freeze(value);
}

export const modelConfig = parseModelConfig({ catalog, aliases });
