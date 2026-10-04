/**
 * Renders the receipt facts of one agent turn as the lines the chat shows under
 * the agent's sentence, in the Owner's Spanish. Reads leave no fact, so a
 * read-only turn has no receipt; the work margin already covers reads.
 */

import {
  isJsonBoolean,
  isJsonNumber,
  isJsonString,
  type JsonValue,
} from '#/lib/json'
import {
  buildFactKey,
  type FieldChange,
  type ReceiptFact,
  type WriteAction,
} from '#/lib/receipt-facts'

export type WorkCall = {
  /** Stable key for React and for pairing a call with its result. */
  key: string
  /** Tool call part the call ran inside (the code-mode execution). */
  toolCallId: string
  name: string
  /** The JSON the tool was called with, and the JSON it came back with. */
  args?: JsonValue
  result?: JsonValue
  error?: string
  /** The error is a refusal: the tool said no on purpose and saved nothing. */
  refused?: true
  durationMs?: number
}

type LineText = { label: string; value: string }
export type ReceiptLine = LineText & { key: string }

const writeVerbs = ['create', 'update', 'softdelete', 'soft_delete', 'restore']

type Gender = 'm' | 'f'

type Entity = ReceiptFact['entity']

/** Each record kind as the Owner names it, and the gender a participle agrees with. */
const nouns = {
  client: { one: 'Cliente', many: 'clientes', gender: 'm' },
  service: { one: 'Servicio', many: 'servicios', gender: 'm' },
  profile: { one: 'Perfil', many: 'perfiles', gender: 'm' },
  appointment: { one: 'Cita', many: 'citas', gender: 'f' },
  payment: { one: 'Pago', many: 'pagos', gender: 'm' },
  series: { one: 'Serie', many: 'series', gender: 'f' },
} satisfies Record<Entity, { one: string; many: string; gender: Gender }>

const verbStems = {
  created: 'cread',
  updated: 'actualizad',
  removed: 'eliminad',
  restored: 'restaurad',
} satisfies Record<WriteAction, string>

/** A create as the Owner says it: an appointment is booked, a payment recorded. */
const createdStems = new Map<Entity, string>([
  ['appointment', 'agendad'],
  ['payment', 'registrad'],
])

/** Column names as the Owner reads them; unknown columns fall back to humanizeField. */
const fieldLabels = new Map([
  ['email', 'Correo'],
  ['phone', 'Teléfono'],
  ['notes', 'Notas'],
  ['price', 'Precio'],
  ['unit', 'Unidad'],
  ['duration_minutes', 'Duración (min)'],
  ['mode', 'Modalidad'],
  ['status', 'Estado'],
])

/** Stored enum values as the Owner says them. */
const valueLabels = new Map([
  ['in_person', 'presencial'],
  ['scheduled', 'agendada'],
  ['completed', 'realizada'],
  ['cancelled', 'cancelada'],
  ['no_show', 'no asistió'],
  ['hour', 'por hora'],
  ['flat', 'precio fijo'],
])

const santiago = 'America/Santiago'

/**
 * Code mode exposes each CRM tool inside the sandbox as `external_<name>`, and
 * that is the name its call events and the model's code carry. Everything here
 * speaks the CRM tool's own name.
 */
export function crmToolName(bindingName: string) {
  return bindingName.replace(/^external_/, '')
}

function normalize(name: string) {
  return name.replace(/[^a-z0-9]/gi, '').toLowerCase()
}

/**
 * A tool writes when its name starts with a mutating verb. Matching the verb
 * rather than a fixed list keeps new CRM tools working without a change here;
 * every `find*` / `list*` tool falls through as a read.
 */
export function isWriteTool(name: string) {
  const flat = normalize(name)
  return writeVerbs.some((verb) => flat.startsWith(normalize(verb)))
}

/** The action as a participle agreeing with the record: `cita agendada`, `pagos eliminados`. */
function participle(entity: Entity, action: WriteAction, plural: boolean) {
  const stem =
    (action === 'created' ? createdStems.get(entity) : undefined) ?? verbStems[action]
  const ending = nouns[entity].gender === 'f' ? 'a' : 'o'
  return `${stem}${ending}${plural ? 's' : ''}`
}

/** An update that only set an appointment's status reads as what happened to it. */
const statusHeadlines = new Map([
  ['cancelled', ['Cita cancelada', 'citas canceladas']],
  ['completed', ['Cita realizada', 'citas realizadas']],
  ['no_show', ['Cita sin asistencia', 'citas sin asistencia']],
  ['scheduled', ['Cita reagendada', 'citas reagendadas']],
])

function movedHeadline(changes: ReadonlyArray<FieldChange>, count: number) {
  if (!changes.some((change) => change.field === 'starts_at')) return null
  return count === 1 ? 'Cita movida' : `${count} citas movidas`
}

function statusHeadline(changes: ReadonlyArray<FieldChange>, count: number) {
  const [only] = changes
  if (changes.length !== 1 || only?.field !== 'status' || !isJsonString(only.value)) return null
  const words = statusHeadlines.get(only.value)
  if (!words) return null
  return count === 1 ? words[0] : `${count} ${words[1]}`
}

/** `Cita agendada` for one record; `3 pagos` or `2 citas eliminadas` for several. */
function headline(entity: Entity, action: WriteAction, count: number) {
  const noun = nouns[entity]
  if (count === 1) return `${noun.one} ${participle(entity, action, false)}`
  if (action === 'created') return `${count} ${noun.many}`
  return `${count} ${noun.many} ${participle(entity, action, true)}`
}

