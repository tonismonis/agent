/**
 * Turns the tool activity of one agent turn into the receipt the chat shows
 * under the agent's sentence. Reads produce nothing — the work margin already
 * covers them. Writes produce either a short list of the fields that moved or,
 * once the turn crosses `cardThreshold` records, a card of the record as it now
 * reads.
 *
 * Everything here is defensive: the shapes come off a streamed tool call, so a
 * missing `args`, a string where an object was expected, or a tool this file
 * has never heard of must degrade to "render less", never throw.
 */

import {
  isJsonBoolean,
  isJsonNumber,
  isJsonObject,
  isJsonString,
  type JsonObject,
  type JsonValue,
} from '#/lib/json'

/** At or above this many records written, the turn shows a card, not a list. */
export const cardThreshold = 3

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
  durationMs?: number
  /** Set when the call was recovered from code text, so values are unknown. */
  inferred?: boolean
}

export type ReceiptLine = { label: string; value: string }

export type WriteSummary =
  | { kind: 'none' }
  | { kind: 'receipt'; lines: Array<ReceiptLine> }
  | { kind: 'card'; subject: string; count: number; rows: Array<ReceiptLine> }

const writeVerbs = ['create', 'update', 'softdelete', 'soft_delete', 'restore', 'set']

const entityByToken: Array<[string, string]> = [
  ['client', 'Client'],
  ['service', 'Service'],
  ['appointment', 'Appointment'],
  ['payment', 'Payment'],
  ['working_hours', 'Working hours'],
  ['owner_profile', 'Owner profile'],
]

/** Fields that are plumbing, not something the owner asked to change. */
const hiddenFields = new Set([
  'id',
  'owner_id',
  'created_at',
  'updated_at',
  'deleted_at',
])

const maxReceiptLines = 8
const maxCardRows = 6

/**
 * Only used when recovering calls from code text, where a loose verb match
 * would happily count `setTimeout(` as a write. Live calls are matched by verb
 * instead, since their names come from the bound tools themselves.
 */
const knownWriteTools = new Set(
  [
    'Client',
    'Service',
    'Appointment',
    'Payment',
  ].flatMap((entity) => [
    `create${entity}`,
    `update${entity}`,
    `softDelete${entity}`,
    `restore${entity}`,
  ]),
)
knownWriteTools.add('set_working_hours')
knownWriteTools.add('update_owner_profile')

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

export function toolVerb(name: string): 'created' | 'updated' | 'removed' | 'restored' | 'set' {
  const flat = normalize(name)
  if (flat.startsWith('create')) return 'created'
  if (flat.startsWith('softdelete')) return 'removed'
  if (flat.startsWith('restore')) return 'restored'
  if (flat.startsWith('set')) return 'set'
  return 'updated'
}

export function toolEntity(name: string) {
  const flat = name.toLowerCase()
  for (const [token, label] of entityByToken) {
    if (flat.includes(token.replace('_', ''))) return label
    if (flat.includes(token)) return label
  }
  return 'Record'
}

/** The record case of a payload, or null — a call may carry anything at all. */
function asRecord(value: JsonValue | undefined): JsonObject | null {
  return isJsonObject(value) ? value : null
}

/** How many records one call touched: an array result means one per element. */
function recordCount(call: WorkCall) {
  if (call.error) return 0
  if (Array.isArray(call.result)) return call.result.length || 1
  return 1
}

function subjectOf(call: WorkCall) {
  const result = asRecord(call.result)
  const args = asRecord(call.args)
  const name = result?.name ?? args?.name
  if (isJsonString(name) && name.trim()) return name.trim()
  return toolEntity(call.name)
}

export function formatFieldValue(
  field: string,
  value: JsonValue | undefined,
): string {
  if (value === null || value === undefined) return '—'
  if (isJsonBoolean(value)) return value ? 'yes' : 'no'
  if (isJsonNumber(value)) {
    if (/price|amount|rate|total/.test(field))
      return new Intl.NumberFormat('es-CL').format(value)
    return String(value)
  }
  if (isJsonString(value)) {
    if (field.endsWith('_at') || /^(starts|ends|paid)_/.test(field)) {
      const date = new Date(value)
      if (!Number.isNaN(date.getTime()))
        return new Intl.DateTimeFormat('en-GB', {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })
          .format(date)
          .replace(/,/g, ' ·')
    }
    return value.length > 48 ? `${value.slice(0, 47)}…` : value
  }
  if (Array.isArray(value)) return `${value.length} items`
  try {
    const json = JSON.stringify(value)
    return json.length > 48 ? `${json.slice(0, 47)}…` : json
  } catch {
    return String(value)
  }
}

