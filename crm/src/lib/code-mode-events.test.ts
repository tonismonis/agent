import { expect, test } from 'vitest'

import { readCodeModeEvent } from './code-mode-events'
import { refuse } from './refusal'

test('a refused call reads as the sentence it carries, marked refused', () => {
  const refusal = refuse.askDuration('Piano')

  expect(
    readCodeModeEvent('code_mode:external_error', {
      function: 'external_createAppointment',
      error: refusal.message,
      duration: 4,
    }),
  ).toEqual({
    kind: 'error',
    name: 'createAppointment',
    durationMs: 4,
    message: '¿Cuánto dura cada sesión de Piano?',
    refused: true,
  })
  expect(
    readCodeModeEvent('code_mode:execution_finished', {
      success: false,
      error: { name: 'Refusal', message: refusal.message },
    }),
  ).toEqual(expect.objectContaining({ kind: 'failed', refused: true }))
})

test('any other failure keeps its own text', () => {
  expect(
    readCodeModeEvent('code_mode:execution_finished', {
      success: false,
      error: { name: 'TypeError', message: 'client is null' },
    }),
  ).toEqual({ kind: 'failed', message: 'client is null', refused: false, durationMs: undefined })
})
