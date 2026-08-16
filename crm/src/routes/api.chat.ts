import { chatParamsFromRequest } from '@tanstack/ai'
import { createFileRoute } from '@tanstack/react-router'

import { replayOrHydrateChat, streamChatTurn } from '#/lib/chat-run'
import { enforceOwnerInferenceCap } from '#/lib/inference-usage'
import { requireVerifiedOwner } from '#/lib/owner-context'

export const Route = createFileRoute('/api/chat')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const owner = await requireVerifiedOwner()
        return replayOrHydrateChat(owner.id, request, new Date())
      },
      POST: async ({ request }) => {
        const owner = await requireVerifiedOwner()
        const params = await chatParamsFromRequest(request)
        const now = new Date()
        await enforceOwnerInferenceCap(owner.id, now)
        return streamChatTurn(owner, params, now)
      },
    },
  },
})
