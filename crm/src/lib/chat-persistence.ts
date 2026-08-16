import { and, desc, eq } from 'drizzle-orm'
import {
  defineAIPersistence,
  defineMessageStore,
  defineRunStore,
} from '@tanstack/ai-persistence'

import { db, withOwnerTxn } from '#/db'
import { messages as persistedMessages, runs } from '#/db/schema'
import type { RunRecord } from '@tanstack/ai-persistence'

function mapRun(row: typeof runs.$inferSelect): RunRecord {
  const run: RunRecord = {
    runId: row.run_id,
    threadId: row.thread_id,
    status: row.status,
    startedAt: row.started_at,
  }
  if (row.finished_at != null) run.finishedAt = row.finished_at
  if (row.error != null) run.error = { message: row.error }
  if (row.usage_json != null) run.usage = row.usage_json
  return run
}

export function createOwnerChatPersistence(ownerId: string) {
  return defineAIPersistence({
    stores: {
      messages: defineMessageStore({
        loadThread: (threadId) =>
          withOwnerTxn(ownerId, async () => {
            const [row] = await db
              .select({ messages: persistedMessages.messages_json })
              .from(persistedMessages)
              .where(eq(persistedMessages.thread_id, threadId))
              .limit(1)
            return row?.messages ?? []
          }),
        saveThread: (threadId, messages) =>
          withOwnerTxn(ownerId, async () => {
            await db
              .insert(persistedMessages)
              .values({
                thread_id: threadId,
                messages_json: messages,
                updated_at: Date.now(),
              })
              .onConflictDoUpdate({
                target: [
                  persistedMessages.owner_id,
                  persistedMessages.thread_id,
                ],
                set: { messages_json: messages, updated_at: Date.now() },
              })
          }),
      }),
      runs: defineRunStore({
        get: (runId) =>
          withOwnerTxn(ownerId, async () => {
            const [row] = await db
              .select()
              .from(runs)
              .where(eq(runs.run_id, runId))
              .limit(1)
            return row ? mapRun(row) : null
          }),
        async createOrResume(input) {
          const existing = await withOwnerTxn(ownerId, async () => {
            const [row] = await db
              .select()
              .from(runs)
              .where(eq(runs.run_id, input.runId))
              .limit(1)
            return row ? mapRun(row) : null
          })
          if (existing) return existing

          await withOwnerTxn(ownerId, async () => {
            await db
              .insert(runs)
              .values({
                run_id: input.runId,
                thread_id: input.threadId,
                status: input.status ?? 'running',
                started_at: input.startedAt,
              })
              .onConflictDoNothing({ target: [runs.owner_id, runs.run_id] })
          })

          return withOwnerTxn(ownerId, async () => {
            const [row] = await db
              .select()
              .from(runs)
              .where(eq(runs.run_id, input.runId))
              .limit(1)
            return row
              ? mapRun(row)
              : {
                  runId: input.runId,
                  threadId: input.threadId,
                  status: input.status ?? 'running',
                  startedAt: input.startedAt,
                }
          })
        },
        update: (runId, patch) =>
          withOwnerTxn(ownerId, async () => {
            const values: Partial<typeof runs.$inferInsert> = {}
            if (patch.status !== undefined) values.status = patch.status
            if (patch.finishedAt !== undefined) {
              values.finished_at = patch.finishedAt
            }
            if (patch.error !== undefined) values.error = patch.error.message
            if (patch.usage !== undefined) values.usage_json = patch.usage
            if (Object.keys(values).length === 0) return
            await db.update(runs).set(values).where(eq(runs.run_id, runId))
          }),
        findActiveRun: (threadId) =>
          withOwnerTxn(ownerId, async () => {
            const [row] = await db
              .select()
              .from(runs)
              .where(
                and(
                  eq(runs.thread_id, threadId),
                  eq(runs.status, 'running'),
                ),
              )
              .orderBy(desc(runs.started_at))
              .limit(1)
            return row ? mapRun(row) : null
          }),
      }),
    },
  })
}
