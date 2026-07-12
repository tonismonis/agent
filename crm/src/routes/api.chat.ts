import {
  chat,
  maxIterations,
  toServerSentEventsResponse,
} from '@tanstack/ai'
import { createCodeMode } from '@tanstack/ai-code-mode'
import { createNodeIsolateDriver } from '@tanstack/ai-isolate-node'
import { openRouterText } from '@tanstack/ai-openrouter'
import { createFileRoute } from '@tanstack/react-router'

import { chatTools } from '#/lib/chat-tools'
import { APP_PROMPT } from '#/lib/system-prompt'

export const Route = createFileRoute('/api/chat')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { messages } = await request.json()
        const abortController = new AbortController()
        const { tool, systemPrompt } = createCodeMode({
          driver: createNodeIsolateDriver(),
          tools: chatTools,
        })

        const model = (process.env.CHAT_MODEL ??
          'anthropic/claude-haiku-4-5') as Parameters<typeof openRouterText>[0]
        const stream = chat({
          adapter: openRouterText(model),
          systemPrompts: [APP_PROMPT, systemPrompt],
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
