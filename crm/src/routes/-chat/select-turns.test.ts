import { describe, expect, it } from 'vitest'

import {
  inferWriteCallsFromCode,
  summarizeWrites,
  type WorkCall,
} from '#/lib/write-receipts'
import { selectTurns } from '#/routes/-chat/select-turns'
import type { UIMessage } from '@tanstack/ai-react'

const bookingCode =
  'await external_createAppointment({ client_id: 12, starts_at: "2026-09-30T13:00:00Z" })'

function user(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', content: text }] }
}

function assistant(
  id: string,
  text: string,
  extra: Array<UIMessage['parts'][number]> = [],
): UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [...extra, ...(text ? [{ type: 'text' as const, content: text }] : [])],
  }
}

function thinking(content: string): UIMessage['parts'][number] {
  return { type: 'thinking', content }
}

function codeCall(
  id: string,
  code: string,
  success = true,
): UIMessage['parts'][number] {
  return {
    type: 'tool-call',
    id,
    name: 'execute_typescript',
    arguments: JSON.stringify({ typescriptCode: code }),
    input: { typescriptCode: code },
    state: 'input-complete',
    output: success
      ? { success: true, result: null, logs: [] }
      : { success: false, error: 'boom', logs: [] },
  }
}

const phoneUpdate: WorkCall = {
  key: 'call_1:0',
  toolCallId: 'call_1',
  name: 'updateClient',
  args: { id: 12, phone: '+56 9 4412 8890' },
  result: { id: 12, name: 'Rosa Valdés', phone: '+56 9 4412 8890' },
  durationMs: 31,
}

const lookup: WorkCall = {
  key: 'call_1:1',
  toolCallId: 'call_1',
  name: 'findClients',
  args: { query: 'Rosa' },
  result: [],
  durationMs: 14,
}

const noCalls = new Map<string, Array<WorkCall>>()

describe('selectTurns', () => {
  it('drops turns with nothing to show', () => {
    const { turns } = selectTurns(
      [user('u1', ''), assistant('a1', ''), user('u2', 'hola')],
      noCalls,
      false,
      true,
    )
    expect(turns.map((turn) => turn.id)).toEqual(['u2'])
  })

  it('keeps a work-only turn while work shows, and drops it while hidden', () => {
    const messages = [assistant('a1', '', [codeCall('call_1', 'return 1')])]
    const calls = new Map([['call_1', [lookup]]])

    const shown = selectTurns(messages, calls, false, true).turns
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ kind: 'assistant', work: [lookup] })

    expect(selectTurns(messages, calls, false, false).turns).toEqual([])
  })

  it('puts the caret only on the last assistant turn while loading', () => {
    const messages = [
      user('u1', 'hola'),
      assistant('a1', 'Hola.'),
      user('u2', '¿y mañana?'),
      assistant('a2', 'Mañana'),
    ]
    const streaming = (isLoading: boolean) =>
      selectTurns(messages, noCalls, isLoading, true).turns.map((turn) =>
        turn.kind === 'assistant' ? turn.streaming : null,
      )

    expect(streaming(true)).toEqual([null, false, null, true])
    expect(streaming(false)).toEqual([null, false, null, false])
  })

  it('keeps an empty assistant turn that is streaming', () => {
    const { turns } = selectTurns(
      [user('u1', 'hola'), assistant('a1', '')],
      noCalls,
      true,
      true,
    )
    expect(turns.at(-1)).toMatchObject({ id: 'a1', streaming: true, text: '' })
  })

  it('shows thinking while streaming or before any text, never after', () => {
    const thought = [thinking('pensando')]
    const thinkingOf = (message: UIMessage, isLoading: boolean) => {
      const turn = selectTurns([message], noCalls, isLoading, true).turns[0]
      return turn?.kind === 'assistant' ? turn.thinking : undefined
    }

    expect(thinkingOf(assistant('a1', 'Listo.', thought), true)).toBe('pensando')
    expect(thinkingOf(assistant('a1', '', thought), false)).toBe('pensando')
    expect(thinkingOf(assistant('a1', 'Listo.', thought), false)).toBeNull()
    expect(thinkingOf(assistant('a1', 'Listo.'), true)).toBeNull()
  })

  it('summarizes live calls over calls inferred from the code', () => {
    const { turns } = selectTurns(
      [assistant('a1', 'Listo.', [codeCall('call_1', bookingCode)])],
      new Map([['call_1', [lookup, phoneUpdate]]]),
      false,
      true,
    )
    const summary = summarizeWrites([lookup, phoneUpdate])
    expect(summary.kind).toBe('receipt')
    expect(turns[0]).toMatchObject({ summary, work: [lookup, phoneUpdate] })
  })

  it('infers the writes from the code on a replayed turn', () => {
    const { turns } = selectTurns(
      [assistant('a1', 'Agendé.', [codeCall('call_1', bookingCode)])],
      noCalls,
      false,
      true,
    )
    const summary = summarizeWrites(inferWriteCallsFromCode(bookingCode, 'call_1'))
    expect(summary.kind).toBe('receipt')
    expect(turns[0]).toMatchObject({ summary, work: [] })
  })

  it('claims no writes after a failed run', () => {
    const { turns } = selectTurns(
      [assistant('a1', 'No pude.', [codeCall('call_1', bookingCode, false)])],
      noCalls,
      false,
      true,
    )
    expect(turns[0]).toMatchObject({ summary: { kind: 'none' } })
  })

  it('waits only while loading with no assistant turn started', () => {
    const asked = [user('u1', 'hola')]
    const answering = [user('u1', 'hola'), assistant('a1', 'Ho')]

    expect(selectTurns(asked, noCalls, true, true).waiting).toBe(true)
    expect(selectTurns(asked, noCalls, false, true).waiting).toBe(false)
    expect(selectTurns(answering, noCalls, true, true).waiting).toBe(false)
  })
})
