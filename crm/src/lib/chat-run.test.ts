import { EventType, memoryStream } from '@tanstack/ai'
import { inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { beforeAll, beforeEach, expect, test } from 'vitest'

import { messages, owners, runs } from '#/db/schema'
import { createOwnerChatPersistence } from './chat-persistence'
import {
  handleChatRequest,
  isValidClientThreadId,
  parseChatParams,
  replayOrHydrateChat,
  runLogId,
} from './chat-run'
import { getDailyThreadId } from './chat-thread'

import type { StreamChunk } from '@tanstack/ai'

const ownerId = '55555555-5555-4555-8555-555555555555'
const otherOwnerId = '66666666-6666-4666-8666-666666666666'
const now = new Date('2026-08-16T12:00:00Z')
const threadId = getDailyThreadId(now)
const adminDb = drizzle(
  process.env.DATABASE_ADMIN_URL ?? 'postgresql://crm:crm@localhost:5433/crm',
)
const persistence = createOwnerChatPersistence(ownerId)

test('chat request preserves thrown responses', async () => {
  const refusal = Response.json({ error: 'forbidden' }, { status: 403 })

  await expect(
    handleChatRequest(new Request('http://crm.test/api/chat'), () => {
      throw refusal
    }),
  ).rejects.toBe(refusal)
})

test('chat request hides unexpected errors', async () => {
  const response = await handleChatRequest(
    new Request('http://crm.test/api/chat'),
    () => {
      throw new Error('database credentials leaked')
    },
  )

  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({ error: 'Internal server error' })
})

test('chat request returns early when already aborted', async () => {
  const abortController = new AbortController()
  abortController.abort()
  let started = false

  const response = await handleChatRequest(
    new Request('http://crm.test/api/chat', {
      signal: abortController.signal,
    }),
    () => {
      started = true
      return new Response()
    },
  )

  expect(response.status).toBe(499)
  expect(started).toBe(false)
})

test('malformed chat params return JSON 400', async () => {
  const request = new Request('http://crm.test/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  })

  const response = await handleChatRequest(request, async () => {
    await parseChatParams(request)
    return new Response()
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'Invalid request body' })
})

test('accepts the current daily thread', () => {
  const now = new Date('2026-08-16T12:00:00Z')

  expect(isValidClientThreadId(getDailyThreadId(now), now)).toBe(true)
})

test('accepts thread ids at the five-minute skew boundaries', () => {
  const afterRotation = new Date('2026-08-16T04:03:00Z')
  const beforeRotation = new Date('2026-08-17T03:57:00Z')

  expect(
    isValidClientThreadId(
      getDailyThreadId(new Date(afterRotation.getTime() - 5 * 60_000)),
      afterRotation,
    ),
  ).toBe(true)
  expect(
    isValidClientThreadId(
      getDailyThreadId(new Date(beforeRotation.getTime() + 5 * 60_000)),
      beforeRotation,
    ),
  ).toBe(true)
})

test('rejects a stale daily thread', () => {
  const now = new Date('2026-08-16T12:00:00Z')

  expect(isValidClientThreadId('day-2026-08-15', now)).toBe(false)
})

function get(query: string) {
  return replayOrHydrateChat(
    ownerId,
    new Request(`http://crm.test/api/chat?${query}`),
    now,
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
  const producer = memoryStream({ runId: runLogId(ownerId, 'live-run') })
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
