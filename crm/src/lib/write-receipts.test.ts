import { describe, expect, it } from 'vitest'

import { crmToolName, isWriteTool } from '#/lib/write-receipts'

describe('isWriteTool', () => {
  it('separates writes from reads', () => {
    expect(isWriteTool('updateClient')).toBe(true)
    expect(isWriteTool('softDeleteAppointment')).toBe(true)
    expect(isWriteTool('findClients')).toBe(false)
    expect(isWriteTool('listAuditLog')).toBe(false)
  })
})

describe('code-mode binding names', () => {
  it('treats a live external_ write as a write', () => {
    expect(isWriteTool(crmToolName('external_createClient'))).toBe(true)
  })
})
