/**
 * The lifetime of one chat turn, kept out of the route so it can run — and be
 * tested — without an HTTP request. Every entry point here takes an Owner the
 * route has already verified; nothing in this file authenticates.
 */

import {
  EventType,
  chat,
  maxIterations,
  memoryStream,
  resolveResumeRunId,
  resumeServerSentEventsResponse,
} from '@tanstack/ai'
import { createCodeMode } from '@tanstack/ai-code-mode'
import { createNodeIsolateDriver } from '@tanstack/ai-isolate-node'
import { openRouterText } from '@tanstack/ai-openrouter'
import { reconstructChat, withPersistence } from '@tanstack/ai-persistence'

import { createOwnerChatPersistence } from '#/lib/chat-persistence'
import { createChatTools } from '#/lib/chat-tools'
import { getDailyThreadId } from '#/lib/chat-thread'
import {
  CHAT_MODEL,
  OPENROUTER_PROVIDER_OPTIONS,
} from '#/lib/inference-config'
import { withOwnerTxn } from '#/lib/owner-context'
import { buildAppPrompt } from '#/lib/system-prompt'

import type { StreamChunk, chatParamsFromRequest } from '@tanstack/ai'
import type { owners } from '#/db/schema'

type ChatOwner = typeof owners.$inferSelect
type ChatParams = Awaited<ReturnType<typeof chatParamsFromRequest>>
type ChatPersistence = ReturnType<typeof createOwnerChatPersistence>

/**
 * Runs whose producer is alive in this process. We deploy one instance, so the
 * delivery log (`memoryStream`, in-process) and this set share a run's
 * lifetime: a run the database still calls 'running' but that is missing here
 * belongs to a process that died, and nothing will ever produce it again.
 */
const liveRuns = new Set<string>()

/**
 * Start the model run detached from the HTTP request, producing into the
 * delivery log. A reload mid-answer cancels only the reader, so the reply still
 * finishes, still persists, and the reloaded page picks it up — by rejoining
 * the log, or from the stored transcript once the run is done.
 */
function startDetachedRun(owner: ChatOwner, params: ChatParams, now: Date) {
  if (liveRuns.has(params.runId)) return
  liveRuns.add(params.runId)

  const sink = memoryStream({ runId: params.runId })

  void (async () => {
    try {
      const ownerTools = createChatTools((operation) =>
        withOwnerTxn(owner.id, () => operation()),
      )
      const { tool, systemPrompt } = createCodeMode({
        driver: createNodeIsolateDriver(),
        tools: ownerTools,
      })
      const stream = chat({
        // SAFETY: gpt-5.6-luna is a valid OpenRouter model id not yet in the SDK's union.
        adapter: openRouterText(
          CHAT_MODEL as Parameters<typeof openRouterText>[0],
        ),
        systemPrompts: [
          buildAppPrompt({
            now,
            profession: owner.profession,
            restrictedNotes: owner.restricted_notes,
          }),
          systemPrompt,
        ],
        tools: [tool],
        agentLoopStrategy: maxIterations(5),
        messages: params.messages,
        threadId: getDailyThreadId(now),
        runId: params.runId,
        modelOptions: {
          provider: OPENROUTER_PROVIDER_OPTIONS,
          user: owner.id,
        },
        middleware: [
          withPersistence(createOwnerChatPersistence(owner.id), {
            snapshotStreaming: true,
          }),
        ],
        // No abortController: mirroring the request's signal into the run would
        // abort it on the very disconnect this path exists to survive.
      })

      for await (const chunk of stream) await sink.append([chunk])
    } catch (error) {
      // The run died before emitting a terminal chunk; withPersistence already
      // recorded the failure, so this only unblocks whoever reads the log.
      // SAFETY: a RUN_ERROR chunk carries exactly these fields.
      await sink.append([
        {
          type: EventType.RUN_ERROR,
          message: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        } as StreamChunk,
      ])
    } finally {
      await sink.close()
      liveRuns.delete(params.runId)
    }
  })()
}

/** Start the turn, then stream it to this client by tailing its log. */
export function streamChatTurn(
  owner: ChatOwner,
  params: ChatParams,
  now: Date,
) {
  startDetachedRun(owner, params, now)
  // This reader races the producer it just started, so it waits far longer for
  // a first chunk than a rejoin does, where an empty log means the run is gone.
  const reader = memoryStream(
    { runId: params.runId, offset: '-1' },
    { firstChunkDeadlineMs: 10_000 },
  )
  return resumeServerSentEventsResponse({ adapter: reader })
}

/**
 * A run left 'running' by a crashed process would make every later hydration
 * hand the client a cursor to a stream nobody is producing, freezing the daily
 * thread's input for the rest of the day.
 */
async function abandonCrashedRun(
  persistence: ChatPersistence,
  threadId: string,
) {
  const active = await persistence.stores.runs.findActiveRun(threadId)
  if (!active || liveRuns.has(active.runId)) return
  await persistence.stores.runs.update(active.runId, {
    status: 'aborted',
    finishedAt: Date.now(),
    error: { message: 'Run ended with the server process that owned it' },
  })
}

/**
 * The two jobs one GET serves: replay an in-flight run's delivery log for a
 * client rejoining it, or return the stored transcript. Both answer only for
 * the Owner's own thread.
 */
export async function replayOrHydrateChat(
  ownerId: string,
  request: Request,
  threadId: string,
) {
  const persistence = createOwnerChatPersistence(ownerId)
  const durability = memoryStream(request)

  if (durability.resumeFrom() !== null) {
    const runId = resolveResumeRunId(request)
    const run = runId ? await persistence.stores.runs.get(runId) : null
    if (run?.threadId !== threadId) {
      throw new Response('Forbidden', { status: 403 })
    }
    return resumeServerSentEventsResponse({ adapter: durability })
  }

  await abandonCrashedRun(persistence, threadId)
  return reconstructChat(persistence, request, {
    authorize: (requestedThreadId) =>
      Promise.resolve(requestedThreadId === threadId),
  })
}
