/**
 * What one execute_typescript run saved, as the receipt under the agent's reply
 * reads it. The server derives these facts from the writes the run made and
 * attaches them to the tool result, which is persisted; the chat renders them
 * into Spanish. Raw values only: no display strings cross this boundary.
 */

import { z } from 'zod'

import { isJsonObject, type JsonObject, type JsonValue } from '#/lib/json'

const writeAction = z.enum(['created', 'updated', 'removed', 'restored'])
const recordKind = z.enum(['client', 'service', 'profile', 'appointment', 'series', 'payment'])
/**
 * Why a write was not saved, for the refusals the Owner has to know about. The
 * agent's own mistakes, which it corrects and retries, never reach a receipt.
 */
const refusalReason = z.enum(['conflict', 'blocked', 'internal'])
const count = z.number().int()
/** Updates only: a field the call set and the value it set it to. */
const fieldChange = z.object({ field: z.string(), value: z.json() })
const weeklySlot = z.object({ day: z.string(), time: z.string() })

export const receiptFact = z.discriminatedUnion('entity', [
  z.object({
    entity: z.literal('refused'),
    /** The kind of record the write would have saved. */
    record: recordKind,
    action: writeAction,
    /** Whose record it was, when the server could tell from the args. */
    subject: z.string().nullable(),
    reason: refusalReason,
    count,
  }),
  z.object({
    entity: z.enum(['client', 'service', 'profile']),
    action: writeAction,
    subject: z.string(),
    count,
    changes: z.array(fieldChange),
  }),
  z.object({
    entity: z.literal('appointment'),
    action: writeAction,
    client: z.string(),
    count,
    /** The instant the result reports; null once the fact covers several. */
    starts_at: z.string().nullable(),
    changes: z.array(fieldChange),
  }),
  z.object({
    entity: z.literal('payment'),
    action: writeAction,
    client: z.string(),
    count,
    /** Whole CLP, summed over every payment the fact covers. */
    amount: z.number(),
  }),
  z.object({
    entity: z.literal('series'),
    action: writeAction,
    client: z.string(),
    weekly: z.array(weeklySlot),
    /** Live classes after a create or restore; null otherwise. */
    classes: count.nullable(),
    /** The new last date an update set; null otherwise. */
    until: z.string().nullable(),
    cancelled: count,
    added: count,
    removed: count,
    changes: z.array(fieldChange),
  }),
])

export const receiptSchema = z.array(receiptFact)

export type ReceiptFact = z.infer<typeof receiptFact>
export type WriteAction = z.infer<typeof writeAction>
export type RecordKind = z.infer<typeof recordKind>
export type RefusalReason = z.infer<typeof refusalReason>
export type FieldChange = z.infer<typeof fieldChange>

/** The event a CRM write tool emits once it has saved, or been refused. */
export const writeEventName = 'crm:write'

export const writeEvent = z.discriminatedUnion('status', [
  z.object({ status: z.literal('saved'), name: z.string(), args: z.json(), result: z.json() }),
  z.object({
    status: z.literal('refused'),
    name: z.string(),
    args: z.json(),
    reason: refusalReason,
    subject: z.string().nullable(),
  }),
])

export type Write = z.infer<typeof writeEvent>

/** One saved write as a fact, or null when its result is not one it can read. */
type FactReader = (write: { args: JsonObject; result: JsonValue }) => ReceiptFact | null

/** A write tool: the record it saves, how, and how its saved result reads. */
type WriteTool = { record: RecordKind; action: WriteAction; read: FactReader }

/** The fields an update set, minus the ones the fact already shows. */
function listChanges(args: JsonObject, shown: ReadonlyArray<string>): Array<FieldChange> {
  return Object.entries(args)
    .filter(([field, value]) => field !== 'id' && !shown.includes(field) && value !== null)
    .map(([field, value]) => ({ field, value }))
}

const namedRow = z.object({ name: z.string() })

