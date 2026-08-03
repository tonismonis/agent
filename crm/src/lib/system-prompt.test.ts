import { expect, test } from 'vitest'

import { buildAppPrompt } from './system-prompt'

test('prompt injects Santiago now, profession, and operating rules', () => {
  const prompt = buildAppPrompt({
    now: new Date('2026-08-03T14:05:06.000Z'),
    profession: 'Consultant',
    restrictedNotes: false,
  })

  expect(prompt).toContain('Owner profession: Consultant')
  expect(prompt).toContain('2026-08-03, 10:05:06 GMT-4')
  expect(prompt).toContain('Clarify first')
  expect(prompt).toContain('listAuditLog')
  expect(prompt).toContain('restore_*')
  expect(prompt).toContain('Only suggest appointment times returned by find_free_slots')
  expect(prompt).toContain('Never store health information or personal context')
  expect(prompt).toContain('payments.notes may contain only payment method or payment reference')
  expect(prompt).not.toContain('Notes are disabled for this Owner')
})

test('restricted Owner prompt adds notes-disabled rule', () => {
  const prompt = buildAppPrompt({
    profession: 'Psychologist',
    restrictedNotes: true,
  })

  expect(prompt).toContain(
    'Notes are disabled for this Owner: never read or write any notes field.',
  )
})
