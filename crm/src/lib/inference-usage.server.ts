import { sql } from 'drizzle-orm'

import { db, withOwnerTxn } from '#/db'
import { runs } from '#/db/schema'

export type InferenceUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  spendUsd: number
}

export type OwnerInferenceUsage = {
  daily: InferenceUsage
  total: InferenceUsage
}

export type InferenceSpendCaps = {
  dailyUsd: number
  totalUsd: number
}

function configuredCap(name: string) {
  const value = process.env[name]
  if (value === undefined || value === '') return Number.POSITIVE_INFINITY
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`)
  }
  return parsed
}

export function getConfiguredInferenceSpendCaps(): InferenceSpendCaps {
  return {
    dailyUsd: configuredCap('OWNER_DAILY_SPEND_CAP_USD'),
    totalUsd: configuredCap('OWNER_TOTAL_SPEND_CAP_USD'),
  }
}

export function getOwnerInferenceUsage(ownerId: string, now = new Date()) {
  return withOwnerTxn(ownerId, async (): Promise<OwnerInferenceUsage> => {
    const isToday = sql`(
      to_timestamp(${runs.started_at} / 1000.0)
      at time zone 'America/Santiago'
    )::date = (
      ${now.toISOString()}::timestamptz
      at time zone 'America/Santiago'
    )::date`
    const [usage] = await db
      .select({
        dailyPromptTokens: sql<number>`coalesce(sum((${runs.usage_json}->>'promptTokens')::double precision) filter (where ${isToday}), 0)`,
        dailyCompletionTokens: sql<number>`coalesce(sum((${runs.usage_json}->>'completionTokens')::double precision) filter (where ${isToday}), 0)`,
        dailyTotalTokens: sql<number>`coalesce(sum((${runs.usage_json}->>'totalTokens')::double precision) filter (where ${isToday}), 0)`,
        dailySpendUsd: sql<number>`coalesce(sum((${runs.usage_json}->>'cost')::double precision) filter (where ${isToday}), 0)`,
        totalPromptTokens: sql<number>`coalesce(sum((${runs.usage_json}->>'promptTokens')::double precision), 0)`,
        totalCompletionTokens: sql<number>`coalesce(sum((${runs.usage_json}->>'completionTokens')::double precision), 0)`,
        totalTokens: sql<number>`coalesce(sum((${runs.usage_json}->>'totalTokens')::double precision), 0)`,
        totalSpendUsd: sql<number>`coalesce(sum((${runs.usage_json}->>'cost')::double precision), 0)`,
      })
      .from(runs)

    return {
      daily: {
        promptTokens: usage?.dailyPromptTokens ?? 0,
        completionTokens: usage?.dailyCompletionTokens ?? 0,
        totalTokens: usage?.dailyTotalTokens ?? 0,
        spendUsd: usage?.dailySpendUsd ?? 0,
      },
      total: {
        promptTokens: usage?.totalPromptTokens ?? 0,
        completionTokens: usage?.totalCompletionTokens ?? 0,
        totalTokens: usage?.totalTokens ?? 0,
        spendUsd: usage?.totalSpendUsd ?? 0,
      },
    }
  })
}

export async function enforceOwnerInferenceCap(
  ownerId: string,
  now = new Date(),
  caps = getConfiguredInferenceSpendCaps(),
) {
  const usage = await getOwnerInferenceUsage(ownerId, now)
  if (
    usage.daily.spendUsd >= caps.dailyUsd ||
    usage.total.spendUsd >= caps.totalUsd
  ) {
    throw new Response('Inference spend limit reached', { status: 429 })
  }
  return usage
}
