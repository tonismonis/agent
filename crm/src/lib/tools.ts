import {
  DrizzleQueryError,
  and,
  eq,
  gt,
  gte,
  ilike,
  isNull,
  lt,
  sql,
} from 'drizzle-orm'
import { DatabaseError } from 'pg'
import { z } from 'zod'

import { db, withOwnerTxn } from '#/db'
import {
  appointments,
  audit_log,
  clients,
  owners,
  payments,
  services,
} from '#/db/schema'
import {
  refuse,
  RefusalError,
  type ConflictFrame,
  type ProblemFound,
  type RefusalEntity,
} from '#/lib/refusal'
import {
  NonexistentClockTime,
  describeSantiagoTime,
  dateOrTimeInput,
  rangeInput,
  resolveTime,
  santiagoClockOf,
  santiagoDateOf,
  startOf,
  timeInput,
  toRange,
  type Clock,
  type LocalDate,
} from '#/lib/santiago-time'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'

type AuditEntity =
  | 'client'
  | 'service'
  | 'appointment'
  | 'payment'
  | 'owner'

/**
 * What the audit log stores: the JSON a tool was called with or returned, plus
 * the Dates drizzle hands back on a row before it is serialized.
 */
type AuditValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Date
  | Array<AuditValue>
  | AuditObject

type AuditObject = { [key: string]: AuditValue }

/** The object case of an audited value, without discarding the caller's type. */
function isAuditObject<T>(value: T): value is T & AuditObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function containsNotes(value: AuditValue): boolean {
  if (Array.isArray(value)) return value.some(containsNotes)
  if (!isAuditObject(value)) return false
  return Object.entries(value).some(
    ([key, nested]) => key === 'notes' || containsNotes(nested),
  )
}

function redactNotes<T>(value: T): T {
  if (Array.isArray(value)) {
    // SAFETY: mapping every element of an array yields an array of the same type.
    return value.map(redactNotes) as T
  }
  if (!isAuditObject(value) || value instanceof Date) return value
  // SAFETY: rebuilding the object with its own keys, minus the redacted one,
  // keeps the shape the caller passed in.
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'notes')
      .map(([key, nested]) => [key, redactNotes(nested)]),
  ) as T
}

class RestrictedNotesError extends Error {}

/**
 * Failures whose audit row is written and whose own writes are rolled back to
 * their savepoint, so the transaction around them is safe to commit.
 */
const auditedFailures = new WeakSet<Error>()

async function enforceNotesBoundary(input: AuditValue) {
  const [owner] = await db
    .select({ restricted: owners.restricted_notes })
    .from(owners)
    .where(eq(owners.id, sql`current_setting('app.owner_id')::uuid`))
    .limit(1)
  if (!owner) throw new Error('Owner not found')
  if (owner.restricted && containsNotes(input))
    throw new RestrictedNotesError('Notes are disabled for this Owner')
  return owner.restricted
}

/**
 * What a constraint violation means for the caller. Tool code checks first so
 * refusals read well; these are the backstops for races, retries and bugs.
 * CHECK constraints are absent on purpose: zod stops those values first, so a
 * violation is a bug and refuses as internal.
 */
type ConstraintRefusal =
  /** Another write took the time first; writeWithoutClashes re-reads and lists it. */
  | { kind: 'clash' }
  | { kind: 'missing'; entity: RefusalEntity; field: string }
  | { kind: 'fix'; path: string; problem: string }

const refusalByConstraint = new Map<string, ConstraintRefusal>([
  ['appointments_no_overlap', { kind: 'clash' }],
  [
    'appointments_client_owner_fk',
    { kind: 'missing', entity: 'client', field: 'client_id' },
  ],
  [
    'appointments_service_owner_fk',
    { kind: 'missing', entity: 'service', field: 'service_id' },
  ],
  [
    'payments_client_owner_fk',
    { kind: 'missing', entity: 'client', field: 'client_id' },
  ],
  [
    'payments_appointment_owner_fk',
    { kind: 'missing', entity: 'appointment', field: 'appointment_id' },
  ],
  [
    'payments_appointment_client_fk',
    {
      kind: 'fix',
      path: 'appointment_id',
      problem:
        "that appointment belongs to another client; use that client's id or leave appointment_id out",
    },
  ],
])

function driverError<TError>(error: TError) {
  return error instanceof DrizzleQueryError && error.cause instanceof DatabaseError
    ? error.cause
    : null
}

function constraintRefusal<TError>(error: TError) {
  const constraint = driverError(error)?.constraint
  return constraint ? refusalByConstraint.get(constraint) : undefined
}

const looseRecord = z.looseObject({})

/** The number `value` holds under `field`, when it is an object that has one. */
function numberAt<T>(value: T, field: string) {
  const record = looseRecord.safeParse(value)
  const found = z.number().safeParse(record.success ? record.data[field] : null)
  return found.success ? found.data : null
}

/**
 * The single mapping from "something threw" to a refusal. Anything unplanned
 * is `internal`: its technical cause goes to the server log and the audit row,
 * never to the model, since a driver message can carry SQL and notes.
 */
