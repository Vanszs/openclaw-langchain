// Defaults for agent metadata when upstream does not supply them.
// OpenRouter defaults are pinned to GPT-OSS with DeepInfra bf16 routing so
// the runtime keeps a stable primary path even when user config omits models.
export const DEFAULT_PROVIDER = "openrouter";
export const DEFAULT_MODEL = "openai/gpt-oss-120b";
export const DEFAULT_MODEL_FALLBACKS = [
  "openrouter/anthropic/claude-sonnet-4-6",
  "openrouter/google/gemini-2.5-pro",
] as const;
export const DEFAULT_IMAGE_MODEL_PRIMARY = "openrouter/qwen/qwen-2.5-vl-7b-instruct";
export const DEFAULT_IMAGE_MODEL_FALLBACKS = ["openrouter/anthropic/claude-sonnet-4-6"] as const;

const OPENROUTER_DEEPINFRA_BF16_PROVIDER_ROUTING = {
  order: ["deepinfra"],
  quantizations: ["bf16"],
  require_parameters: true,
  allow_fallbacks: false,
} as const;

const DEFAULT_MODEL_EXTRA_PARAMS_BY_REF: Record<string, Record<string, unknown>> = {
  "openrouter/openai/gpt-oss-120b": {
    provider: OPENROUTER_DEEPINFRA_BF16_PROVIDER_ROUTING,
  },
  "openrouter/qwen/qwen-2.5-vl-7b-instruct": {
    provider: OPENROUTER_DEEPINFRA_BF16_PROVIDER_ROUTING,
  },
};

export function getDefaultModelExtraParams(modelRef: string): Record<string, unknown> | undefined {
  const params = DEFAULT_MODEL_EXTRA_PARAMS_BY_REF[modelRef];
  return params ? structuredClone(params) : undefined;
}
// Conservative fallback used when model metadata is unavailable.
export const DEFAULT_CONTEXT_TOKENS = 200_000;
