import { describe, expect, it } from 'vitest'

import type { WorkCall } from '#/lib/write-receipts'
import { describeWork, foldCalls, formatArgs } from '#/routes/-chat/work-log'

function call(key: string, name: string, extra: Partial<WorkCall> = {}): WorkCall {
  return { key, toolCallId: 'call_1', name, ...extra }
}

describe('foldCalls', () => {
  it('folds back-to-back calls to one tool into a run', () => {
    const runs = foldCalls([
      call('a', 'findClients'),
      call('b', 'createAppointment'),
      call('c', 'createAppointment'),
      call('d', 'findClients'),
    ])
    expect(runs.map((run) => [run.key, run.name, run.calls.length])).toEqual([
      ['a', 'findClients', 1],
      ['b', 'createAppointment', 2],
      ['d', 'findClients', 1],
    ])
  })
})

describe('describeWork', () => {
  it('counts one call without a time', () => {
    expect(describeWork([call('a', 'findClients')])).toBe('1 llamada')
  })

  it('sums the time and splits refusals from errors', () => {
    expect(
      describeWork([
        call('a', 'findClients', { durationMs: 14 }),
        call('b', 'updateClient', { durationMs: 31, error: 'no', refused: true }),
        call('c', 'updateClient', { durationMs: 20, error: 'boom' }),
      ]),
    ).toBe('3 llamadas · 65 ms · 1 rechazada · 1 error')
  })

  it('pluralizes refusals and errors', () => {
    expect(
      describeWork([
        call('a', 'x', { error: 'no', refused: true }),
        call('b', 'x', { error: 'no', refused: true }),
        call('c', 'x', { error: 'boom' }),
        call('d', 'x', { error: 'boom' }),
      ]),
    ).toBe('4 llamadas · 2 rechazadas · 2 errores')
  })
})

describe('formatArgs', () => {
  it('is empty without inputs', () => {
    expect(formatArgs(undefined)).toBe('')
    expect(formatArgs(null)).toBe('')
    expect(formatArgs({})).toBe('')
  })

  it('sets the inputs on one line', () => {
    expect(formatArgs({ client_id: 8, limit: 10, query: 'Rosa' })).toBe(
      'client_id=8 · limit=10 · query=Rosa',
    )
  })

  it('flattens nested values and truncates long ones', () => {
    expect(formatArgs({ weekly: [{ day: 'tuesday' }] })).toBe(
      'weekly=[ { "day": "tuesday" } ]',
    )
    expect(formatArgs({ note: 'a'.repeat(40) })).toBe(`note=${'a'.repeat(28)}…`)
  })

  it('shows a non-object input as it is', () => {
    expect(formatArgs('hola')).toBe('hola')
    expect(formatArgs(7)).toBe('7')
  })
})
