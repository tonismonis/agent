import { createServerFn } from '@tanstack/react-start'

import { requireVerifiedOwner } from './owner-context'
import { getOwnerInferenceUsage } from './inference-usage'

export const getMyInferenceUsage = createServerFn({ method: 'GET' }).handler(
  async () => {
    const owner = await requireVerifiedOwner()
    return getOwnerInferenceUsage(owner.id)
  },
)
