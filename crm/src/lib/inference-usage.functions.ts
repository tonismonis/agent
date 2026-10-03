import { createServerFn } from '@tanstack/react-start'

import { requireVerifiedOwner } from './owner-context.server'
import { getOwnerInferenceUsage } from './inference-usage.server'

export const getMyInferenceUsage = createServerFn({ method: 'GET' }).handler(
  async () => {
    const owner = await requireVerifiedOwner()
    return getOwnerInferenceUsage(owner.id)
  },
)