/** `mié 14 oct · 10:00`, always in the practice's timezone. */
function formatInstant(date: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('es-CL', {
      timeZone: santiago,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value.replace(/\.$/, '')]),
  )
  return `${parts.weekday} ${parts.day} ${parts.month} · ${parts.hour}:${parts.minute}`
}

const weekdayNames = new Map([
  ['monday', 'lunes'],
  ['tuesday', 'martes'],
  ['wednesday', 'miércoles'],
  ['thursday', 'jueves'],
  ['friday', 'viernes'],
  ['saturday', 'sábado'],
  ['sunday', 'domingo'],
])

/** `mar 15 dic`, read off the calendar date itself. */
function formatDate(value: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('es-CL', {
      timeZone: 'UTC',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    })
      .formatToParts(new Date(`${value}T12:00:00Z`))
      .map((part) => [part.type, part.value.replace(/\.$/, '')]),
  )
  return `${parts.weekday} ${parts.day} ${parts.month}`
}

/** `martes 17:00, jueves 18:00` */
function formatWeekly(weekly: ReadonlyArray<{ day: string; time: string }>) {
  return weekly
    .map((slot) => `${weekdayNames.get(slot.day) ?? slot.day} ${slot.time}`)
    .join(', ')
}

function formatFieldValue(field: string, value: JsonValue): string {
  if (value === null) return '—'
  if (isJsonBoolean(value)) return value ? 'sí' : 'no'
  if (isJsonNumber(value)) {
    if (/price|amount|rate|total/.test(field))
      return new Intl.NumberFormat('es-CL').format(value)
    return String(value)
  }
  if (isJsonString(value)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value)
    if (field.endsWith('_at') || /^(starts|ends|paid)_/.test(field)) {
      const date = new Date(value)
      if (!Number.isNaN(date.getTime())) return formatInstant(date)
    }
    const spoken = valueLabels.get(value) ?? value
    return spoken.length > 48 ? `${spoken.slice(0, 47)}…` : spoken
  }
  if (Array.isArray(value)) return `${value.length} elementos`
  try {
    const json = JSON.stringify(value)
    return json.length > 48 ? `${json.slice(0, 47)}…` : json
  } catch {
    return String(value)
  }
}

function humanizeField(field: string) {
  const known = fieldLabels.get(field)
  if (known) return known
  const words = field.replace(/_/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** `teléfono +56 9 2222 3333` */
function changeText(change: FieldChange) {
  return `${humanizeField(change.field).toLowerCase()} ${formatFieldValue(change.field, change.value)}`
}

function joined(parts: ReadonlyArray<string | null>) {
  return parts.filter((part) => part !== null && part !== '').join(' · ')
}

type SeriesFact = Extract<ReceiptFact, { entity: 'series' }>

/** A new end that cancelled classes ends the series; one that booked more extends it. */
function seriesHeadline(fact: SeriesFact) {
  if (fact.action === 'updated' && fact.until !== null) {
    if (fact.cancelled > 0) return 'Serie terminada'
    if (fact.added > 0) return 'Serie extendida'
  }
  return headline('series', fact.action, 1)
}

function seriesLines(fact: SeriesFact): Array<LineText> {
  const classes =
    fact.classes === null
      ? null
      : `${fact.classes} ${fact.classes === 1 ? 'clase' : 'clases'}`
  const counts: Array<[string, number]> = [
    ['Clases canceladas', fact.cancelled],
    ['Clases nuevas', fact.added],
    ['Clases borradas', fact.removed],
  ]
  return [
    {
      label: seriesHeadline(fact),
      value: joined([
        fact.client,
        fact.until === null ? formatWeekly(fact.weekly) : `hasta ${formatDate(fact.until)}`,
        classes,
        ...fact.changes.map(changeText),
      ]),
    },
    ...counts
      .filter(([, count]) => count > 0)
      .map(([label, count]) => ({ label, value: String(count) })),
  ]
}

function factToLines(fact: ReceiptFact): Array<LineText> {
  switch (fact.entity) {
    case 'client':
    case 'service':
    case 'profile':
      return [
        {
          label: headline(fact.entity, fact.action, fact.count),
          value: joined([fact.subject, ...fact.changes.map(changeText)]),
        },
      ]
    case 'appointment': {
      if (fact.action === 'updated') {
        const status = statusHeadline(fact.changes, fact.count)
        const when =
          fact.starts_at === null ? null : formatFieldValue('starts_at', fact.starts_at)
        if (status) return [{ label: status, value: joined([fact.client, when]) }]
        const moved = movedHeadline(fact.changes, fact.count)
        const others = fact.changes.filter((change) => change.field !== 'starts_at')
        return [
          {
            label: moved ?? headline(fact.entity, fact.action, fact.count),
            value: joined([
              fact.client,
              moved === null ? null : when,
              ...others.map(changeText),
            ]),
          },
        ]
      }
      return [
        {
          label: headline(fact.entity, fact.action, fact.count),
          value: joined([
            fact.client,
            fact.starts_at === null ? null : formatFieldValue('starts_at', fact.starts_at),
          ]),
        },
      ]
    }
    case 'payment':
      return [
        {
          label: headline(fact.entity, fact.action, fact.count),
          value: joined([fact.client, formatFieldValue('amount', fact.amount)]),
        },
      ]
    case 'series':
      return seriesLines(fact)
  }
}

/**
 * The receipt under one agent turn, one line per fact plus a series' class
 * counts. A line keeps its key while its count grows, so it updates in place.
 */
export function receiptLines(facts: ReadonlyArray<ReceiptFact>): Array<ReceiptLine> {
  return facts.flatMap((fact) =>
    factToLines(fact).map((line, index) => ({
      ...line,
      key: `${buildFactKey(fact)}:${index}`,
    })),
  )
}
