import {
  chat,
  chatParamsFromRequest,
  maxIterations,
  toServerSentEventsResponse,
} from '@tanstack/ai'
import { createCodeMode } from '@tanstack/ai-code-mode'
import { createNodeIsolateDriver } from '@tanstack/ai-isolate-node'
import { openRouterText } from '@tanstack/ai-openrouter'
import { reconstructChat, withPersistence } from '@tanstack/ai-persistence'
import { createFileRoute } from '@tanstack/react-router'

import { createOwnerChatPersistence } from '#/lib/chat-persistence'
import { createChatTools } from '#/lib/chat-tools'
import { getDailyThreadId } from '#/lib/chat-thread'
import {
  CHAT_MODEL,
  OPENROUTER_PROVIDER_OPTIONS,
} from '#/lib/inference-config'
import { enforceOwnerInferenceCap } from '#/lib/inference-usage'
import { requireVerifiedOwner, withOwnerTxn } from '#/lib/owner-context'
import { buildAppPrompt } from '#/lib/system-prompt'

export const Route = createFileRoute('/api/chat')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const owner = await requireVerifiedOwner()
        const threadId = getDailyThreadId()
        return reconstructChat(createOwnerChatPersistence(owner.id), request, {
          authorize: (requestedThreadId) =>
            Promise.resolve(requestedThreadId === threadId),
        })
      },
      POST: async ({ request }) => {
        const owner = await requireVerifiedOwner()
        const params = await chatParamsFromRequest(request)
        const now = new Date()
        const threadId = getDailyThreadId(now)
        await enforceOwnerInferenceCap(owner.id, now)
        const abortController = new AbortController()
        const ownerTools = createChatTools((operation) =>
          withOwnerTxn(owner.id, () => operation()),
        )
        const { tool, systemPrompt } = createCodeMode({
          driver: createNodeIsolateDriver(),
          tools: ownerTools,
        })

        const persistence = createOwnerChatPersistence(owner.id)
        const stream = chat({
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
          threadId,
          runId: params.runId,
          modelOptions: {
            provider: OPENROUTER_PROVIDER_OPTIONS,
            user: owner.id,
          },
          middleware: [
            withPersistence(persistence, { snapshotStreaming: false }),
          ],
          abortController,
        })

        return toServerSentEventsResponse(stream, { abortController })
      },
    },
  },
})
