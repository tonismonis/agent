/**
 * The lifetime of one chat turn, kept out of the route so it can run — and be
 * tested — without an HTTP request. Every entry point here takes an Owner the
 * route has already verified; nothing in this file authenticates.
 */

import {
  EventType,
  RUN_CANCEL_REASON,
  chat,
  chatParamsFromRequest,
  maxIterations,
  memoryStream,
  resolveResumeRunId,
  resumeServerSentEventsResponse,
} from '@tanstack/ai'
import { createCodeMode } from '@tanstack/ai-code-mode'
import { createNodeIsolateDriver } from '@tanstack/ai-isolate-node'
import { openRouterText } from '@tanstack/ai-openrouter'
import { reconstructChat, withPersistence } from '@tanstack/ai-persistence'

import { createOwnerChatPersistence } from '#/lib/chat-persistence.server'
import { createChatTools } from '#/lib/chat-tools.server'
import { getDailyThreadId } from '#/lib/chat-thread'
import {
  CHAT_MODEL,
  CHAT_REASONING,
  OPENROUTER_PROVIDER_OPTIONS,
} from '#/lib/inference-config'
import { buildAppPrompt } from '#/lib/system-prompt'
import { readRefusal } from '#/lib/refusal'
import { runOwnerTool } from '#/lib/tools.server'

import type { ChatMiddleware, StreamChunk, TokenUsage } from '@tanstack/ai'
import type { owners } from '#/db/schema'

type ChatOwner = typeof owners.$inferSelect
type ChatParams = Awaited<ReturnType<typeof chatParamsFromRequest>>
type ChatPersistence = ReturnType<typeof createOwnerChatPersistence>

const isolateDriver = createNodeIsolateDriver()
const THREAD_ROTATION_GRACE_MS = 5 * 60_000
// Five model iterations plus sandbox runs finish well inside this; a run still
// going is stalled upstream and would otherwise hold the Owner's input shut.
const RUN_TIMEOUT_MS = 5 * 60_000
// How long a new turn waits for the previous one's teardown, which is still
// running when a fast client sends right after the final chunk.
const PREVIOUS_RUN_GRACE_MS = 2_000

class InvalidChatParamsError extends Error {}

export async function parseChatParams(request: Request) {
  try {
    return await chatParamsFromRequest(request)
  } catch {
    throw new InvalidChatParamsError()
  }
}

