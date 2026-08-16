import type { ProviderPreferences, ReasoningOptions } from '@tanstack/ai-openrouter'

export const CHAT_MODEL = 'openai/gpt-5.6-luna' as const

// Explicitly off: OpenRouter would otherwise apply the model's default effort,
// and reasoning tokens bill as output. The checkpoint-2 A/B gate
// (ab-utterances.md) must run against this same config before deploy.
export const CHAT_REASONING = {
  effort: 'none',
} satisfies ReasoningOptions

// ZDR pin is model-specific: for luna only Azure endpoints are ZDR
// (first-party OpenAI and Bedrock are not, checked 2026-08-15).
// Previous haiku-4-5 pin was ['google-vertex', 'amazon-bedrock'].
export const OPENROUTER_PROVIDER_OPTIONS = {
  zdr: true,
  dataCollection: 'deny',
  only: ['azure'],
  allowFallbacks: true,
} satisfies ProviderPreferences
