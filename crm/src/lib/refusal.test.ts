import { describe, expect, test } from 'vitest'

import {
  RefusalError,
  readRefusal,
  refuse,
  refusalText,
  type ProblemFound,
} from './refusal'
import type { Clock, LocalDate } from './santiago-time'

// SAFETY: literals written in the branded formats.
const date = (value: string) => value as LocalDate
// SAFETY: literals written in the branded formats.
const time = (value: string) => value as Clock

const ana: ProblemFound = {
  date: date('2026-11-17'),
  time: time('17:00'),
  problem: 'taken',
  with: {
    appointment_id: 41,
    client: 'Ana',
    starts_at: new Date('2026-11-17T19:30:00Z'),
    ends_at: new Date('2026-11-17T20:30:00Z'),
  },
}
const rosa: ProblemFound = {
  date: date('2026-12-08'),
  time: time('17:00'),
  problem: 'taken',
  with: {
    appointment_id: 57,
    client: 'Rosa',
    starts_at: new Date('2026-12-08T20:00:00Z'),
    ends_at: new Date('2026-12-08T21:00:00Z'),
  },
}
const gap: ProblemFound = {
  date: date('2026-09-06'),
  time: time('00:30'),
  problem: 'no_such_hour',
}
const overlap: ProblemFound = {
  date: date('2026-10-06'),
  time: time('01:00'),
  problem: 'overlaps_series',
  other_time: time('23:00'),
}

describe('conflict', () => {
  test('one booking says what it collides with', () => {
    expect(refuse.conflict('book', 1, [ana]).refusal).toEqual({
      kind: 'conflict',
      say: 'El martes 17 de noviembre a las 17:00 ya tienes a Ana, de 16:30 a 17:30.',
      of: 1,
      dates: [
        {
          date: '2026-11-17',
          time: '17:00',
          problem: 'taken',
          with: {
            appointment_id: 41,
            client: 'Ana',
            span_local: 'martes 17 de noviembre, 16:30–17:30',
          },
        },
      ],
    })
  })

  test('single-booking sentences for each problem, restore prefixed', () => {
    expect(refuse.conflict('move', 1, [gap]).refusal).toHaveProperty(
      'say',
      'El domingo 6 de septiembre no existe la hora 00:30: esa noche se adelanta el reloj.',
    )
    expect(refuse.conflict('book', 1, [overlap]).refusal).toHaveProperty(
      'say',
      'El martes 6 de octubre la clase de las 01:00 se toparía con la de las 23:00.',
    )
    expect(refuse.conflict('restore', 1, [rosa]).refusal).toHaveProperty(
      'say',
      'No pude restaurar la cita. El martes 8 de diciembre a las 17:00 ya tienes a Rosa, de 17:00 a 18:00.',
    )
  })

  test('a series lists every date, sorted, and hands back the whole skip list', () => {
    const refusal = refuse.conflict('book_series', 14, [rosa, ana], [date('2026-10-06')])
      .refusal
    expect(refusal).toEqual(
      expect.objectContaining({
        say: 'No agendé ninguna clase porque 2 de las 14 fechas chocan:\n- martes 17 de noviembre, 17:00: ya tienes a Ana (16:30–17:30)\n- martes 8 de diciembre, 17:00: ya tienes a Rosa (17:00–18:00)',
        of: 14,
        retry: { skip: ['2026-10-06', '2026-11-17', '2026-12-08'] },
      }),
    )
  })

  test('series headers per frame, one and many, with every line kind', () => {
    expect(refusalText(refuse.conflict('change_series', 5, [gap]).refusal)).toBe(
      'No cambié ninguna clase porque una fecha choca:\n- domingo 6 de septiembre, 00:30: esa hora no existe porque se adelanta el reloj',
    )
    expect(
      refusalText(refuse.conflict('restore_series', 9, [overlap, gap]).refusal),
    ).toBe(
      'No restauré las clases porque 2 de las 9 fechas chocan:\n- domingo 6 de septiembre, 00:30: esa hora no existe porque se adelanta el reloj\n- martes 6 de octubre, 01:00: se topa con la clase de las 23:00',
    )
    expect(refusalText(refuse.conflict('book_series', 3, [ana]).refusal)).toMatch(
      /^No agendé ninguna clase porque una fecha choca:\n/,
    )
  })
})

