import type { ProviderPreferences, ReasoningOptions } from '@tanstack/ai-openrouter'

// Model and routing choice: docs/adr/0004.
export const CHAT_MODEL = 'openai/gpt-6-luna' as const

// Explicitly off: OpenRouter would otherwise apply the model's default effort,
// and reasoning tokens bill as output.
export const CHAT_REASONING = {
  effort: 'none',
} satisfies ReasoningOptions

// Any provider that neither trains on nor stores prompts for its own use,
// with fallback across them. No ZDR pin: it left luna one congested provider.
export const OPENROUTER_PROVIDER_OPTIONS = {
  dataCollection: 'deny',
  allowFallbacks: true,
} satisfies ProviderPreferences