function named(entity: 'client' | 'service' | 'profile', action: WriteAction): WriteTool {
  return {
    record: entity,
    action,
    read: ({ args, result }) => {
      const row = namedRow.safeParse(result)
      if (!row.success) return null
      const changes = action === 'updated' ? listChanges(args, ['name']) : []
      return { entity, action, subject: row.data.name, count: 1, changes }
    },
  }
}

const appointmentRow = z.object({ client_name: z.string(), starts_at: z.string() })

function appointment(action: WriteAction): WriteTool {
  return {
    record: 'appointment',
    action,
    read: ({ args, result }) => {
      const row = appointmentRow.safeParse(result)
      if (!row.success) return null
      // A move keeps the instant the result reports, not the wall time the args named.
      const changes =
        action === 'updated'
          ? listChanges(args, []).map((change) =>
              change.field === 'starts_at' ? { ...change, value: row.data.starts_at } : change,
            )
          : []
      return {
        entity: 'appointment',
        action,
        client: row.data.client_name,
        count: 1,
        starts_at: row.data.starts_at,
        changes,
      }
    },
  }
}

const paymentRow = z.object({ client_name: z.string(), amount: z.number() })

function payment(action: WriteAction): WriteTool {
  return {
    record: 'payment',
    action,
    read: ({ result }) => {
      const row = paymentRow.safeParse(result)
      if (!row.success) return null
      return {
        entity: 'payment',
        action,
        client: row.data.client_name,
        count: 1,
        amount: row.data.amount,
      }
    },
  }
}

const seriesRow = z.object({
  client_name: z.string(),
  weekly: z.array(weeklySlot),
  classes: z.array(z.unknown()),
  cancelled: count.optional(),
  added: count.optional(),
  removed: count.optional(),
})
const untilArg = z.object({ until: z.string() })

function series(action: WriteAction): WriteTool {
  return {
    record: 'series',
    action,
    read: ({ args, result }) => {
      const row = seriesRow.safeParse(result)
      if (!row.success) return null
      const until = untilArg.safeParse(args)
      return {
        entity: 'series',
        action,
        client: row.data.client_name,
        weekly: row.data.weekly,
        classes:
          action === 'created' || action === 'restored' ? row.data.classes.length : null,
        until: action === 'updated' && until.success ? until.data.until : null,
        cancelled: row.data.cancelled ?? 0,
        added: row.data.added ?? 0,
        removed: row.data.removed ?? 0,
        changes:
          action === 'updated' ? listChanges(args, ['from', 'until', 'weekly', 'skip']) : [],
      }
    },
  }
}

/** Every CRM write tool, by name: what it saves and how its receipt fact reads. */
const writeTools = {
  update_owner_profile: named('profile', 'updated'),
  createClient: named('client', 'created'),
  updateClient: named('client', 'updated'),
  softDeleteClient: named('client', 'removed'),
  restoreClient: named('client', 'restored'),
  createService: named('service', 'created'),
  updateService: named('service', 'updated'),
  softDeleteService: named('service', 'removed'),
  restoreService: named('service', 'restored'),
  createAppointment: appointment('created'),
  updateAppointment: appointment('updated'),
  softDeleteAppointment: appointment('removed'),
  restoreAppointment: appointment('restored'),
  createAppointmentSeries: series('created'),
  updateAppointmentSeries: series('updated'),
  softDeleteAppointmentSeries: series('removed'),
  restoreAppointmentSeries: series('restored'),
  createPayment: payment('created'),
  updatePayment: payment('updated'),
  softDeletePayment: payment('removed'),
  restorePayment: payment('restored'),
} satisfies Record<string, WriteTool>

export type WriteToolName = keyof typeof writeTools

function isWriteToolName(name: string): name is WriteToolName {
  return Object.hasOwn(writeTools, name)
}

/** The record a write tool saves and how, or null for a tool that does not write. */
export function lookupWriteTool(name: string) {
  if (!isWriteToolName(name)) return null
  const { record, action } = writeTools[name]
  return { record, action }
}

/** The refusals a receipt shows; null for the ones the agent fixes itself. */
export function classifyRefusal(kind: string): RefusalReason | null {
  const reason = refusalReason.safeParse(kind)
  return reason.success ? reason.data : null
}

