import type { JsonValue } from '#/lib/json'
import { groupFacts, parseReceipt, type ReceiptFact } from '#/lib/receipt-facts'
import type { WorkCall } from '#/lib/write-receipts'
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
      /** What the turn's executions saved, read from their persisted outputs. */
      receipt: Array<ReceiptFact>
      /** Live calls only, and [] when work is hidden. */
      work: Array<WorkCall>
    }

export function queuedText(queued: QueuedMessage) {
  // SAFETY: this page only ever sends plain text.
  return queued.content as string
}

function readMessageText(message: UIMessage) {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.content)
    .join('')
}

function readMessageThinking(message: UIMessage) {
  return message.parts
    .filter((part) => part.type === 'thinking')
    .map((part) => part.content)
    .join('')
}

function findToolCallParts(message: UIMessage) {
  return message.parts.filter(
    (part): part is ToolCallPart => part.type === 'tool-call',
  )
}

/**
 * What one turn saved: the receipts of its execute_typescript runs, grouped
 * across runs. A run with no output yet has none.
 */
function readMessageReceipt(message: UIMessage) {
  return groupFacts(
    findToolCallParts(message)
      .filter((part) => part.name === 'execute_typescript')
      .flatMap((part) => {
        // SAFETY: the tool's output is the JSON its server handler returned.
        const output = part.output as JsonValue | undefined
        return parseReceipt(output)
      }),
  )
}

/** The live calls one turn made, as code-mode events reported them. */
function findLiveCalls(
  message: UIMessage,
  callsByToolCall: Map<string, Array<WorkCall>>,
) {
  return findToolCallParts(message).flatMap(
    (part) => callsByToolCall.get(part.id) ?? [],
  )
}

/**
 * A saved turn comes back as one assistant message per model step, while the
 * live turn is one message. Folding each run of assistant messages into the
 * last one makes a reloaded turn read like the live one.
 */
function foldAssistantSteps(messages: Array<UIMessage>) {
  return messages.reduce<Array<UIMessage>>((folded, message) => {
    const previous = folded.at(-1)
    if (previous?.role === 'assistant' && message.role === 'assistant')
      folded[folded.length - 1] = {
        ...message,
        parts: [...previous.parts, ...message.parts],
      }
    else folded.push(message)
    return folded
  }, [])
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

  const turns = foldAssistantSteps(messages).flatMap((message): Array<Turn> => {
    const text = readMessageText(message)
    const thinkingText = readMessageThinking(message)
    const receipt = message.role === 'assistant' ? readMessageReceipt(message) : []
    const streaming =
      streamingOnLastAssistant && message.id === lastAssistantId
    const thinking =
      thinkingText && (streaming || !text) ? thinkingText : null
    const work = showWork ? findLiveCalls(message, callsByToolCall) : []

    if (
      !text &&
      receipt.length === 0 &&
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
        receipt,
        work,
      },
    ]
  })

  return { turns, waiting: isLoading && !streamingOnLastAssistant }
}
