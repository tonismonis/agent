import { createFileRoute } from '@tanstack/react-router'

import {
  handleChatRequest,
  parseChatParams,
  replayOrHydrateChat,
  streamChatTurn,
} from '#/lib/chat-run'
import { enforceOwnerInferenceCap } from '#/lib/inference-usage'
import { requireVerifiedOwner } from '#/lib/owner-context'

export const Route = createFileRoute('/api/chat')({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleChatRequest(request, async () => {
          const owner = await requireVerifiedOwner()
          return replayOrHydrateChat(owner.id, request, new Date())
        }),
      POST: ({ request }) =>
        handleChatRequest(request, async () => {
          const owner = await requireVerifiedOwner()
          const params = await parseChatParams(request)
          const now = new Date()
          await enforceOwnerInferenceCap(owner.id, now)
          return streamChatTurn(owner, params, now)
        }),
    },
  },
})
