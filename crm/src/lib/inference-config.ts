import type { ProviderPreferences } from '@tanstack/ai-openrouter'

export const CHAT_MODEL = 'openai/gpt-5.6-luna' as const

// ZDR pin is model-specific: for luna only Azure endpoints are ZDR
// (first-party OpenAI and Bedrock are not, checked 2026-08-15).
// Previous haiku-4-5 pin was ['google-vertex', 'amazon-bedrock'].
export const OPENROUTER_PROVIDER_OPTIONS = {
  zdr: true,
  dataCollection: 'deny',
  only: ['azure'],
  allowFallbacks: true,
} satisfies ProviderPreferences