function asRefusal<TError, TInput>(
  error: TError,
  input: TInput,
  write: boolean,
): RefusalError {
  if (error instanceof RefusalError) return error
  if (error instanceof RestrictedNotesError) return refuse.notesOff()
  if (error instanceof NonexistentClockTime)
    return refuse.invalidInput([{ path: '(input)', problem: error.message }])
  const mapped = constraintRefusal(error)
  const missingId = mapped?.kind === 'missing' ? numberAt(input, mapped.field) : null
  if (mapped?.kind === 'missing' && missingId !== null)
    return refuse.notFound(mapped.entity, missingId)
  if (mapped?.kind === 'fix')
    return refuse.invalidInput([{ path: mapped.path, problem: mapped.problem }])
  console.error('tool failed', technicalCause(error))
  return refuse.internal(write)
}

function technicalCause<TError>(error: TError) {
  const driver = driverError(error)
  if (driver) return driver.message
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/** The audit row keeps what the model saw, plus the cause when that was hidden. */
function auditError<TError>(refusal: RefusalError, error: TError) {
  if (refusal.refusal.kind !== 'internal') return refusal.message
  return JSON.stringify({ ...refusal.refusal, cause: technicalCause(error) })
}

/**
 * Zod issues as one refusal: `ask` when every issue is a top-level field the
 * model left out and the tool's guide knows how to ask the Owner for;
 * otherwise `invalid_input` with paths, for the model to fix.
 */
function fromZod<TInput>(
  issues: ReadonlyArray<z.core.$ZodIssue>,
  raw: TInput,
  asks: ReadonlyMap<string, string>,
) {
  const sent = looseRecord.safeParse(raw)
  const missing = issues.map((issue) => {
    if (issue.path.length !== 1) return null
    const field = String(issue.path[0])
    const present = sent.success && sent.data[field] !== undefined
    const question = asks.get(field)
    return present || !question ? null : { field, question }
  })
  if (missing.length > 0 && missing.every((each) => each !== null)) {
    const fields = [...new Map(missing.map((each) => [each.field, each.question]))]
    return refuse.askFor(
      fields.map(([field]) => field),
      fields.map(([, question]) => question),
    )
  }
  return refuse.invalidInput(
    issues.map((issue) => ({
      path: issue.path.join('.') || '(input)',
      problem: issue.message,
    })),
  )
}

/**
 * Owner-facing Spanish beside each tool. `asks` phrases the question for a
 * required field the model left out; the whole guide also documents the tool
 * for the Owner.
 */
export type ToolGuide<TInput> = {
  does: string
  asks?: Partial<{ [field in keyof TInput & string]: string }>
  wont?: string
}

export type CrmTool<TSchema extends z.ZodType, TOutput extends z.ZodType, TResult> = {
  name: string
  /** Model-facing English. */
  description: string
  guide: ToolGuide<z.input<TSchema>>
  inputSchema: TSchema
  outputSchema: TOutput
  /** Parses its own input; throws only RefusalError. */
  execute: (input: z.input<TSchema>) => Promise<TResult>
}

function asksOf<TInput>(guide: ToolGuide<TInput>) {
  return new Map<string, string>(
    Object.entries(guide.asks ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
}

function parseInput<TSchema extends z.ZodType>(
  schema: TSchema,
  raw: z.input<TSchema>,
  guide: ToolGuide<z.input<TSchema>>,
) {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw fromZod(parsed.error.issues, raw, asksOf(guide))
  return parsed.data
}

/** A write that resolved no row: the id it named does not exist for this Owner. */
function missingRecord<TInput>(entity: AuditEntity, input: TInput) {
  const id = numberAt(input, 'id')
  if (entity !== 'owner' && id !== null) return refuse.notFound(entity, id)
  return refuse.internal(true)
}

/**
 * An audited write. Invalid input refuses before anything runs, so it writes
 * no audit row. Everything after runs in a savepoint: a failure rolls back
 * alone and leaves the transaction able to record it.
 */
function writeTool<
  TSchema extends z.ZodType,
  TOutput extends z.ZodType,
  TResult,
  TBefore = null,
>(spec: {
  name: string
  entity: AuditEntity
  description: string
  guide: ToolGuide<z.input<TSchema>>
  input: TSchema
  output: TOutput
  before?: (input: z.output<TSchema>) => Promise<TBefore>
  run: (input: z.output<TSchema>) => Promise<TResult | undefined>
}): CrmTool<TSchema, TOutput, TResult> {
  return {
    name: spec.name,
    description: spec.description,
    guide: spec.guide,
    inputSchema: spec.input,
    outputSchema: spec.output,
    execute: async (raw) => {
      const input = parseInput(spec.input, raw, spec.guide)
      // SAFETY: a tool input is the JSON the model called the tool with.
      const audited = raw as AuditValue
      let before: TBefore | null = null
      let entityId = numberAt(input, 'id')
      let restricted = false
      try {
        return await db.transaction(async () => {
          restricted = await enforceNotesBoundary(audited)
          before = spec.before ? await spec.before(input) : null
          if (restricted) before = redactNotes(before)
          const result = await spec.run(input)
          if (result === undefined) throw missingRecord(spec.entity, input)
          entityId = numberAt(result, 'id') ?? entityId
          await db.insert(audit_log).values({
            tool_name: spec.name,
            input: restricted ? redactNotes(audited) : audited,
            entity: spec.entity,
            entity_id: entityId,
            before,
            ok: true,
            error: null,
          })
          return restricted ? redactNotes(result) : result
        })
      } catch (error) {
        const refusal = asRefusal(error, input, true)
        if (error instanceof RestrictedNotesError) restricted = true
        await db.insert(audit_log).values({
          tool_name: spec.name,
          input: restricted ? redactNotes(audited) : audited,
          entity: spec.entity,
          entity_id: entityId,
          before,
          ok: false,
          error: auditError(refusal, error),
        })
        auditedFailures.add(refusal)
        throw refusal
      }
    },
  }
}

/** A read: parsed, notes-bounded, never audited. */
function readTool<TSchema extends z.ZodType, TOutput extends z.ZodType, TResult>(spec: {
  name: string
  description: string
  guide: ToolGuide<z.input<TSchema>>
  input: TSchema
  output: TOutput
  run: (input: z.output<TSchema>) => Promise<TResult>
}): CrmTool<TSchema, TOutput, TResult> {
  return {
    name: spec.name,
    description: spec.description,
    guide: spec.guide,
    inputSchema: spec.input,
    outputSchema: spec.output,
    execute: async (raw) => {
      const input = parseInput(spec.input, raw, spec.guide)
      try {
        // SAFETY: a tool input is the JSON the model called the tool with.
        const restricted = await enforceNotesBoundary(raw as AuditValue)
        const result = await spec.run(input)
        return restricted ? redactNotes(result) : result
      } catch (error) {
        throw asRefusal(error, input, false)
      }
    },
  }
}

/**
 * Run one tool call in its own Owner transaction. A failure the audit log has
 * recorded commits that record before it is rethrown; any other failure rolls
 * the whole call back.
 */
export async function runOwnerTool<TResult>(
  ownerId: string,
  operation: () => Promise<TResult>,
) {
  const outcome = await withOwnerTxn(ownerId, async () => {
    try {
      return { ok: true as const, value: await operation() }
    } catch (error) {
      if (error instanceof Error && auditedFailures.has(error)) {
        return { ok: false as const, error }
      }
      throw error
    }
  })
  if (!outcome.ok) throw outcome.error
  return outcome.value
}

/**
 * The rows as a tool hands them back: JSON, not drizzle values, because the
 * binding serializes a result before the model — and before this schema — sees
 * it. So every timestamp is an ISO 8601 instant in UTC, and `notes` is absent
 * rather than null when the Owner has notes restricted.
 */
const timestamp = z.iso.datetime()
const deletedAt = timestamp
  .nullable()
  .describe('Soft-delete instant; null while the record is live')
const notes = z
  .string()
  .nullable()
  .optional()
  .describe('Absent when the Owner has notes restricted')
const clp = z.number().int().describe('Whole CLP')

const clientRecord = z.object({
  id: z.number().int(),
  owner_id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  notes,
  created_at: timestamp,
  updated_at: timestamp,
  deleted_at: deletedAt,
})

const serviceRecord = z.object({
  id: z.number().int(),
  owner_id: z.string(),
  name: z.string(),
  price: clp.describe('Whole CLP per hour when unit is "hour", otherwise total'),
  unit: z.enum(['hour', 'flat']),
  duration_minutes: z
    .number()
    .int()
    .nullable()
    .describe('Default appointment length; null when the service has none'),
  created_at: timestamp,
  updated_at: timestamp,
  deleted_at: deletedAt,
})

const appointmentRecord = z.object({
  id: z.number().int(),
  owner_id: z.string(),
  client_id: z.number().int(),
  service_id: z.number().int(),
  starts_at: timestamp,
  ends_at: timestamp,
  mode: z.enum(['online', 'in_person']),
  status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']),
  price: clp.describe('Whole CLP snapshotted when the appointment was booked'),
  notes,
  created_at: timestamp,
  updated_at: timestamp,
  deleted_at: deletedAt,
})

const paymentRecord = z.object({
  id: z.number().int(),
  owner_id: z.string(),
  client_id: z.number().int(),
  appointment_id: z
    .number()
    .int()
    .nullable()
    .describe('Appointment the payment settles; null when unattached'),
  amount: clp,
  paid_at: timestamp.describe('When the money was received'),
  notes,
  created_at: timestamp,
  updated_at: timestamp,
  deleted_at: deletedAt,
})

const auditRecord = z.object({
  id: z.number().int(),
  owner_id: z.string(),
  tool_name: z.string(),
  input: z.unknown().describe('The JSON the tool was called with'),
  entity: z.string(),
  entity_id: z
    .number()
    .int()
    .nullable()
    .describe('Row the write touched; null when it never resolved one'),
  before: z.unknown().describe('The record as it read before the write, or null'),
  ok: z.boolean(),
  error: z.string().nullable(),
  ts: timestamp,
})

const listAuditLogInput = z
  .object({
    entity: z
      .enum(['client', 'service', 'appointment', 'payment', 'owner'])
      .optional(),
    entity_id: z.number().optional(),
    since: rangeInput.optional(),
    until: rangeInput.optional(),
    ok: z.boolean().optional(),
    all: z.literal(true).optional(),
  })
  .refine(
    ({ entity, entity_id, since, until, ok, all }) =>
      all === true ||
      entity !== undefined ||
      entity_id !== undefined ||
      since !== undefined ||
      until !== undefined ||
      ok !== undefined,
    { message: 'Provide a filter or all: true' },
  )

export const listAuditLog = readTool({
  name: 'listAuditLog',
  description:
    'List audit records by entity, entity ID, timestamp range, or outcome. Pass all: true for every record.',
  guide: {
    does: 'Muestra el historial de lo que se guardó, para revisar o deshacer un cambio.',
  },
  input: listAuditLogInput,
  output: z.array(auditRecord),
  run: async ({ entity, entity_id, since, until, ok }) => {
    const { start, end } = toRange(since, until)
    return db
      .select()
      .from(audit_log)
      .where(
        and(
          entity ? eq(audit_log.entity, entity) : undefined,
          entity_id !== undefined
            ? eq(audit_log.entity_id, entity_id)
            : undefined,
          start ? gte(audit_log.ts, start) : undefined,
          end ? lt(audit_log.ts, end) : undefined,
          ok !== undefined ? eq(audit_log.ok, ok) : undefined,
        ),
      )
  },
})

const updateOwnerProfileInput = z.object({ name: z.string().min(1) }).strict()

export const updateOwnerProfile = writeTool({
  name: 'update_owner_profile',
  entity: 'owner',
  description: "Update the Owner's name. Other profile fields are operator-only.",
  guide: {
    does: 'Cambia tu nombre.',
    asks: { name: '¿Qué nombre quieres que use?' },
  },
  input: updateOwnerProfileInput,
  output: z.object({ name: z.string(), updated_at: timestamp }),
  before: async () => {
    const [owner] = await db
      .select({ name: owners.name })
      .from(owners)
      .where(eq(owners.id, sql`current_setting('app.owner_id')::uuid`))
    return owner
  },
  run: async ({ name }) => {
    const [owner] = await db
      .update(owners)
      .set({ name, updated_at: sql`now()` })
      .where(eq(owners.id, sql`current_setting('app.owner_id')::uuid`))
      .returning({ name: owners.name, updated_at: owners.updated_at })
    return owner
  },
})

const createClientInput = z.object({
  name: z.string(),
  email: z.string().optional(),
  phone: z.string().optional(),
  notes: z.string().optional(),
})

export const createClient = writeTool({
  name: 'createClient',
  entity: 'client',
  description: 'Create a client',
  guide: {
    does: 'Guarda un cliente nuevo con su nombre y, si quieres, correo, teléfono y notas.',
    asks: { name: '¿Cómo se llama?' },
  },
  input: createClientInput,
  output: clientRecord,
  run: async (values) => {
    const [client] = await db.insert(clients).values(values).returning()
    return client
  },
})

const createServiceInput = z.object({
  name: z.string(),
  price: z.number().int().positive(),
  unit: z.enum(['hour', 'flat']),
  duration_minutes: z.number().int().positive().optional(),
})

export const createService = writeTool({
  name: 'createService',
  entity: 'service',
  description: 'Create a service',
  guide: {
    does: 'Agrega un servicio a tu catálogo, con precio por hora o precio fijo y, si quieres, cuánto dura.',
    asks: {
      name: '¿Cómo se llama el servicio?',
      price: '¿Cuánto cobras?',
      unit: '¿Cobras por hora o un precio fijo?',
    },
  },
  input: createServiceInput,
  output: serviceRecord,
  run: async (values) => {
    const [service] = await db.insert(services).values(values).returning()
    return service
  },
})

const findServicesInput = z.object({
  query: z.string().optional(),
})

export const findServices = readTool({
  name: 'findServices',
  description: 'Find active services by name',
  guide: { does: 'Busca servicios de tu catálogo por nombre.' },
  input: findServicesInput,
  output: z.array(serviceRecord),
  run: async ({ query }) =>
    db
      .select()
      .from(services)
      .where(
        and(
          isNull(services.deleted_at),
          query ? ilike(services.name, `%${query}%`) : undefined,
        ),
      ),
})

const updateServiceInput = z.object({
  id: z.number(),
  name: z.string().optional(),
  price: z.number().int().positive().optional(),
  unit: z.enum(['hour', 'flat']).optional(),
  duration_minutes: z.number().int().positive().optional(),
})

export const updateService = writeTool({
  name: 'updateService',
  entity: 'service',
  description: 'Update a service',
  guide: {
    does: 'Cambia el nombre, precio, unidad o duración de un servicio.',
    wont: 'No cambia el precio de las citas ya agendadas.',
  },
  input: updateServiceInput,
  output: serviceRecord,
  before: findService,
  run: async ({ id, ...fields }) => {
    const [service] = await db
      .update(services)
      .set({ ...fields, updated_at: sql`now()` })
      .where(eq(services.id, id))
      .returning()
    return service
  },
})

const softDeleteServiceInput = z.object({
  id: z.number(),
})

export const softDeleteService = writeTool({
  name: 'softDeleteService',
  entity: 'service',
  description: 'Soft delete a service',
  guide: { does: 'Saca un servicio del catálogo. Se puede recuperar.' },
  input: softDeleteServiceInput,
  output: serviceRecord,
  before: findService,
  run: async ({ id }) => {
    const [service] = await db
      .update(services)
      .set({ deleted_at: sql`now()` })
      .where(eq(services.id, id))
      .returning()
    return service
  },
})

const restoreServiceInput = z.object({ id: z.number() })

export const restoreService = writeTool({
  name: 'restoreService',
  entity: 'service',
  description: 'Restore a soft-deleted service',
  guide: { does: 'Recupera un servicio borrado.' },
  input: restoreServiceInput,
  output: serviceRecord,
  before: findService,
  run: async ({ id }) => {
    const [service] = await db
      .update(services)
      .set({ deleted_at: null })
      .where(eq(services.id, id))
      .returning()
    return service
  },
})

const updateClientInput = z.object({
  id: z.number(),
  name: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  notes: z.string().optional(),
})

export const updateClient = writeTool({
  name: 'updateClient',
  entity: 'client',
  description: 'Update a client',
  guide: { does: 'Cambia el nombre, correo, teléfono o notas de un cliente.' },
  input: updateClientInput,
  output: clientRecord,
  before: findClient,
  run: async ({ id, ...fields }) => {
    const [client] = await db
      .update(clients)
      .set({ ...fields, updated_at: sql`now()` })
      .where(eq(clients.id, id))
      .returning()
    return client
  },
})

const softDeleteClientInput = z.object({
  id: z.number(),
})

export const softDeleteClient = writeTool({
  name: 'softDeleteClient',
  entity: 'client',
  description:
    'Soft delete a client. Refused while the client has scheduled appointments from now on.',
  guide: {
    does: 'Borra un cliente. Se puede recuperar.',
    wont: 'No borra a alguien con citas agendadas desde hoy: primero hay que cancelarlas o borrarlas.',
  },
  input: softDeleteClientInput,
  output: clientRecord,
  before: findClient,
  run: async ({ id }) => {
    const client = await findClient({ id })
    if (!client) return undefined
    const upcoming = await db
      .select({ id: appointments.id, starts_at: appointments.starts_at })
      .from(appointments)
      .where(
        and(
          eq(appointments.client_id, id),
          eq(appointments.status, 'scheduled'),
          gt(appointments.starts_at, sql`now()`),
          isNull(appointments.deleted_at),
        ),
      )
      .orderBy(appointments.starts_at)
    if (upcoming.length)
      throw refuse.clientHasFutureAppointments(
        client.name,
        upcoming.map((appointment) => ({
          ...appointment,
          series_id: null,
          series_rule: null,
        })),
      )
    const [deleted] = await db
      .update(clients)
      .set({ deleted_at: sql`now()` })
      .where(eq(clients.id, id))
      .returning()
    return deleted
  },
})

const restoreClientInput = z.object({ id: z.number() })

export const restoreClient = writeTool({
  name: 'restoreClient',
  entity: 'client',
  description: 'Restore a soft-deleted client',
  guide: { does: 'Recupera un cliente borrado.' },
  input: restoreClientInput,
  output: clientRecord,
  before: findClient,
  run: async ({ id }) => {
    const [client] = await db
      .update(clients)
      .set({ deleted_at: null })
      .where(eq(clients.id, id))
      .returning()
    return client
  },
})

async function findPayment({ id }: { id: number }) {
  const [payment] = await db.select().from(payments).where(eq(payments.id, id))
  return payment
}

async function findService({ id }: { id: number }) {
  const [service] = await db.select().from(services).where(eq(services.id, id))
  return service
}

async function findClient({ id }: { id: number }) {
  const [client] = await db.select().from(clients).where(eq(clients.id, id))
  return client
}

async function findAppointment({ id }: { id: number }) {
  const [appointment] = await db
    .select()
    .from(appointments)
    .where(eq(appointments.id, id))
  return appointment
}

const findAppointmentsInput = z.object({
  client_id: z.number().optional(),
  from: rangeInput.optional(),
  to: rangeInput.optional(),
  status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']).optional(),
})

export const findAppointments = readTool({
  name: 'findAppointments',
  description:
    'Find appointments by client, time range and status. Returns every appointment that occupies any part of [from, to), earliest first. starts_local and ends_local are the times as the Owner reads them in America/Santiago; use them when talking to the Owner.',
  guide: { does: 'Muestra las citas de un cliente o de un período.' },
  input: findAppointmentsInput,
  output: z.array(
    appointmentRecord.extend({
      starts_local: z.string().describe('e.g. jueves 1 de octubre, 17:00'),
      ends_local: z.string(),
    }),
  ),
  run: async ({ client_id, from, to, status }) => {
    const { start, end } = toRange(from, to)
    const rows = await db
      .select()
      .from(appointments)
      .where(
        and(
          isNull(appointments.deleted_at),
          client_id ? eq(appointments.client_id, client_id) : undefined,
          start ? gt(appointments.ends_at, start) : undefined,
          end ? lt(appointments.starts_at, end) : undefined,
          status ? eq(appointments.status, status) : undefined,
        ),
      )
      .orderBy(appointments.starts_at)
    return rows.map((row) => ({
      ...row,
      starts_local: describeSantiagoTime(row.starts_at),
      ends_local: describeSantiagoTime(row.ends_at),
    }))
  },
})

const updateAppointmentInput = z.object({
  id: z.number(),
  starts_at: timeInput.optional(),
  duration_minutes: z.number().int().positive().optional(),
  status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']).optional(),
  price: z.number().int().nonnegative().optional(),
  mode: z.enum(['online', 'in_person']).optional(),
  notes: z.string().optional(),
})

export const updateAppointment = writeTool({
  name: 'updateAppointment',
  entity: 'appointment',
  description:
    'Update an appointment. A new time is refused when it collides with another scheduled appointment; the refusal says with which.',
  guide: {
    does: 'Cambia la hora, duración, estado, precio, modalidad o notas de una cita.',
    wont: 'No la mueve a una hora que choca con otra cita.',
  },
  input: updateAppointmentInput,
  output: appointmentRecord,
  before: findAppointment,
  run: async ({ id, starts_at, duration_minutes, ...fields }) => {
    const existing = await findAppointment({ id })
    if (!existing) return undefined
    const set: PgUpdateSetSource<typeof appointments> = {
      ...fields,
      updated_at: sql`now()`,
    }
    const update = async () => {
      const [appointment] = await db
        .update(appointments)
        .set(set)
        .where(eq(appointments.id, id))
        .returning()
      return appointment
    }
    const moving = starts_at !== undefined || duration_minutes !== undefined
    if (!moving && fields.status !== 'scheduled') return update()
    const at = starts_at
      ? resolveTime(starts_at)
      : {
          date: santiagoDateOf(existing.starts_at),
          time: santiagoClockOf(existing.starts_at),
          instant: existing.starts_at,
        }
    const minutes =
      duration_minutes ??
      (existing.ends_at.getTime() - existing.starts_at.getTime()) / 60_000
    return writeWithoutClashes(
      'move',
      [{ date: at.date, time: at.time, span: spanOf(at.instant, minutes) }],
      async ([placed]) => {
        if (moving && placed) {
          set.starts_at = placed.span.starts_at
          set.ends_at = placed.span.ends_at
        }
        return update()
      },
      { ignore: [id] },
    )
  },
})

const softDeleteAppointmentInput = z.object({
  id: z.number(),
})

export const softDeleteAppointment = writeTool({
  name: 'softDeleteAppointment',
  entity: 'appointment',
  description:
    'Soft delete an appointment booked by mistake. A cancelled appointment is a status: use updateAppointment for that.',
  guide: {
    does: 'Borra una cita agendada por error. Se puede recuperar.',
    wont: 'Una cita cancelada no se borra: queda marcada como cancelada.',
  },
  input: softDeleteAppointmentInput,
  output: appointmentRecord,
  before: findAppointment,
  run: async ({ id }) => {
    const [appointment] = await db
      .update(appointments)
      .set({ deleted_at: sql`now()` })
      .where(eq(appointments.id, id))
      .returning()
    return appointment
  },
})

const restoreAppointmentInput = z.object({ id: z.number() })

export const restoreAppointment = writeTool({
  name: 'restoreAppointment',
  entity: 'appointment',
  description:
    'Restore a soft-deleted appointment. Refused when its time now collides with another scheduled appointment.',
  guide: {
    does: 'Recupera una cita borrada.',
    wont: 'No la recupera si su hora ya está ocupada.',
  },
  input: restoreAppointmentInput,
  output: appointmentRecord,
  before: findAppointment,
  run: async ({ id }) => {
    const existing = await findAppointment({ id })
    if (!existing) return undefined
    return writeWithoutClashes(
      'restore',
      [
        {
          date: santiagoDateOf(existing.starts_at),
          time: santiagoClockOf(existing.starts_at),
          span: { starts_at: existing.starts_at, ends_at: existing.ends_at },
        },
      ],
      async () => {
        const [appointment] = await db
          .update(appointments)
          .set({ deleted_at: null })
          .where(eq(appointments.id, id))
          .returning()
        return appointment
      },
      { ignore: [id] },
    )
  },
})

const findClientsInput = z.object({
  query: z.string().optional(),
})

export const findClients = readTool({
  name: 'findClients',
  description: 'Find active clients by name',
  guide: { does: 'Busca clientes por nombre.' },
  input: findClientsInput,
  output: z.array(clientRecord),
  run: async ({ query }) =>
    db
      .select()
      .from(clients)
      .where(
        and(
          isNull(clients.deleted_at),
          query ? ilike(clients.name, `%${query}%`) : undefined,
        ),
      ),
})

type Span = { starts_at: Date; ends_at: Date }

/** One time a write asks for. `span` is null when that clock time is skipped. */
type Wanted = { date: LocalDate; time: Clock; span: Span | null }
type Placed = Wanted & { span: Span }

function isPlaced(wanted: Wanted): wanted is Placed {
  return wanted.span !== null
}

function spanOf(starts_at: Date | null, minutes: number): Span | null {
  if (!starts_at) return null
  return {
    starts_at,
    ends_at: new Date(starts_at.getTime() + minutes * 60_000),
  }
}

const clashRow = z.object({
  i: z.number().int(),
  id: z.number().int(),
  starts_at: z.coerce.date(),
  ends_at: z.coerce.date(),
  name: z.string(),
})

/**
 * Every scheduled, live appointment that overlaps any wanted span, in one
 * statement. Half-open intervals; RLS scopes it to the Owner. `ignore` holds
 * the appointments being moved or restored, which never clash with themselves.
 */
async function findClashes(
  placed: ReadonlyArray<Placed>,
  ignore: ReadonlyArray<number>,
): Promise<Array<ProblemFound>> {
  if (placed.length === 0) return []
  const spans = JSON.stringify(
    placed.map((each, i) => ({
      i,
      s: each.span.starts_at.toISOString(),
      e: each.span.ends_at.toISOString(),
    })),
  )
  const result = await db.execute(sql`
    select r.i, a.id, a.starts_at, a.ends_at, c.name
    from jsonb_to_recordset(${spans}::jsonb) as r(i int, s timestamptz, e timestamptz)
    join ${appointments} a on a.starts_at < r.e and a.ends_at > r.s
    join ${clients} c on c.id = a.client_id and c.owner_id = a.owner_id
    where a.status = 'scheduled'
      and a.deleted_at is null
      and not (${JSON.stringify(ignore)}::jsonb @> to_jsonb(a.id))
    order by r.i, a.starts_at
  `)
  return z
    .array(clashRow)
    .parse(result.rows)
    .flatMap((row) => {
      const wanted = placed[row.i]
      if (!wanted) return []
      return [
        {
          date: wanted.date,
          time: wanted.time,
          problem: 'taken' as const,
          with: {
            appointment_id: row.id,
            client: row.name,
            starts_at: row.starts_at,
            ends_at: row.ends_at,
          },
        },
      ]
    })
}

/**
 * All of these times are the Owner's, or a conflict listing every problem:
 * skipped clock hours, the `known` problems the caller found itself, and every
 * scheduled appointment in the way. Only then does `write` run, in a nested
 * savepoint. A concurrent booking that slips past the check trips a clash
 * constraint; it is re-read, now committed, and reported with its dates.
 */
async function writeWithoutClashes<T>(
  frame: ConflictFrame,
  wanted: ReadonlyArray<Wanted>,
  write: (placed: Array<Placed>) => Promise<T>,
  options: {
    known?: ReadonlyArray<ProblemFound>
    ignore?: ReadonlyArray<number>
    priorSkip?: ReadonlyArray<LocalDate>
  } = {},
): Promise<T> {
  const { known = [], ignore = [], priorSkip = [] } = options
  const placed = wanted.filter(isPlaced)
  const problems: Array<ProblemFound> = [
    ...known,
    ...wanted
      .filter((each) => !isPlaced(each))
      .map((each) => ({
        date: each.date,
        time: each.time,
        problem: 'no_such_hour' as const,
      })),
    ...(await findClashes(placed, ignore)),
  ]
  if (problems.length)
    throw refuse.conflict(frame, wanted.length, problems, priorSkip)
  try {
    return await db.transaction(() => write(placed))
  } catch (error) {
    if (constraintRefusal(error)?.kind !== 'clash') throw error
    const late = await findClashes(placed, ignore)
    if (late.length === 0) throw error
    throw refuse.conflict(frame, wanted.length, late, priorSkip)
  }
}

/** A class's price: flat services charge once, hourly ones by the minute. */
function classPrice(
  service: { unit: 'hour' | 'flat'; price: number },
  minutes: number,
) {
  return service.unit === 'flat'
    ? service.price
    : Math.round((minutes / 60) * service.price)
}

const createAppointmentInput = z.object({
  client_id: z.number(),
  service_id: z.number(),
  starts_at: timeInput,
  duration_minutes: z.number().int().positive().optional(),
  price: z.number().int().nonnegative().optional(),
  mode: z.enum(['online', 'in_person']),
  notes: z.string().optional(),
})

export const createAppointment = writeTool({
  name: 'createAppointment',
  entity: 'appointment',
  description:
    'Book an appointment at a time the Owner stated. Refused when it collides with another scheduled appointment; the refusal says with which.',
  guide: {
    does: 'Agenda una cita con un cliente, el día y a la hora que tú dices.',
    asks: {
      client_id: '¿Con quién es la cita?',
      service_id: '¿Qué servicio es?',
      starts_at: '¿Qué día y a qué hora?',
      mode: '¿Es online o presencial?',
    },
    wont: 'No propone horas. Si la hora choca con otra cita, te dice con cuál.',
  },
  input: createAppointmentInput,
  output: appointmentRecord,
  run: async (input) => {
    const [service] = await db
      .select()
      .from(services)
      .where(and(eq(services.id, input.service_id), isNull(services.deleted_at)))
    if (!service) throw refuse.notFound('service', input.service_id)
    const minutes = input.duration_minutes ?? service.duration_minutes
    if (minutes == null) throw refuse.askDuration(service.name)
    const at = resolveTime(input.starts_at)
    return writeWithoutClashes(
      'book',
      [{ date: at.date, time: at.time, span: spanOf(at.instant, minutes) }],
      async (placed) => {
        const [appointment] = await db
          .insert(appointments)
          .values(
            placed.map(({ span }) => ({
              client_id: input.client_id,
              service_id: input.service_id,
              starts_at: span.starts_at,
              ends_at: span.ends_at,
              mode: input.mode,
              price: input.price ?? classPrice(service, minutes),
              notes: input.notes,
            })),
          )
          .returning()
        return appointment
      },
    )
  },
})

const createPaymentInput = z.object({
  client_id: z.number(),
  amount: z.number().int().positive(),
  paid_at: dateOrTimeInput.optional(),
  appointment_id: z.number().optional(),
  notes: z.string().optional(),
})

export const createPayment = writeTool({
  name: 'createPayment',
  entity: 'payment',
  description: 'Record a payment received from a client',
  guide: {
    does: 'Anota un pago que recibiste de un cliente, suelto o por una cita.',
    asks: { client_id: '¿Quién te pagó?', amount: '¿Cuánto te pagó?' },
  },
  input: createPaymentInput,
  output: paymentRecord,
  run: async ({ paid_at, ...rest }) => {
    const [payment] = await db
      .insert(payments)
      .values({ ...rest, paid_at: paid_at ? startOf(paid_at) : new Date() })
      .returning()
    return payment
  },
})

const findPaymentsInput = z.object({
  client_id: z.number().optional(),
  from: rangeInput.optional(),
  to: rangeInput.optional(),
})

export const findPayments = readTool({
  name: 'findPayments',
  description: 'Find payments by client and paid_at range',
  guide: { does: 'Muestra los pagos de un cliente o de un período.' },
  input: findPaymentsInput,
  output: z.array(paymentRecord),
  run: async ({ client_id, from, to }) => {
    const { start, end } = toRange(from, to)
    return db
      .select()
      .from(payments)
      .where(
        and(
          isNull(payments.deleted_at),
          client_id ? eq(payments.client_id, client_id) : undefined,
          start ? gte(payments.paid_at, start) : undefined,
          end ? lt(payments.paid_at, end) : undefined,
        ),
      )
  },
})

const updatePaymentInput = z.object({
  id: z.number(),
  amount: z.number().int().positive().optional(),
  paid_at: dateOrTimeInput.optional(),
  appointment_id: z.number().optional(),
  notes: z.string().optional(),
})

export const updatePayment = writeTool({
  name: 'updatePayment',
  entity: 'payment',
  description: 'Update a payment',
  guide: { does: 'Corrige el monto, la fecha, la cita o las notas de un pago.' },
  input: updatePaymentInput,
  output: paymentRecord,
  before: findPayment,
  run: async ({ id, paid_at, ...fields }) => {
    const set: PgUpdateSetSource<typeof payments> = {
      ...fields,
      updated_at: sql`now()`,
    }
    if (paid_at) set.paid_at = startOf(paid_at)
    const [payment] = await db
      .update(payments)
      .set(set)
      .where(eq(payments.id, id))
      .returning()
    return payment
  },
})

const softDeletePaymentInput = z.object({
  id: z.number(),
})

export const softDeletePayment = writeTool({
  name: 'softDeletePayment',
  entity: 'payment',
  description: 'Soft delete a payment',
  guide: { does: 'Borra un pago anotado por error. Se puede recuperar.' },
  input: softDeletePaymentInput,
  output: paymentRecord,
  before: findPayment,
  run: async ({ id }) => {
    const [payment] = await db
      .update(payments)
      .set({ deleted_at: sql`now()` })
      .where(eq(payments.id, id))
      .returning()
    return payment
  },
})

const restorePaymentInput = z.object({ id: z.number() })

export const restorePayment = writeTool({
  name: 'restorePayment',
  entity: 'payment',
  description: 'Restore a soft-deleted payment',
  guide: { does: 'Recupera un pago borrado.' },
  input: restorePaymentInput,
  output: paymentRecord,
  before: findPayment,
  run: async ({ id }) => {
    const [payment] = await db
      .update(payments)
      .set({ deleted_at: null })
      .where(eq(payments.id, id))
      .returning()
    return payment
  },
})
