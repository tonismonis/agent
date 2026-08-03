import {
  chat,
  maxIterations,
  toServerSentEventsResponse,
} from '@tanstack/ai'
import { createCodeMode } from '@tanstack/ai-code-mode'
import { createNodeIsolateDriver } from '@tanstack/ai-isolate-node'
import { openRouterText } from '@tanstack/ai-openrouter'
import { createFileRoute } from '@tanstack/react-router'

import { createChatTools } from '#/lib/chat-tools'
import { requireVerifiedOwner, withOwnerTxn } from '#/lib/owner-context'
import { buildAppPrompt } from '#/lib/system-prompt'

export const Route = createFileRoute('/api/chat')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const owner = await requireVerifiedOwner()
        const { messages } = await request.json()
        const abortController = new AbortController()
        const ownerTools = createChatTools((operation) =>
          withOwnerTxn(owner.id, () => operation()),
        )
        const { tool, systemPrompt } = createCodeMode({
          driver: createNodeIsolateDriver(),
          tools: ownerTools,
        })

        const model = (process.env.CHAT_MODEL ??
          'anthropic/claude-haiku-4-5') as Parameters<typeof openRouterText>[0]
        const stream = chat({
          adapter: openRouterText(model),
          systemPrompts: [
            buildAppPrompt({
              now: new Date(),
              profession: owner.profession,
              restrictedNotes: owner.restricted_notes,
            }),
            systemPrompt,
          ],
          tools: [tool],
          agentLoopStrategy: maxIterations(5),
          messages,
          abortController,
        })

        return toServerSentEventsResponse(stream, { abortController })
      },
    },
  },
})
