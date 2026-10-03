import { parsePartialJSON } from '@tanstack/ai'

import { isJsonObject, isJsonString, type JsonValue } from '#/lib/json'
import {
  inferWriteCallsFromCode,
  summarizeWrites,
  type WorkCall,
  type WriteSummary,
} from '#/lib/write-receipts'
import type { QueuedMessage, UIMessage } from '@tanstack/ai-react'

type ToolCallPart = Extract<UIMessage['parts'][number], { type: 'tool-call' }>

export type Turn =
  | { kind: 'user'; id: string; text: string }
  | {
      kind: 'assistant'
      id: string
      text: string
      /** Shown only while this turn streams, or while it has no text yet. */
      thinking: string | null
      /** The caret sits on this turn. */
      streaming: boolean
      /** Live calls, else calls inferred from the code, else none after a failed run. */
      summary: WriteSummary
      /** Live calls only, and [] when work is hidden. */
      work: Array<WorkCall>
    }

/** The code a call ran: its parsed input once complete, partial JSON while streaming. */
function getTypeScript(part: ToolCallPart) {
  // SAFETY: a tool input is the JSON the model called the tool with.
  const input = (part.input ?? parsePartialJSON(part.arguments)) as JsonValue
  const code = isJsonObject(input) ? input.typescriptCode : undefined
  return isJsonString(code) ? code : part.arguments
}

/** execute_typescript reported failure, so the code's writes are unknown. */
function executionFailed(part: ToolCallPart) {
  // SAFETY: the tool's output is the JSON its server handler returned.
  const output = part.output as JsonValue | undefined
  return isJsonObject(output) && output.success === false
}

export function queuedText(queued: QueuedMessage) {
  // SAFETY: this page only ever sends plain text.
  return queued.content as string
}

function textOf(message: UIMessage) {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.content)
    .join('')
}

function thinkingOf(message: UIMessage) {
  return message.parts
    .filter((part) => part.type === 'thinking')
    .map((part) => part.content)
    .join('')
}

function toolCallPartsOf(message: UIMessage) {
  return message.parts.filter(
    (part): part is ToolCallPart => part.type === 'tool-call',
  )
}

/**
 * The calls one turn made. Live calls arrive as code-mode events; a turn
 * replayed from persistence has none, so the code it ran is read back instead.
 */
function callsForMessage(
  message: UIMessage,
  callsByToolCall: Map<string, Array<WorkCall>>,
): Array<WorkCall> {
  return toolCallPartsOf(message).flatMap((part) => {
    const live = callsByToolCall.get(part.id)
    if (live && live.length > 0) return live
    // Each tool call commits on its own, so a failed run may have written some
    // of its calls; with no per-call record left, claim none rather than all.
    if (executionFailed(part)) return []
    return inferWriteCallsFromCode(getTypeScript(part), part.id)
  })
}

/** The live calls one turn made, as code-mode events reported them. */
function liveCallsOf(
  message: UIMessage,
  callsByToolCall: Map<string, Array<WorkCall>>,
) {
  return toolCallPartsOf(message).flatMap(
    (part) => callsByToolCall.get(part.id) ?? [],
  )
}

/**
 * The conversation as the screen draws it. A turn with nothing to show is
 * dropped; `waiting` is a reply that has not started yet.
 */
export function selectTurns(
  messages: Array<UIMessage>,
  callsByToolCall: Map<string, Array<WorkCall>>,
  isLoading: boolean,
  showWork: boolean,
) {
  const lastAssistantId = messages.findLast(
    (message) => message.role === 'assistant',
  )?.id
  const streamingOnLastAssistant =
    isLoading && messages.at(-1)?.role === 'assistant'

  const turns = messages.flatMap((message): Array<Turn> => {
    const text = textOf(message)
    const thinkingText = thinkingOf(message)
    const summary =
      message.role === 'assistant'
        ? summarizeWrites(callsForMessage(message, callsByToolCall))
        : ({ kind: 'none' } satisfies WriteSummary)
    const streaming =
      streamingOnLastAssistant && message.id === lastAssistantId
    const thinking =
      thinkingText && (streaming || !text) ? thinkingText : null
    const work = showWork ? liveCallsOf(message, callsByToolCall) : []

    if (
      !text &&
      summary.kind === 'none' &&
      !streaming &&
      thinking === null &&
      work.length === 0
    )
      return []

    if (message.role === 'user') return [{ kind: 'user', id: message.id, text }]
    return [
      {
        kind: 'assistant',
        id: message.id,
        text,
        thinking,
        streaming,
        summary,
        work,
      },
    ]
  })

  return { turns, waiting: isLoading && !streamingOnLastAssistant }
}
