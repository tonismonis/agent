import { expect, test } from 'vitest'

import { buildAppPrompt } from './system-prompt'

test('prompt injects Owner name, profession, Santiago now, and operating rules', () => {
  const prompt = buildAppPrompt({
    now: new Date('2026-08-03T14:05:06.000Z'),
    ownerName: 'Tomás Maqui',
    profession: 'Consultant',
    restrictedNotes: false,
  })

  expect(prompt).toContain('- Name: Tomás Maqui.')
  expect(prompt).toContain('Profession, as they entered it: Consultant.')
  expect(prompt).toContain('2026-08-03, 10:05:06 GMT-4')
  expect(prompt).toContain('Ask before writing whenever')
  expect(prompt).toContain('external_listAuditLog')
  expect(prompt).toContain('external_restore*')
  expect(prompt).toContain('The Owner decides every time.')
  expect(prompt).toContain('Never propose, suggest or choose a time')
  expect(prompt).toContain('Never pick the bounds yourself.')
  expect(prompt).toContain('Only scheduled appointments take up time.')
  expect(prompt).toContain("Write times as the Owner's clock time in ISO 8601 without an offset")
  expect(prompt).not.toContain('with the America/Santiago offset')
  expect(prompt).not.toMatch(/free_slots|weekly/i)
  expect(prompt).toContain('Never store health information or personal context')
  expect(prompt).toContain('payments.notes holds only the payment method or a reference')
  expect(prompt).not.toContain('Notes are turned off for this Owner')
  expect(prompt).toContain('"say" means the Owner has to decide or answer.')
  expect(prompt).toContain('"fix" means the mistake is yours.')
  expect(prompt).toContain('Never mention functions, fields, JSON, ids or errors to the Owner.')
  expect(prompt).not.toContain('When a booking fails because of an overlap')
  expect(prompt).toContain('book it with one external_createAppointmentSeries call')
  expect(prompt).toContain('create the new series first, then end')
  expect(prompt).toContain('external_restoreAppointmentSeries')
})

test('restricted Owner prompt adds notes-off rule', () => {
  const prompt = buildAppPrompt({
    ownerName: 'Ana',
    profession: 'Psychologist',
    restrictedNotes: true,
  })

  expect(prompt).toContain(
    'a reference.\n- Notes are turned off for this Owner: never read or write any notes field.',
  )
})
