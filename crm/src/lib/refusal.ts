/**
 * The one way a tool says no. A refusal crosses the code-mode bridge as its
 * JSON in `error.message`, the only field the sandbox keeps, and every reader
 * (sandbox code, chat-run, the work margin, the audit log) parses it with
 * `readRefusal`.
 *
 * Kinds split by who can resolve them. `say` kinds need the Owner, and the
 * model relays the Spanish sentence. `fix` kinds are the model's own mistake:
 * it corrects the call without telling the Owner. A refusal never has both.
 */

import { z } from 'zod'

import {
  clock,
  describeLocalDay,
  localDate,
  santiagoClockOf,
  santiagoDateOf,
  describeSantiagoSpan,
  describeSantiagoTime,
  type Clock,
  type LocalDate,
} from '#/lib/santiago-time'

export type RefusalEntity =
  | 'client'
  | 'service'
  | 'appointment'
  | 'payment'
  | 'series'

const refusalEntity = z.enum([
  'client',
  'service',
  'appointment',
  'payment',
  'series',
])

/** Which write a conflict belongs to; picks the Spanish and whether `retry` exists. */
export type ConflictFrame =
  | 'book'
  | 'move'
  | 'restore'
  | 'book_series'
  | 'change_series'
  | 'restore_series'

const dateProblem = z.discriminatedUnion('problem', [
  z.object({
    date: localDate,
    time: clock,
    problem: z.literal('taken'),
    with: z.object({
      appointment_id: z.number(),
      client: z.string(),
      span_local: z.string(),
    }),
  }),
  z.object({ date: localDate, time: clock, problem: z.literal('no_such_hour') }),
  z.object({
    date: localDate,
    time: clock,
    problem: z.literal('overlaps_series'),
    other_time: clock,
  }),
])
export type DateProblem = z.output<typeof dateProblem>

const refusalWire = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('conflict'),
    say: z.string(),
    /** Every date the request asked for, so "2 de las 14" can be said. */
    of: z.number(),
    dates: z.array(dateProblem),
    /** Series frames only: the complete skip list to send back unchanged. */
    retry: z.object({ skip: z.array(localDate) }).optional(),
  }),
  z.object({ kind: z.literal('ask'), say: z.string(), needs: z.array(z.string()) }),
  z.object({
    kind: z.literal('blocked'),
    say: z.string(),
    appointments: z.array(
      z.object({
        id: z.number(),
        starts_local: z.string(),
        series_id: z.number().nullable(),
      }),
    ),
  }),
  z.object({ kind: z.literal('internal'), say: z.string() }),
  z.object({
    kind: z.literal('invalid_input'),
    fix: z.string(),
    issues: z.array(z.object({ path: z.string(), problem: z.string() })),
  }),
  z.object({
    kind: z.literal('not_found'),
    fix: z.string(),
    entity: refusalEntity,
    id: z.number(),
  }),
  z.object({ kind: z.literal('notes_off'), fix: z.string() }),
])
export type Refusal = z.output<typeof refusalWire>

/** Thrown by tool code. Its message is already the wire format. */
export class RefusalError extends Error {
  override readonly name = 'Refusal'
  constructor(readonly refusal: Refusal) {
    super(JSON.stringify(refusal))
  }
}

/** `null` for anything that is not a refusal: the model's own TypeError, a crash. */
export function readRefusal(message: string): Refusal | null {
  let json
  try {
    json = JSON.parse(message)
  } catch {
    return null
  }
  const parsed = refusalWire.safeParse(json)
  return parsed.success ? parsed.data : null
}

/** What a person reads: `say` for the Owner, otherwise the model's `fix`. */
export function refusalText(refusal: Refusal) {
  return 'say' in refusal ? refusal.say : refusal.fix
}

export const MAX_SERIES_CLASSES = 104
export const MAX_SERIES_DAYS = 366

/**
 * Exact Spanish. `{day}` is describeLocalDay(date), `{time}` the requested
 * clock, `{a}`/`{b}` the other appointment's start and end clocks.
 */