export function humanizeField(field: string) {
  const words = field.replace(/_/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function receiptLinesFor(call: WorkCall): Array<ReceiptLine> {
  const subject = subjectOf(call)
  const verb = toolVerb(call.name)

  if (call.inferred) {
    const count = recordCount(call)
    return [
      {
        label: `${toolEntity(call.name)} · ${verb}`,
        value: count > 1 ? `×${count}` : 'written',
      },
    ]
  }

  if (verb === 'removed' || verb === 'restored')
    return [{ label: subject, value: verb }]

  const args = asRecord(call.args)
  const moved = args
    ? Object.entries(args).filter(
        ([field, value]) =>
          !hiddenFields.has(field) && value !== undefined && value !== null,
      )
    : []

  if (verb === 'created') {
    // A create moves every field at once; naming them all reads as noise, so
    // the line names the record and the count instead.
    const count = recordCount(call)
    return [
      {
        label: `${toolEntity(call.name)} · created`,
        value: count > 1 ? `×${count}` : subject,
      },
    ]
  }

  if (moved.length === 0)
    return [{ label: `${subject} · ${verb}`, value: 'written' }]

  return moved.map(([field, value]) => ({
    label: `${subject} · ${humanizeField(field).toLowerCase()}`,
    value: formatFieldValue(field, value),
  }))
}

function cardRowsFor(calls: Array<WorkCall>): Array<ReceiptLine> {
  // The card shows the primary subject as it now reads: the last write that
  // came back with a whole record wins.
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const raw = calls[index]?.result
    const record =
      asRecord(raw) ?? (Array.isArray(raw) ? asRecord(raw.at(-1)) : null)
    if (!record) continue
    const rows = Object.entries(record)
      .filter(
        ([field, value]) =>
          !hiddenFields.has(field) &&
          !field.endsWith('_id') &&
          value !== null &&
          value !== undefined &&
          value !== '',
      )
      .slice(0, maxCardRows)
      .map(([field, value]) => ({
        label: humanizeField(field),
        value: formatFieldValue(field, value),
      }))
    if (rows.length > 0) return rows
  }
  return []
}

function cardSubject(calls: Array<WorkCall>) {
  const named = calls.find((call) => subjectOf(call) !== toolEntity(call.name))
  return named ? subjectOf(named) : toolEntity(calls[0]?.name ?? '')
}

/**
 * The whole receipt decision for one agent turn. `threshold` is a parameter so
 * the cutoff can be tuned in one place without either renderer knowing about it.
 */
export function summarizeWrites(
  calls: Array<WorkCall>,
  threshold: number = cardThreshold,
): WriteSummary {
  const writes = calls.filter((call) => isWriteTool(call.name) && !call.error)
  if (writes.length === 0) return { kind: 'none' }

  const count = writes.reduce((total, call) => total + recordCount(call), 0)
  if (count === 0) return { kind: 'none' }

  const rows = count >= threshold ? cardRowsFor(writes) : []
  if (rows.length > 0)
    return { kind: 'card', subject: cardSubject(writes), count, rows }

  const lines = writes.flatMap(receiptLinesFor).slice(0, maxReceiptLines)
  return lines.length > 0 ? { kind: 'receipt', lines } : { kind: 'none' }
}

/**
 * Recovers write calls from the code the agent ran, for turns replayed from
 * persistence where the live per-call events are gone. Names only — the args
 * and results were never persisted — so these render as counted lines.
 */
export function inferWriteCallsFromCode(
  code: string,
  toolCallId: string,
): Array<WorkCall> {
  const counts = new Map<string, number>()
  const pattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
  let match = pattern.exec(code)
  while (match) {
    const name = crmToolName(match[1]!)
    if (knownWriteTools.has(name)) counts.set(name, (counts.get(name) ?? 0) + 1)
    match = pattern.exec(code)
  }
  return [...counts].map(([name, count]) => ({
    key: `${toolCallId}:${name}`,
    toolCallId,
    name,
    inferred: true,
    result: Array.from({ length: count }, () => null),
  }))
}
