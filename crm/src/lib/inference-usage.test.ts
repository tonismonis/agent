import { inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { beforeAll, beforeEach, expect, test } from 'vitest'

import { messages, owners, runs } from '#/db/schema'
import { createOwnerChatPersistence } from './chat-persistence'
import {
  enforceOwnerInferenceCap,
  getOwnerInferenceUsage,
} from './inference-usage'

const ownerA = '33333333-3333-4333-8333-333333333333'
const ownerB = '44444444-4444-4444-8444-444444444444'
const adminDb = drizzle(
  process.env.DATABASE_ADMIN_URL ?? 'postgresql://crm:crm@localhost:5433/crm',
)

beforeAll(async () => {
  await adminDb
    .insert(owners)
    .values([
      {
        id: ownerA,
        email: 'usage-alice@example.test',
        name: 'Usage Alice',
        profession: 'Consultant',
      },
      {
        id: ownerB,
        email: 'usage-bob@example.test',
        name: 'Usage Bob',
        profession: 'Consultant',
      },
    ])
    .onConflictDoNothing()
})

beforeEach(async () => {
  await adminDb.delete(runs).where(inArray(runs.owner_id, [ownerA, ownerB]))
  await adminDb
    .delete(messages)
    .where(inArray(messages.owner_id, [ownerA, ownerB]))
})

test('sums daily and total run usage for one Owner', async () => {
  const runStore = createOwnerChatPersistence(ownerA).stores.runs
  const startedAt = new Date('2026-08-03T12:00:00Z').getTime()

  await runStore.createOrResume({
    runId: 'run-alice',
    threadId: 'day-2026-08-03',
    startedAt,
  })
  await runStore.update('run-alice', {
    status: 'completed',
    finishedAt: startedAt + 1_000,
    usage: {
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cost: 0.75,
    },
  })
  await runStore.createOrResume({
    runId: 'run-alice-yesterday',
    threadId: 'day-2026-08-02',
    startedAt: new Date('2026-08-02T12:00:00Z').getTime(),
  })
  await runStore.update('run-alice-yesterday', {
    status: 'completed',
    usage: {
      promptTokens: 40,
      completionTokens: 10,
      totalTokens: 50,
      cost: 0.25,
    },
  })

  expect(
    await getOwnerInferenceUsage(ownerA, new Date('2026-08-03T13:00:00Z')),
  ).toEqual({
    daily: {
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      spendUsd: 0.75,
    },
    total: {
      promptTokens: 140,
      completionTokens: 30,
      totalTokens: 170,
      spendUsd: 1,
    },
  })
  expect(
    await getOwnerInferenceUsage(ownerB, new Date('2026-08-03T13:00:00Z')),
  ).toEqual({
    daily: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      spendUsd: 0,
    },
    total: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      spendUsd: 0,
    },
  })
})

test('rejects a new run when the Owner daily spend cap is reached', async () => {
  const runStore = createOwnerChatPersistence(ownerA).stores.runs
  const startedAt = new Date('2026-08-03T12:00:00Z').getTime()
  await runStore.createOrResume({
    runId: 'run-at-cap',
    threadId: 'day-2026-08-03',
    startedAt,
  })
  await runStore.update('run-at-cap', {
    usage: {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cost: 0.5,
    },
  })

  await expect(
    enforceOwnerInferenceCap(
      ownerA,
      new Date('2026-08-03T13:00:00Z'),
      { dailyUsd: 0.5, totalUsd: 10 },
    ),
  ).rejects.toMatchObject({ status: 429 })
})

test('rejects a new run when the Owner total spend cap is reached', async () => {
  const runStore = createOwnerChatPersistence(ownerA).stores.runs
  await runStore.createOrResume({
    runId: 'run-old-total',
    threadId: 'day-2026-08-02',
    startedAt: new Date('2026-08-02T12:00:00Z').getTime(),
  })
  await runStore.update('run-old-total', {
    usage: {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cost: 1,
    },
  })

  await expect(
    enforceOwnerInferenceCap(
      ownerA,
      new Date('2026-08-03T13:00:00Z'),
      { dailyUsd: 10, totalUsd: 1 },
    ),
  ).rejects.toMatchObject({ status: 429 })
})
