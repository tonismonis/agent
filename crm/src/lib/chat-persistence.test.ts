import { inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { beforeAll, beforeEach, expect, test } from 'vitest'

import { messages, owners, runs } from '#/db/schema'
import { createOwnerChatPersistence } from './chat-persistence.server'

const ownerA = '11111111-1111-4111-8111-111111111111'
const ownerB = '22222222-2222-4222-8222-222222222222'
const adminDb = drizzle(
  process.env.DATABASE_ADMIN_URL ?? 'postgresql://crm:crm@localhost:5433/crm',
)

beforeAll(async () => {
  await adminDb
    .insert(owners)
    .values([
      {
        id: ownerA,
        email: 'alice@example.test',
        name: 'Alice',
        profession: 'Consultant',
      },
      {
        id: ownerB,
        email: 'bob@example.test',
        name: 'Bob',
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

test('persisted messages are isolated by Owner', async () => {
  const persistenceA = createOwnerChatPersistence(ownerA)
  const persistenceB = createOwnerChatPersistence(ownerB)
  const aliceMessage = { role: 'user' as const, content: 'Alice private' }
  const bobMessage = { role: 'user' as const, content: 'Bob private' }

  await persistenceA.stores.messages.saveThread('day-2026-08-03', [aliceMessage])

  expect(
    await persistenceB.stores.messages.loadThread('day-2026-08-03'),
  ).toEqual([])

  await persistenceB.stores.messages.saveThread('day-2026-08-03', [bobMessage])

  expect(
    await persistenceA.stores.messages.loadThread('day-2026-08-03'),
  ).toEqual([aliceMessage])
  expect(
    await persistenceB.stores.messages.loadThread('day-2026-08-03'),
  ).toEqual([bobMessage])
})