describe('Owner questions and blocks', () => {
  test('asks', () => {
    expect(refuse.askEnd().refusal).toEqual({
      kind: 'ask',
      say: '¿Hasta cuándo agendo estas clases? Puede ser una fecha o un número de clases.',
      needs: ['end'],
    })
    expect(refuse.askShorter().refusal).toHaveProperty(
      'say',
      'Puedo agendar hasta 104 clases o un año de una vez. ¿Hasta cuándo las agendo?',
    )
    expect(refuse.askDuration('Piano a domicilio').refusal).toEqual({
      kind: 'ask',
      say: '¿Cuánto dura cada sesión de Piano a domicilio?',
      needs: ['duration_minutes'],
    })
  })

  test('a client with future appointments', () => {
    const at = new Date('2026-09-29T20:00:00Z')
    expect(
      refuse.clientHasFutureAppointments('Ana', [
        { id: 3, starts_at: at, series_id: null, series_rule: null },
      ]).refusal,
    ).toEqual({
      kind: 'blocked',
      say: 'Ana tiene una cita agendada desde hoy, el martes 29 de septiembre a las 17:00. Hay que cancelarla o borrarla antes de borrar a Ana.',
      appointments: [
        { id: 3, starts_local: 'martes 29 de septiembre, 17:00', series_id: null },
      ],
    })
    const rule = 'todos los martes a las 17:00'
    expect(
      refusalText(
        refuse.clientHasFutureAppointments('Ana', [
          { id: 3, starts_at: at, series_id: 7, series_rule: rule },
          { id: 4, starts_at: at, series_id: 7, series_rule: rule },
          { id: 5, starts_at: at, series_id: null, series_rule: null },
        ]).refusal,
      ),
    ).toBe(
      'Ana tiene 3 citas agendadas desde hoy, la primera el martes 29 de septiembre a las 17:00, entre ellas sus clases de todos los martes a las 17:00. Hay que cancelarlas o borrarlas antes de borrar a Ana.',
    )
  })

  test('internal never explains itself', () => {
    expect(refuse.internal(true).refusal).toEqual({
      kind: 'internal',
      say: 'Hubo un problema del sistema y esto no se guardó. Puedes intentarlo de nuevo en un rato.',
    })
    expect(refuse.internal(false).refusal).toHaveProperty(
      'say',
      'Hubo un problema del sistema y no pude revisar eso. Puedes intentarlo de nuevo en un rato.',
    )
  })
})

describe('model fixes', () => {
  test('carry fix and no say', () => {
    const invalid = refuse.invalidInput([{ path: 'weekly.0.time', problem: 'bad' }])
      .refusal
    expect(invalid).toEqual({
      kind: 'invalid_input',
      fix: 'Fix these inputs and call again. weekly.0.time: bad',
      issues: [{ path: 'weekly.0.time', problem: 'bad' }],
    })
    expect(refuse.notFound('service', 9).refusal).toEqual({
      kind: 'not_found',
      fix: 'No service with id 9. Look it up with external_findServices.',
      entity: 'service',
      id: 9,
    })
    expect(refuse.notesOff().refusal).not.toHaveProperty('say')
  })
})

describe('the wire', () => {
  test('a refusal round-trips through its message', () => {
    const error = refuse.conflict('book_series', 14, [ana, gap])
    expect(error).toBeInstanceOf(RefusalError)
    expect(error.name).toBe('Refusal')
    expect(readRefusal(error.message)).toEqual(error.refusal)
  })

  test('anything else is not a refusal', () => {
    expect(readRefusal('Time conflict with Ana')).toBeNull()
    expect(readRefusal('{"kind":"nope"}')).toBeNull()
    expect(readRefusal('{"kind":"ask","say":"¿?"}')).toBeNull()
  })
})
