import type { ProviderPreferences } from '@tanstack/ai-openrouter'

export const CHAT_MODEL = 'anthropic/claude-haiku-4-5' as const

export const OPENROUTER_PROVIDER_OPTIONS = {
  zdr: true,
  dataCollection: 'deny',
  only: ['google-vertex', 'amazon-bedrock'],
  allowFallbacks: true,
} satisfies ProviderPreferences