export const TEMPLATES = {
  single: {
    taken: 'El {day} a las {time} ya tienes a {client}, de {a} a {b}.',
    no_such_hour:
      'El {day} no existe la hora {time}: esa noche se adelanta el reloj.',
    overlaps_series:
      'El {day} la clase de las {time} se toparía con la de las {other_time}.',
    restorePrefix: 'No pude restaurar la cita. ',
  },
  header: {
    book_series: {
      one: 'No agendé ninguna clase porque una fecha choca:',
      many: 'No agendé ninguna clase porque {n} de las {of} fechas chocan:',
    },
    change_series: {
      one: 'No cambié ninguna clase porque una fecha choca:',
      many: 'No cambié ninguna clase porque {n} de las {of} fechas chocan:',
    },
    restore_series: {
      one: 'No restauré las clases porque una fecha choca:',
      many: 'No restauré las clases porque {n} de las {of} fechas chocan:',
    },
  },
  line: {
    taken: '- {day}, {time}: ya tienes a {client} ({a}–{b})',
    no_such_hour: '- {day}, {time}: esa hora no existe porque se adelanta el reloj',
    overlaps_series: '- {day}, {time}: se topa con la clase de las {other_time}',
  },
  clientBlocked: {
    one: '{client} tiene una cita agendada desde hoy, el {day} a las {time}{series}. Hay que cancelarla o borrarla antes de borrar a {client}.',
    many: '{client} tiene {n} citas agendadas desde hoy, la primera el {day} a las {time}{series}. Hay que cancelarlas o borrarlas antes de borrar a {client}.',
  },
  clientBlockedSeries: ', entre ellas sus clases de {rules}',
  internal: {
    write:
      'Hubo un problema del sistema y esto no se guardó. Puedes intentarlo de nuevo en un rato.',
    read: 'Hubo un problema del sistema y no pude revisar eso. Puedes intentarlo de nuevo en un rato.',
  },
  askEnd:
    '¿Hasta cuándo agendo estas clases? Puede ser una fecha o un número de clases.',
  askShorter: `Puedo agendar hasta ${MAX_SERIES_CLASSES} clases o un año de una vez. ¿Hasta cuándo las agendo?`,
  askDuration: '¿Cuánto dura cada sesión de {service}?',
} as const

function fill(template: string, values: Map<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    String(values.get(key) ?? match),
  )
}

/** A clash as tool code finds it: the other appointment's real instants. */
export type Clash = {
  date: LocalDate
  time: Clock
  with: { appointment_id: number; client: string; starts_at: Date; ends_at: Date }
}

/** What a conflict is built from; `taken` carries instants, the wire carries text. */
export type ProblemFound =
  | ({ problem: 'taken' } & Clash)
  | Exclude<DateProblem, { problem: 'taken' }>

function placeholders(found: ProblemFound) {
  const values = new Map<string, string | number>([
    ['day', describeLocalDay(found.date)],
    ['time', found.time],
  ])
  if (found.problem === 'taken') {
    values.set('client', found.with.client)
    values.set('a', santiagoClockOf(found.with.starts_at))
    values.set('b', santiagoClockOf(found.with.ends_at))
  }
  if (found.problem === 'overlaps_series')
    values.set('other_time', found.other_time)
  return values
}

function toWire(found: ProblemFound): DateProblem {
  if (found.problem !== 'taken') return found
  return {
    date: found.date,
    time: found.time,
    problem: 'taken',
    with: {
      appointment_id: found.with.appointment_id,
      client: found.with.client,
      span_local: describeSantiagoSpan(found.with.starts_at, found.with.ends_at),
    },
  }
}

const seriesHeaders = new Map<ConflictFrame, { one: string; many: string }>([
  ['book_series', TEMPLATES.header.book_series],
  ['change_series', TEMPLATES.header.change_series],
  ['restore_series', TEMPLATES.header.restore_series],
])

function ask(needs: Array<string>, say: string) {
  return new RefusalError({ kind: 'ask', say, needs })
}

const finder = new Map<RefusalEntity, string>([
  ['client', 'external_findClients'],
  ['service', 'external_findServices'],
  ['appointment', 'external_findAppointments'],
  ['payment', 'external_findPayments'],
  ['series', 'external_findAppointmentSeries'],
])