export async function handleChatRequest(
  request: Request,
  handler: () => Response | Promise<Response>,
) {
  if (request.signal.aborted) return new Response(null, { status: 499 })

  try {
    return await handler()
  } catch (error) {
    if (error instanceof Response) throw error
    if (error instanceof InvalidChatParamsError) {
      return Response.json({ error: 'Invalid request body' }, { status: 400 })
    }
    // The body stays generic; the detail belongs in the server log only.
    console.error('chat request failed', error)
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export function isValidClientThreadId(
  clientThreadId: string | null | undefined,
  now: Date,
) {
  if (clientThreadId == null) return true

  return [-THREAD_ROTATION_GRACE_MS, 0, THREAD_ROTATION_GRACE_MS].some(
    (offset) =>
      clientThreadId === getDailyThreadId(new Date(now.getTime() + offset)),
  )
}

function rejectRotatedThread() {
  throw new Response(JSON.stringify({ error: 'thread rotated' }), {
    status: 409,
    headers: { 'content-type': 'application/json' },
  })
}

function validateClientThreadId(
  clientThreadId: string | null | undefined,
  now: Date,
) {
  if (!isValidClientThreadId(clientThreadId, now)) rejectRotatedThread()
}

type LiveRun = {
  runId: string
  controller: AbortController
  done: Promise<void>
}

/**
 * The run each Owner has producing in this process — at most one, so a second
 * tab or a send after Stop cannot interleave two runs' writes to one thread.
 * We deploy one instance, so the delivery log (`memoryStream`, in-process) and
 * this map share a run's lifetime: a run the database still calls 'running'
 * but that is missing here belongs to a process that died, and nothing will
 * ever produce it again.
 */
const liveRuns = new Map<string, LiveRun>()

/**
 * The delivery log a run streams through. Logs live in one process-wide map,
 * so the key carries the Owner: a runId is client-chosen, and a bare one
 * would let any Owner who learned it read another's run.
 */
export function runLogId(ownerId: string, runId: string) {
  return `${ownerId}:${runId}`
}

/** The cursor a reconnecting client resumes from, as `memoryStream` reads it. */
function readResumeOffset(request: Request) {
  return (
    request.headers.get('Last-Event-ID') ??
    new URL(request.url).searchParams.get('offset')
  )
}

function conflict(error: string) {
  return new Response(JSON.stringify({ error }), {
    status: 409,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Sums usage over every model call in a run. withPersistence stores only the
 * last call's, and a code-mode turn makes at least two.
 */
function tallyUsage() {
  let total: TokenUsage | null = null
  const middleware: ChatMiddleware = {
    name: 'usage-tally',
    onUsage(_ctx, usage) {
      total = {
        promptTokens: (total?.promptTokens ?? 0) + usage.promptTokens,
        completionTokens:
          (total?.completionTokens ?? 0) + usage.completionTokens,
        totalTokens: (total?.totalTokens ?? 0) + usage.totalTokens,
        cost: (total?.cost ?? 0) + (usage.cost ?? 0),
      }
    },
  }
  return { middleware, total: () => total }
}

/** One turn as the model driver sees it: who, what, and how it reports back. */
export type Turn = {
  owner: ChatOwner
  params: ChatParams
  now: Date
  /** Persistence and usage accounting the driver must run the model with. */
  middleware: Array<ChatMiddleware>
  abortController: AbortController
}

/** Produces a turn's chunks. The route runs the real model; tests stand in. */
export type TurnDriver = (turn: Turn) => AsyncIterable<StreamChunk>

type CodeModeTool = ReturnType<typeof createCodeMode>['tool']

/**
 * An execution that ended on an uncaught refusal reports `{name: 'Refusal',
 * message}` and no stack: the stack only repeats the message and the sandbox
 * frames, and the model reads every character. Other failures, the model's own
 * TypeError included, pass through untouched.
 */
export function withRefusalOutput(tool: CodeModeTool): CodeModeTool {
  const execute = tool.execute
  if (!execute) return tool
  return {
    ...tool,
    execute: async (input, context) => {
      const output = await execute(input, context)
      const message = output.error?.message
      if (output.success || !message || !readRefusal(message)) return output
      return { ...output, error: { name: 'Refusal', message } }
    },
  }
}

/** The production driver: the Owner's CRM tools in code mode, on the model. */
export const modelTurn: TurnDriver = ({
  owner,
  params,
  now,
  middleware,
  abortController,
}) => {
  const ownerTools = createChatTools((operation) =>
    runOwnerTool(owner.id, operation),
  )
  const { tool, systemPrompt } = createCodeMode({
    driver: isolateDriver,
    tools: ownerTools,
  })
  return chat({
    // SAFETY: gpt-6-luna is a valid OpenRouter model id not yet in the SDK's union.
    adapter: openRouterText(
      CHAT_MODEL as Parameters<typeof openRouterText>[0],
    ),
    systemPrompts: [
      buildAppPrompt({
        now,
        ownerName: owner.name,
        profession: owner.profession,
        restrictedNotes: owner.restricted_notes,
      }),
      systemPrompt,
    ],
    tools: [withRefusalOutput(tool)],
    agentLoopStrategy: maxIterations(5),
    messages: params.messages,
    threadId: getDailyThreadId(now),
    runId: params.runId,
    modelOptions: {
      provider: OPENROUTER_PROVIDER_OPTIONS,
      reasoning: CHAT_REASONING,
      user: owner.id,
    },
    middleware,
    abortController,
  })
}

/**
 * Start the model run detached from the HTTP request, producing into the
 * delivery log. A reload mid-answer cancels only the reader, so the reply still
 * finishes, still persists, and the reloaded page picks it up — by rejoining
 * the log, or from the stored transcript once the run is done. Only Stop
 * (`cancelChatRun`) or the timeout ends it early.
 */
function startDetachedRun(
  turn: Omit<Turn, 'middleware' | 'abortController'>,
  live: LiveRun,
  finish: () => void,
  driver: TurnDriver,
) {
  const { owner, params } = turn
  const sink = memoryStream({ runId: runLogId(owner.id, params.runId) })
  const persistence = createOwnerChatPersistence(owner.id)
  const usage = tallyUsage()
  const timeout = setTimeout(
    () => live.controller.abort('Run timed out'),
    RUN_TIMEOUT_MS,
  )

  void (async () => {
    try {
      const stream = driver({
        ...turn,
        middleware: [
          withPersistence(persistence, { snapshotStreaming: true }),
          usage.middleware,
        ],
        // Never the request's signal: that would abort the run on the very
        // disconnect this path exists to survive.
        abortController: live.controller,
      })

      for await (const chunk of stream) await sink.append([chunk])
      if (live.controller.signal.aborted) {
        const reason: unknown = live.controller.signal.reason
        const message =
          reason === RUN_CANCEL_REASON ? 'Run stopped' : String(reason)
        await sink.append([runError(message)])
      }
    } catch (error) {
      // The run died before emitting a terminal chunk; withPersistence already
      // recorded the failure, so this only unblocks whoever reads the log. The
      // detail stays in the server log: it can carry SQL and parameters.
      console.error('chat run failed', error)
      await sink.append([runError('The run failed')])
    } finally {
      clearTimeout(timeout)
      try {
        const total = usage.total()
        if (total) {
          await persistence.stores.runs.update(params.runId, { usage: total })
        }
      } catch (error) {
        console.error('chat run usage not recorded', error)
      }
      await sink.close()
      if (liveRuns.get(owner.id) === live) liveRuns.delete(owner.id)
      finish()
    }
  })()
}

function runError(message: string) {
  // SAFETY: a RUN_ERROR chunk carries exactly these fields.
  return {
    type: EventType.RUN_ERROR,
    message,
    timestamp: Date.now(),
  } as StreamChunk
}

/**
 * Claim the Owner's single run slot for `runId`, waiting briefly for a
 * previous run that is already tearing down.
 */
async function claimRunSlot(ownerId: string, runId: string) {
  const previous = liveRuns.get(ownerId)
  if (previous && previous.runId !== runId) {
    await Promise.race([
      previous.done,
      new Promise((resolve) => setTimeout(resolve, PREVIOUS_RUN_GRACE_MS)),
    ])
  }
  const current = liveRuns.get(ownerId)
  if (current) {
    if (current.runId === runId) return null
    throw conflict('another run is in progress')
  }
  let finish = () => {}
  const live: LiveRun = {
    runId,
    controller: new AbortController(),
    done: new Promise<void>((resolve) => {
      finish = resolve
    }),
  }
  liveRuns.set(ownerId, live)
  return { live, finish }
}

/**
 * Start the turn, then stream it to this client by tailing its log. A request
 * carrying a resume cursor is the client reconnecting to a turn it already
 * started, so it only reads; a runId the Owner has used before never runs
 * again, since its tools already wrote.
 */
export async function streamChatTurn(
  owner: ChatOwner,
  params: ChatParams,
  request: Request,
  now: Date,
  driver: TurnDriver = modelTurn,
) {
  validateClientThreadId(params.threadId, now)
  const offset = readResumeOffset(request)

  if (offset === null) {
    const claim = await claimRunSlot(owner.id, params.runId)
    if (claim) {
      try {
        const existing = await createOwnerChatPersistence(
          owner.id,
        ).stores.runs.get(params.runId)
        if (existing) throw conflict('run already exists')
      } catch (error) {
        liveRuns.delete(owner.id)
        claim.finish()
        throw error
      }
      startDetachedRun(
        { owner, params, now },
        claim.live,
        claim.finish,
        driver,
      )
    }
  }

  // This reader races the producer it just started, so it waits far longer for
  // a first chunk than a rejoin does, where an empty log means the run is gone.
  const reader = memoryStream(
    { runId: runLogId(owner.id, params.runId), offset: offset ?? '-1' },
    { firstChunkDeadlineMs: 10_000 },
  )
  return resumeServerSentEventsResponse({ adapter: reader })
}

/** Stop: end the Owner's live run for good, not just this client's reading. */
export function cancelChatRun(ownerId: string) {
  liveRuns.get(ownerId)?.controller.abort(RUN_CANCEL_REASON)
  return new Response(null, { status: 204 })
}

/**
 * A run left 'running' by a crashed process would make every later hydration
 * hand the client a cursor to a stream nobody is producing, freezing the daily
 * thread's input for the rest of the day.
 */
async function abandonCrashedRun(
  ownerId: string,
  persistence: ChatPersistence,
  threadId: string,
) {
  const active = await persistence.stores.runs.findActiveRun(threadId)
  if (!active || liveRuns.get(ownerId)?.runId === active.runId) return
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
  now: Date,
) {
  const requestedThreadId = new URL(request.url).searchParams.get('threadId')
  validateClientThreadId(requestedThreadId, now)

  const threadId = getDailyThreadId(now)
  const persistence = createOwnerChatPersistence(ownerId)
  const offset = readResumeOffset(request)

  if (offset !== null) {
    const runId = resolveResumeRunId(request)
    const run = runId ? await persistence.stores.runs.get(runId) : null
    if (!runId || run?.threadId !== threadId) {
      throw new Response('Forbidden', { status: 403 })
    }
    // Built from the checked runId, never from the cursor: a cursor naming any
    // other log fails to read instead of replaying it.
    const durability = memoryStream({
      runId: runLogId(ownerId, runId),
      offset,
    })
    return resumeServerSentEventsResponse({ adapter: durability })
  }

  await abandonCrashedRun(ownerId, persistence, threadId)
  return reconstructChat(persistence, request, {
    authorize: (requestedThreadId) =>
      Promise.resolve(requestedThreadId === threadId),
  })
}