function writeToFact(write: Write): ReceiptFact | null {
  if (!isWriteToolName(write.name)) return null
  const tool = writeTools[write.name]
  if (write.status === 'refused')
    return {
      entity: 'refused',
      record: tool.record,
      action: tool.action,
      subject: write.subject,
      reason: write.reason,
      count: 1,
    }
  return tool.read({
    args: isJsonObject(write.args) ? write.args : {},
    result: write.result,
  })
}

/**
 * A fact's identity within a receipt, also its key on screen. Updates share
 * one only when they set the same values: two moves stay two lines.
 */
export function buildFactKey(fact: ReceiptFact) {
  const who = 'subject' in fact ? fact.subject : fact.client
  const changes = fact.action === 'updated' && 'changes' in fact ? fact.changes : null
  const refusal = fact.entity === 'refused' ? [fact.record, fact.reason] : null
  return JSON.stringify([fact.entity, fact.action, who, changes, refusal])
}

/** A later change to the same field replaces the earlier one in place. */
function mergeChanges(earlier: Array<FieldChange>, later: Array<FieldChange>) {
  return [...new Map([...earlier, ...later].map((change) => [change.field, change])).values()]
}

/** Two facts with one group key as one. */
function merge(into: ReceiptFact, next: ReceiptFact): ReceiptFact {
  switch (into.entity) {
    case 'refused':
      return next.entity === 'refused' ? { ...into, count: into.count + next.count } : into
    case 'client':
    case 'service':
    case 'profile':
      return next.entity === into.entity
        ? {
            ...into,
            count: into.count + next.count,
            changes: mergeChanges(into.changes, next.changes),
          }
        : into
    case 'appointment':
      return next.entity === 'appointment'
        ? {
            ...into,
            count: into.count + next.count,
            starts_at: null,
            changes: mergeChanges(into.changes, next.changes),
          }
        : into
    case 'payment':
      return next.entity === 'payment'
        ? { ...into, count: into.count + next.count, amount: into.amount + next.amount }
        : into
    case 'series':
      return next.entity === 'series'
        ? {
            ...into,
            weekly: [
              ...new Map(
                [...into.weekly, ...next.weekly].map((slot) => [`${slot.day} ${slot.time}`, slot]),
              ).values(),
            ],
            classes:
              into.classes !== null && next.classes !== null
                ? into.classes + next.classes
                : (into.classes ?? next.classes),
            until: next.until ?? into.until,
            cancelled: into.cancelled + next.cancelled,
            added: into.added + next.added,
            removed: into.removed + next.removed,
            changes: mergeChanges(into.changes, next.changes),
          }
        : into
  }
}

/** One fact per entity, action and client or subject, in first-seen order. */
export function groupFacts(facts: ReadonlyArray<ReceiptFact>): Array<ReceiptFact> {
  const grouped = new Map<string, ReceiptFact>()
  for (const fact of facts) {
    const key = buildFactKey(fact)
    const earlier = grouped.get(key)
    grouped.set(key, earlier ? merge(earlier, fact) : fact)
  }
  return [...grouped.values()]
}

/**
 * The receipt for a run's writes, saved or refused, in the order they
 * happened. Writes from tools it does not know, or whose result it cannot
 * read, leave no fact.
 */
export function buildReceipt(writes: ReadonlyArray<Write>): Array<ReceiptFact> {
  return groupFacts(writes.flatMap((write) => writeToFact(write) ?? []))
}

const receiptCarrier = z.object({ receipt: z.array(z.unknown()) })

/** The facts a persisted execute_typescript output carries; malformed ones are dropped. */
export function parseReceipt(output: JsonValue | undefined): Array<ReceiptFact> {
  const carrier = receiptCarrier.safeParse(output)
  if (!carrier.success) return []
  return carrier.data.receipt.flatMap((raw) => {
    const fact = receiptFact.safeParse(raw)
    return fact.success ? [fact.data] : []
  })
}
