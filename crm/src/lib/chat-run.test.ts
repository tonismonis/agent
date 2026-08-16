import { EventType, memoryStream } from '@tanstack/ai'
import { inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { beforeAll, beforeEach, expect, test } from 'vitest'

import { messages, owners, runs } from '#/db/schema'
import { createOwnerChatPersistence } from './chat-persistence'
import { replayOrHydrateChat } from './chat-run'

import type { StreamChunk } from '@tanstack/ai'

const ownerId = '55555555-5555-4555-8555-555555555555'
const otherOwnerId = '66666666-6666-4666-8666-666666666666'
const threadId = 'day-2026-08-16'
const adminDb = drizzle(
  process.env.DATABASE_ADMIN_URL ?? 'postgresql://crm:crm@localhost:5433/crm',
)
const persistence = createOwnerChatPersistence(ownerId)

function get(query: string) {
  return replayOrHydrateChat(
    ownerId,
    new Request(`http://crm.test/api/chat?${query}`),
    threadId,
  )
}

beforeAll(async () => {
  await adminDb
    .insert(owners)
    .values([
      {
        id: ownerId,
        email: 'chat-run@example.test',
        name: 'Carla',
        profession: 'Consultant',
      },
      {
        id: otherOwnerId,
        email: 'chat-run-other@example.test',
        name: 'Diego',
        profession: 'Consultant',
      },
    ])
    .onConflictDoNothing()
})

beforeEach(async () => {
  const ownerIds = [ownerId, otherOwnerId]
  await adminDb.delete(runs).where(inArray(runs.owner_id, ownerIds))
  await adminDb.delete(messages).where(inArray(messages.owner_id, ownerIds))
})

test('hydration abandons a run no process is producing any more', async () => {
  await persistence.stores.runs.createOrResume({
    runId: 'crashed-run',
    threadId,
    startedAt: Date.now(),
  })

  const response = await get(`threadId=${threadId}`)

  expect(await response.json()).toEqual(
    expect.objectContaining({ messages: [], activeRun: null }),
  )
  expect(await persistence.stores.runs.get('crashed-run')).toEqual(
    expect.objectContaining({ status: 'aborted' }),
  )
})

test('a rejoin replays the run log instead of the transcript', async () => {
  await persistence.stores.runs.createOrResume({
    runId: 'live-run',
    threadId,
    startedAt: Date.now(),
  })
  const producer = memoryStream({ runId: 'live-run' })
  // SAFETY: a text-content chunk carries exactly these fields.
  await producer.append([
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: 'message-1',
      delta: 'hola',
      timestamp: Date.now(),
    } as StreamChunk,
  ])
  await producer.close()

  const response = await get('offset=-1&runId=live-run')

  expect(response.headers.get('content-type')).toContain('text/event-stream')
  expect(await response.text()).toContain('hola')
})

test('a rejoin outside the Owner thread is refused', async () => {
  await persistence.stores.runs.createOrResume({
    runId: 'yesterday-run',
    threadId: 'day-2026-01-01',
    startedAt: Date.now(),
  })
  await createOwnerChatPersistence(otherOwnerId).stores.runs.createOrResume({
    runId: 'other-owner-run',
    threadId,
    startedAt: Date.now(),
  })

  for (const runId of ['yesterday-run', 'other-owner-run', 'unknown-run']) {
    let refusal: unknown
    try {
      await get(`offset=-1&runId=${runId}`)
    } catch (error) {
      refusal = error
    }

    expect(refusal).toBeInstanceOf(Response)
    if (refusal instanceof Response) expect(refusal.status).toBe(403)
  }
})
