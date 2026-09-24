import { modelMessagesToUIMessages } from '@tanstack/ai'
import { createServerFn } from '@tanstack/react-start'

import { createOwnerChatPersistence } from './chat-persistence'
import { getDailyThreadId } from './chat-thread'
import { requireVerifiedOwner } from './owner-context'

import type { ModelMessage } from '@tanstack/ai'

/**
 * What the chat page needs before its first paint: who it greets, and the day's
 * transcript so far. Rendering the transcript on the server means a day that
 * already has messages never flashes the empty state while the client hydrates.
 */
export const loadChatPage = createServerFn({ method: 'GET' }).handler(
  async () => {
    const owner = await requireVerifiedOwner()
    const threadId = getDailyThreadId(new Date())
    const stored = await createOwnerChatPersistence(
      owner.id,
    ).stores.messages.loadThread(threadId)
    // JSON text, not objects: message parts carry `unknown` payloads the
    // server-function boundary cannot prove serializable, though they are
    // exactly the JSON the column holds. readTranscript turns it back.
    return { ownerName: owner.name, threadId, transcript: JSON.stringify(stored) }
  },
)

/** The transcript loadChatPage sent, as the UI messages useChat starts from. */
export function readTranscript(transcript: string) {
  // SAFETY: loadChatPage serialized exactly this array of stored model messages.
  const stored = JSON.parse(transcript) as Array<ModelMessage>
  return modelMessagesToUIMessages(stored)
}