/** The only way to make a Refusal: `say` is derived from the details here. */
export const refuse = {
  conflict(
    frame: ConflictFrame,
    of: number,
    found: ReadonlyArray<ProblemFound>,
    priorSkip: ReadonlyArray<LocalDate> = [],
  ) {
    const sorted = [...found].sort((a, b) =>
      `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`),
    )
    const dates = sorted.map(toWire)
    const header = seriesHeaders.get(frame)
    if (header) {
      const n = new Set(sorted.map((each) => `${each.date} ${each.time}`)).size
      const values = new Map<string, string | number>([
        ['n', n],
        ['of', of],
      ])
      const say = [
        fill(n === 1 ? header.one : header.many, values),
        ...sorted.map((each) =>
          fill(TEMPLATES.line[each.problem], placeholders(each)),
        ),
      ].join('\n')
      const skip = [...new Set([...priorSkip, ...sorted.map((d) => d.date)])].sort()
      return new RefusalError({
        kind: 'conflict',
        say,
        of,
        dates,
        retry: { skip },
      })
    }
    const sentences = sorted
      .map((each) => fill(TEMPLATES.single[each.problem], placeholders(each)))
      .join(' ')
    const say =
      frame === 'restore'
        ? `${TEMPLATES.single.restorePrefix}${sentences}`
        : sentences
    return new RefusalError({ kind: 'conflict', say, of, dates })
  },

  askEnd() {
    return ask(['end'], TEMPLATES.askEnd)
  },

  askShorter() {
    return ask(['end'], TEMPLATES.askShorter)
  },

  askDuration(service: string) {
    return ask(
      ['duration_minutes'],
      fill(TEMPLATES.askDuration, new Map([['service', service]])),
    )
  },

  /** Missing fields the tool's guide knows how to ask for. */
  askFor(needs: Array<string>, questions: Array<string>) {
    return ask(needs, questions.join(' '))
  },

  clientHasFutureAppointments(
    client: string,
    upcoming: ReadonlyArray<{
      id: number
      starts_at: Date
      series_id: number | null
      series_rule: string | null
    }>,
  ) {
    const [first] = upcoming
    const rules = [
      ...new Set(upcoming.flatMap((each) => each.series_rule ?? [])),
    ]
    const values = new Map<string, string | number>([
      ['client', client],
      ['n', upcoming.length],
      ['day', first ? describeLocalDay(santiagoDateOf(first.starts_at)) : ''],
      ['time', first ? santiagoClockOf(first.starts_at) : ''],
      [
        'series',
        rules.length
          ? fill(
              TEMPLATES.clientBlockedSeries,
              new Map([['rules', rules.join(' y ')]]),
            )
          : '',
      ],
    ])
    const template =
      upcoming.length === 1
        ? TEMPLATES.clientBlocked.one
        : TEMPLATES.clientBlocked.many
    return new RefusalError({
      kind: 'blocked',
      say: fill(template, values),
      appointments: upcoming.map((each) => ({
        id: each.id,
        starts_local: describeSantiagoTime(each.starts_at),
        series_id: each.series_id,
      })),
    })
  },

  internal(write: boolean) {
    return new RefusalError({
      kind: 'internal',
      say: write ? TEMPLATES.internal.write : TEMPLATES.internal.read,
    })
  },

  invalidInput(issues: Array<{ path: string; problem: string }>) {
    return new RefusalError({
      kind: 'invalid_input',
      fix: `Fix these inputs and call again. ${issues
        .map((issue) => `${issue.path}: ${issue.problem}`)
        .join('; ')}`,
      issues,
    })
  },

  notFound(entity: RefusalEntity, id: number) {
    return new RefusalError({
      kind: 'not_found',
      fix: `No ${entity} with id ${id}. Look it up with ${finder.get(entity)}.`,
      entity,
      id,
    })
  },

  notesOff() {
    return new RefusalError({
      kind: 'notes_off',
      fix: 'Notes are turned off for this Owner. Call again without any notes field.',
    })
  },
}
