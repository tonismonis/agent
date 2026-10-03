// The POST lifecycle of a turn, with the model replaced: which requests start a
// run, which only read one, and what a run records when it ends.
import { EventType, chatParamsFromRequestBody } from '@tanstack/ai'
import { eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

import { messages, owners, runs } from '#/db/schema'
import { createOwnerChatPersistence } from './chat-persistence.server'
import {
  cancelChatRun,
  replayOrHydrateChat,
  runLogId,
  streamChatTurn,
} from './chat-run.server'
import { getDailyThreadId } from './chat-thread'

import type {
  ChatMiddlewareContext,
  StreamChunk,
  TokenUsage,
} from '@tanstack/ai'
import type { Turn } from './chat-run.server'

const ownerId = '88888888-8888-4888-8888-888888888888'
const otherOwnerId = '99999999-9999-4999-8999-999999999999'
const now = new Date('2026-09-23T15:00:00Z')
const threadId = getDailyThreadId(now)
const adminDb = drizzle(
  process.env.DATABASE_ADMIN_URL ?? 'postgresql://crm:crm@localhost:5433/crm',
)

function text(delta: string) {
  // SAFETY: a text-content chunk carries exactly these fields.
  return {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: 'message-1',
    delta,
    timestamp: Date.now(),
  } as StreamChunk
}

/**
 * Stands in for the model: creates the run row as withPersistence would,
 * reports each usage, says which Owner it ran for, then optionally holds
 * until the run is stopped.
 */
const model = {
  calls: 0,
  usages: new Array<TokenUsage>(),
  hold: false,
  async *drive({ owner, params, middleware, abortController }: Turn) {
    model.calls += 1
    await createOwnerChatPersistence(owner.id).stores.runs.createOrResume({
      runId: params.runId,
      threadId,
      startedAt: Date.now(),
    })
    for (const usage of model.usages) {
      for (const hooks of middleware) {
        // SAFETY: the usage tally never reads its context.
        await hooks.onUsage?.({} as ChatMiddlewareContext, usage)
      }
    }
    yield text(`reply for ${owner.id}`)
    const { signal } = abortController
    if (model.hold && !signal.aborted) {
      await new Promise((resolve) => signal.addEventListener('abort', resolve))
    }
  },
}

function fakeModel({
  usages = [],
  hold = false,
}: { usages?: Array<TokenUsage>; hold?: boolean } = {}) {
  model.usages = usages
  model.hold = hold
}

async function ownerRow(id: string) {
  const [row] = await adminDb.select().from(owners).where(eq(owners.id, id))
  if (!row) throw new Error('fixture owner missing')
  return row
}

async function post(
  owner: string,
  runId: string,
  headers: Record<string, string> = {},
) {
  const request = new Request('http://crm.test/api/chat', {
    method: 'POST',
    headers,
  })
  const params = await chatParamsFromRequestBody({
    threadId,
    runId,
    messages: [],
    tools: [],
    context: [],
  })
  return streamChatTurn(
    await ownerRow(owner),
    params,
    request,
    now,
    model.drive,
  )
}

async function refusal(pending: Promise<unknown>) {
  try {
    await pending
  } catch (error) {
    if (error instanceof Response) return error
    throw error
  }
  throw new Error('expected a refusal')
}

beforeAll(async () => {
  await adminDb
    .insert(owners)
    .values([
      {
        id: ownerId,
        email: 'chat-stream@example.test',
        name: 'Fer',
        profession: 'Consultant',
      },
      {
        id: otherOwnerId,
        email: 'chat-stream-other@example.test',
        name: 'Gabi',
        profession: 'Consultant',
      },
    ])
    .onConflictDoNothing()
})

beforeEach(async () => {
  model.calls = 0
  fakeModel()
  const ownerIds = [ownerId, otherOwnerId]
  await adminDb.delete(runs).where(inArray(runs.owner_id, ownerIds))
  await adminDb.delete(messages).where(inArray(messages.owner_id, ownerIds))
})

afterEach(() => {
  cancelChatRun(ownerId)
  cancelChatRun(otherOwnerId)
})

test('a turn records usage summed over every model call', async () => {
  fakeModel({
    usages: [
      { promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0.01 },
      { promptTokens: 20, completionTokens: 10, totalTokens: 30, cost: 0.02 },
    ],
  })

  const response = await post(ownerId, 'usage-run')

  expect(await response.text()).toContain(`reply for ${ownerId}`)
  const run = await createOwnerChatPersistence(ownerId).stores.runs.get(
    'usage-run',
  )
  expect(run?.usage).toEqual(
    expect.objectContaining({ promptTokens: 30, totalTokens: 45 }),
  )
  expect(run?.usage?.cost).toBeCloseTo(0.03)
})

test('a runId the Owner already used never runs again', async () => {
  fakeModel()
  await createOwnerChatPersistence(ownerId).stores.runs.createOrResume({
    runId: 'used-run',
    threadId,
    startedAt: Date.now(),
  })

  expect((await refusal(post(ownerId, 'used-run'))).status).toBe(409)
  expect(model.calls).toBe(0)
})

test('a reconnect reads the run it started instead of running it again', async () => {
  fakeModel()
  const first = await (await post(ownerId, 'reconnect-run')).text()
  const cursor = /^id: (.+)$/m.exec(first)?.[1]
  expect(cursor).toBeDefined()

  const again = await post(ownerId, 'reconnect-run', {
    'Last-Event-ID': cursor ?? '',
  })

  await again.text()
  expect(model.calls).toBe(1)
})

test('a second run is refused while the first holds the Owner slot, and Stop ends the first', async () => {
  fakeModel({ hold: true })
  const first = await post(ownerId, 'held-run')

  expect((await refusal(post(ownerId, 'second-run'))).status).toBe(409)

  cancelChatRun(ownerId)
  expect(await first.text()).toContain('Run stopped')

  fakeModel()
  const third = await post(ownerId, 'third-run')
  expect(await third.text()).toContain(`reply for ${ownerId}`)
})

test("another Owner's runId starts that Owner's own run, never reads the first", async () => {
  fakeModel({ hold: true })
  const victim = await post(ownerId, 'shared-run-id')

  const attacker = await post(otherOwnerId, 'shared-run-id')
  cancelChatRun(otherOwnerId)

  const seen = await attacker.text()
  expect(seen).toContain(`reply for ${otherOwnerId}`)
  expect(seen).not.toContain(`reply for ${ownerId}`)
  cancelChatRun(ownerId)
  await victim.text()
})

test("a rejoin cursor naming another Owner's log replays nothing from it", async () => {
  fakeModel({ hold: true })
  const victim = await post(ownerId, 'victim-run')
  await createOwnerChatPersistence(otherOwnerId).stores.runs.createOrResume({
    runId: 'own-run',
    threadId,
    startedAt: Date.now(),
  })

  const cursor = `memory:v1:${encodeURIComponent(runLogId(ownerId, 'victim-run'))}:0`
  const response = await replayOrHydrateChat(
    otherOwnerId,
    new Request('http://crm.test/api/chat?runId=own-run', {
      headers: { 'Last-Event-ID': cursor },
    }),
    now,
  )

  expect(await response.text()).not.toContain(`reply for ${ownerId}`)
  cancelChatRun(ownerId)
  await victim.text()
})
