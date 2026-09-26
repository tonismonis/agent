import { describe, expect, it } from 'vitest'

import {
  cardThreshold,
  crmToolName,
  inferWriteCallsFromCode,
  isWriteTool,
  summarizeWrites,
  type WorkCall,
} from '#/lib/write-receipts'

function call(partial: Partial<WorkCall> & { name: string }): WorkCall {
  return { key: partial.name, toolCallId: 'call_1', ...partial }
}

describe('isWriteTool', () => {
  it('separates writes from reads', () => {
    expect(isWriteTool('updateClient')).toBe(true)
    expect(isWriteTool('softDeleteAppointment')).toBe(true)
    expect(isWriteTool('findClients')).toBe(false)
    expect(isWriteTool('listAuditLog')).toBe(false)
  })
})

describe('summarizeWrites', () => {
  it('renders nothing for a read-only turn', () => {
    expect(summarizeWrites([call({ name: 'findPayments', result: [] })])).toEqual({
      kind: 'none',
    })
  })

  it('lists the fields that moved when under the threshold', () => {
    const summary = summarizeWrites([
      call({
        name: 'updateClient',
        args: { id: 4, phone: '+56 9 4412 8890' },
        result: { id: 4, name: 'María Fuentes', phone: '+56 9 4412 8890' },
      }),
    ])

    expect(summary).toEqual({
      kind: 'receipt',
      lines: [
        { label: 'María Fuentes · teléfono', value: '+56 9 4412 8890' },
      ],
    })
  })

  it('shows the record as a card once the turn crosses the threshold', () => {
    const created = Array.from({ length: cardThreshold }, (_, index) =>
      call({
        key: `a${index}`,
        name: 'createAppointment',
        args: { client_id: 4, starts_at: '2026-08-19T17:00:00Z' },
        result: {
          id: index,
          name: 'Clase de piano',
          starts_at: '2026-08-19T17:00:00Z',
          price: 40000,
          mode: 'in_person',
        },
      }),
    )
    const summary = summarizeWrites(created)

    expect(summary.kind).toBe('card')
    if (summary.kind !== 'card') return
    expect(summary.count).toBe(cardThreshold)
    expect(summary.subject).toBe('Clase de piano')
    expect(summary.rows).toContainEqual({ label: 'Precio', value: '40.000' })
    expect(summary.rows).toContainEqual({ label: 'Modalidad', value: 'presencial' })
    // 17:00 UTC is 13:00 in Santiago in August, whatever the browser's zone.
    expect(summary.rows).toContainEqual({
      label: 'Inicio',
      value: 'mié 19 ago · 13:00',
    })
  })

  it('ignores failed calls', () => {
    expect(
      summarizeWrites([call({ name: 'updateClient', error: 'boom' })]),
    ).toEqual({ kind: 'none' })
  })

  it('falls back to counted lines when only the code is left', () => {
    const calls = inferWriteCallsFromCode(
      `const c = await findClients({ query: "maría" })
       await updateClient({ id: c[0].id, phone: "+56" })
       for (const d of dates) await createAppointment({ client_id: c[0].id, starts_at: d })
       await createAppointment({ client_id: c[0].id, starts_at: "later" })
       setTimeout(() => {}, 0)`,
      'call_9',
    )
    expect(calls.map((one) => one.name).sort()).toEqual([
      'createAppointment',
      'updateClient',
    ])

    const summary = summarizeWrites(calls)
    expect(summary.kind).toBe('receipt')
    if (summary.kind !== 'receipt') return
    expect(summary.lines).toContainEqual({
      label: 'Cita · creada',
      value: '×2',
    })
  })
})

describe('code-mode binding names', () => {
  it('reads sandbox calls by their CRM tool name', () => {
    const calls = inferWriteCallsFromCode(
      `const c = await external_findClients({ query: "rosa" })
       await external_createAppointment({ client_id: c[0].id, starts_at: "x" })`,
      'call_3',
    )

    expect(calls.map((found) => found.name)).toEqual(['createAppointment'])
  })

  it('treats a live external_ write as a write', () => {
    expect(isWriteTool(crmToolName('external_createClient'))).toBe(true)
  })
})

describe('series receipts', () => {
  it('names a created series by client and class count', () => {
    expect(
      summarizeWrites([
        call({
          name: 'createAppointmentSeries',
          args: { client_id: 3, weekly: [{ day: 'tuesday', time: '17:00' }] },
          result: {
            id: 7,
            client_name: 'Pedro Soto',
            classes: Array.from({ length: 12 }, (_, id) => ({ id })),
          },
        }),
      ]),
    ).toEqual({
      kind: 'receipt',
      lines: [{ label: 'Serie · creada', value: 'Pedro Soto · 12 clases' }],
    })
  })

  it('shows a new end date and weekly times the way the Owner reads them', () => {
    expect(
      summarizeWrites([
        call({
          name: 'updateAppointmentSeries',
          args: {
            id: 7,
            until: '2026-12-15',
            weekly: [{ day: 'tuesday', time: '18:00' }],
          },
          result: { id: 7, client_name: 'Pedro Soto' },
        }),
      ]),
    ).toEqual({
      kind: 'receipt',
      lines: [
        { label: 'Serie · hasta', value: 'mar 15 dic' },
        { label: 'Serie · días', value: 'martes 18:00' },
      ],
    })
  })

  it('gives a refused call no receipt, and finds series writes in replayed code', () => {
    expect(
      summarizeWrites([
        call({ name: 'createAppointmentSeries', error: 'No agendé…', refused: true }),
      ]),
    ).toEqual({ kind: 'none' })
    expect(
      inferWriteCallsFromCode(
        'await external_softDeleteAppointmentSeries({ id: 7 })',
        'call_9',
      ).map((each) => each.name),
    ).toEqual(['softDeleteAppointmentSeries'])
  })
})
