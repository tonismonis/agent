import {
  DrizzleQueryError,
  and,
  eq,
  gt,
  gte,
  ilike,
  isNull,
  lt,
  ne,
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
  describeSantiagoSpan,
  describeSantiagoTime,
  rangeInput,
  timeInput,
  toInstant,
  toRange,
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

/** True for the rows and inputs that carry the numeric primary key. */
function hasNumericId<T>(value: T): value is T & { id: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'number'
  )
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

/**
 * drizzle's own message is the SQL plus every parameter, notes included; the
 * driver error underneath says what actually went wrong.
 */
function describeQueryError(error: DrizzleQueryError) {
  const cause = error.cause
  if (!(cause instanceof DatabaseError)) return 'Database write failed'
  // A concurrent booking that slipped past assertNoOverlap.
  if (cause.constraint === 'appointments_no_overlap')
    return 'Time conflict with another appointment'
  return cause.message
}

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

function auditedExecute<TSchema extends z.ZodType, TResult, TBefore = null>(
  toolName: string,
  entity: AuditEntity,
  schema: TSchema,
  operation: (input: z.output<TSchema>) => Promise<TResult>,
  getBefore?: (input: z.output<TSchema>) => Promise<TBefore>,
) {
  return async (input: z.input<TSchema>) => {
    let before: TBefore | null = null
    let entityId: number | null = null
    let restricted = false
    try {
      // A savepoint, so a failed write — even one that errored in Postgres —
      // rolls back alone and leaves the transaction able to record it.
      return await db.transaction(async () => {
        // SAFETY: a tool input is the JSON the model called the tool with.
        restricted = await enforceNotesBoundary(input as AuditValue)
        const parsed = schema.parse(input)
        if (hasNumericId(parsed)) entityId = parsed.id
        before = getBefore ? await getBefore(parsed) : null
        if (restricted) before = redactNotes(before)
        const result = await operation(parsed)
        if (hasNumericId(result)) entityId = result.id
        await db.insert(audit_log).values({
          tool_name: toolName,
          input: restricted ? redactNotes(input) : input,
          entity,
          entity_id: entityId,
          before,
          ok: true,
          error: null,
        })
        return restricted ? redactNotes(result) : result
      })
    } catch (error) {
      if (error instanceof RestrictedNotesError) restricted = true
      const failure =
        error instanceof DrizzleQueryError
          ? new Error(describeQueryError(error), { cause: error })
          : error
      await db.insert(audit_log).values({
        tool_name: toolName,
        input: restricted ? redactNotes(input) : input,
        entity,
        entity_id: entityId,
        before,
        ok: false,
        error: failure instanceof Error ? failure.message : String(failure),
      })
      const recorded =
        failure instanceof Error ? failure : new Error(String(failure))
      auditedFailures.add(recorded)
      throw recorded
    }
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

function parsedExecute<TSchema extends z.ZodType, TResult>(
  schema: TSchema,
  operation: (input: z.output<TSchema>) => Promise<TResult>,
) {
  return async (input: z.input<TSchema>) => {
    // SAFETY: a tool input is the JSON the model called the tool with.
    const restricted = await enforceNotesBoundary(input as AuditValue)
    const parsed = schema.parse(input)
    const result = await operation(parsed)
    return restricted ? redactNotes(result) : result
  }
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
    entity: z.enum(['client', 'service', 'appointment', 'payment']).optional(),
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

export const listAuditLog = {
  name: 'listAuditLog',
  description:
    'List audit records by entity, entity ID, timestamp range, or outcome. Pass all: true for every record.',
  inputSchema: listAuditLogInput,
  outputSchema: z.array(auditRecord),
  execute: parsedExecute(
    listAuditLogInput,
    async ({ entity, entity_id, since, until, ok }) => {
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
  ),
}

const updateOwnerProfileInput = z.object({ name: z.string().min(1) }).strict()

export const updateOwnerProfile = {
  name: 'update_owner_profile',
  description: "Update the Owner's name. Other profile fields are operator-only.",
  inputSchema: updateOwnerProfileInput,
  outputSchema: z.object({ name: z.string(), updated_at: timestamp }).optional(),
  execute: auditedExecute(
    'update_owner_profile',
    'owner',
    updateOwnerProfileInput,
    async ({ name }) => {
      const [owner] = await db
        .update(owners)
        .set({ name, updated_at: sql`now()` })
        .where(eq(owners.id, sql`current_setting('app.owner_id')::uuid`))
        .returning({ name: owners.name, updated_at: owners.updated_at })
      return owner
    },
    async () => {
      const [owner] = await db
        .select({ name: owners.name })
        .from(owners)
        .where(eq(owners.id, sql`current_setting('app.owner_id')::uuid`))
      return owner
    },
  ),
}

const createClientInput = z.object({
  name: z.string(),
  email: z.string().optional(),
  phone: z.string().optional(),
  notes: z.string().optional(),
})

export const createClient = {
  name: 'createClient',
  description: 'Create a client',
  inputSchema: createClientInput,
  outputSchema: clientRecord,
  execute: auditedExecute(
    'createClient',
    'client',
    createClientInput,
    async (values) => {
      const [client] = await db.insert(clients).values(values).returning()
      return client
    },
  ),
}

const createServiceInput = z.object({
  name: z.string(),
  price: z.number().int().positive(),
  unit: z.enum(['hour', 'flat']),
  duration_minutes: z.number().int().positive().optional(),
})

export const createService = {
  name: 'createService',
  description: 'Create a service',
  inputSchema: createServiceInput,
  outputSchema: serviceRecord,
  execute: auditedExecute(
    'createService',
    'service',
    createServiceInput,
    async (values) => {
      const [service] = await db.insert(services).values(values).returning()
      return service
    },
  ),
}

const findServicesInput = z.object({
  query: z.string().optional(),
})

export const findServices = {
  name: 'findServices',
  description: 'Find active services by name',
  inputSchema: findServicesInput,
  outputSchema: z.array(serviceRecord),
  execute: parsedExecute(
    findServicesInput,
    async ({ query }) =>
      db
        .select()
        .from(services)
        .where(
          and(
            isNull(services.deleted_at),
            query ? ilike(services.name, `%${query}%`) : undefined,
          ),
        ),
  ),
}

const updateServiceInput = z.object({
  id: z.number(),
  name: z.string().optional(),
  price: z.number().int().positive().optional(),
  unit: z.enum(['hour', 'flat']).optional(),
  duration_minutes: z.number().int().positive().optional(),
})

export const updateService = {
  name: 'updateService',
  description: 'Update a service',
  inputSchema: updateServiceInput,
  outputSchema: serviceRecord.optional(),
  execute: auditedExecute(
    'updateService',
    'service',
    updateServiceInput,
    async ({ id, ...fields }) => {
      const [service] = await db
        .update(services)
        .set({ ...fields, updated_at: sql`now()` })
        .where(eq(services.id, id))
        .returning()
      return service
    },
    async ({ id }) => {
      const [service] = await db
        .select()
        .from(services)
        .where(eq(services.id, id))
      return service
    },
  ),
}

const softDeleteServiceInput = z.object({
  id: z.number(),
})

export const softDeleteService = {
  name: 'softDeleteService',
  description: 'Soft delete a service',
  inputSchema: softDeleteServiceInput,
  outputSchema: serviceRecord.optional(),
  execute: auditedExecute(
    'softDeleteService',
    'service',
    softDeleteServiceInput,
    async ({ id }) => {
      const [service] = await db
        .update(services)
        .set({ deleted_at: sql`now()` })
        .where(eq(services.id, id))
        .returning()
      return service
    },
    async ({ id }) => {
      const [service] = await db
        .select()
        .from(services)
        .where(eq(services.id, id))
      return service
    },
  ),
}

const restoreServiceInput = z.object({ id: z.number() })

export const restoreService = {
  name: 'restoreService',
  description: 'Restore a soft-deleted service',
  inputSchema: restoreServiceInput,
  outputSchema: serviceRecord.optional(),
  execute: auditedExecute(
    'restoreService',
    'service',
    restoreServiceInput,
    async ({ id }) => {
      const [service] = await db
        .update(services)
        .set({ deleted_at: null })
        .where(eq(services.id, id))
        .returning()
      return service
    },
    async ({ id }) => {
      const [service] = await db
        .select()
        .from(services)
        .where(eq(services.id, id))
      return service
    },
  ),
}

const updateClientInput = z.object({
  id: z.number(),
  name: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  notes: z.string().optional(),
})

export const updateClient = {
  name: 'updateClient',
  description: 'Update a client',
  inputSchema: updateClientInput,
  outputSchema: clientRecord.optional(),
  execute: auditedExecute(
    'updateClient',
    'client',
    updateClientInput,
    async ({ id, ...fields }) => {
      const [client] = await db
        .update(clients)
        .set({ ...fields, updated_at: sql`now()` })
        .where(eq(clients.id, id))
        .returning()
      return client
    },
    async ({ id }) => {
      const [client] = await db
        .select()
        .from(clients)
        .where(eq(clients.id, id))
      return client
    },
  ),
}

const softDeleteClientInput = z.object({
  id: z.number(),
})

export const softDeleteClient = {
  name: 'softDeleteClient',
  description: 'Soft delete a client',
  inputSchema: softDeleteClientInput,
  outputSchema: clientRecord.optional(),
  execute: auditedExecute(
    'softDeleteClient',
    'client',
    softDeleteClientInput,
    async ({ id }) => {
      const blockingAppointments = await db
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
      if (blockingAppointments.length)
        throw new Error(
          `Client ${id} has scheduled future appointments: ${blockingAppointments
            .map(
              (appointment) =>
                `${appointment.id} (${appointment.starts_at.toISOString()})`,
            )
            .join(', ')}`,
        )
      const [client] = await db
        .update(clients)
        .set({ deleted_at: sql`now()` })
        .where(eq(clients.id, id))
        .returning()
      return client
    },
    async ({ id }) => {
      const [client] = await db
        .select()
        .from(clients)
        .where(eq(clients.id, id))
      return client
    },
  ),
}

const restoreClientInput = z.object({ id: z.number() })

export const restoreClient = {
  name: 'restoreClient',
  description: 'Restore a soft-deleted client',
  inputSchema: restoreClientInput,
  outputSchema: clientRecord.optional(),
  execute: auditedExecute(
    'restoreClient',
    'client',
    restoreClientInput,
    async ({ id }) => {
      const [client] = await db
        .update(clients)
        .set({ deleted_at: null })
        .where(eq(clients.id, id))
        .returning()
      return client
    },
    async ({ id }) => {
      const [client] = await db
        .select()
        .from(clients)
        .where(eq(clients.id, id))
      return client
    },
  ),
}

const findAppointmentsInput = z.object({
  client_id: z.number().optional(),
  from: rangeInput.optional(),
  to: rangeInput.optional(),
  status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']).optional(),
})

export const findAppointments = {
  name: 'findAppointments',
  description:
    'Find appointments by client, time range and status. Returns every appointment that occupies any part of [from, to), earliest first. starts_local and ends_local are the times as the Owner reads them in America/Santiago; use them when talking to the Owner.',
  inputSchema: findAppointmentsInput,
  outputSchema: z.array(
    appointmentRecord.extend({
      starts_local: z.string().describe('e.g. jueves 1 de octubre, 17:00'),
      ends_local: z.string(),
    }),
  ),
  execute: parsedExecute(
    findAppointmentsInput,
    async ({ client_id, from, to, status }) => {
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
  ),
}

const updateAppointmentInput = z.object({
  id: z.number(),
  starts_at: timeInput.optional(),
  duration_minutes: z.number().int().positive().optional(),
  status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']).optional(),
  price: z.number().int().nonnegative().optional(),
  mode: z.enum(['online', 'in_person']).optional(),
  notes: z.string().optional(),
})

export const updateAppointment = {
  name: 'updateAppointment',
  description: 'Update an appointment',
  inputSchema: updateAppointmentInput,
  outputSchema: appointmentRecord.optional(),
  execute: auditedExecute(
    'updateAppointment',
    'appointment',
    updateAppointmentInput,
    async ({ id, starts_at, duration_minutes, ...fields }) => {
      const set: PgUpdateSetSource<typeof appointments> = {
        ...fields,
        updated_at: sql`now()`,
      }
      const timeChanged = starts_at != null || duration_minutes != null
      if (timeChanged || fields.status === 'scheduled') {
        const [existing] = await db
          .select()
          .from(appointments)
          .where(eq(appointments.id, id))
        if (!existing) throw new Error(`Appointment ${id} not found`)
        const newStarts = starts_at ? toInstant(starts_at) : existing.starts_at
        const duration =
          duration_minutes ??
          (existing.ends_at.getTime() - existing.starts_at.getTime()) / 60000
        const newEnds = new Date(newStarts.getTime() + duration * 60000)
        await assertNoOverlap(newStarts, newEnds, id)
        if (timeChanged) {
          set.starts_at = newStarts
          set.ends_at = newEnds
        }
      }
      const [appointment] = await db
        .update(appointments)
        .set(set)
        .where(eq(appointments.id, id))
        .returning()
      return appointment
    },
    async ({ id }) => {
      const [appointment] = await db
        .select()
        .from(appointments)
        .where(eq(appointments.id, id))
      return appointment
    },
  ),
}

const softDeleteAppointmentInput = z.object({
  id: z.number(),
})

export const softDeleteAppointment = {
  name: 'softDeleteAppointment',
  description: 'Soft delete an appointment',
  inputSchema: softDeleteAppointmentInput,
  outputSchema: appointmentRecord.optional(),
  execute: auditedExecute(
    'softDeleteAppointment',
    'appointment',
    softDeleteAppointmentInput,
    async ({ id }) => {
      const [appointment] = await db
        .update(appointments)
        .set({ deleted_at: sql`now()` })
        .where(eq(appointments.id, id))
        .returning()
      return appointment
    },
    async ({ id }) => {
      const [appointment] = await db
        .select()
        .from(appointments)
        .where(eq(appointments.id, id))
      return appointment
    },
  ),
}

const restoreAppointmentInput = z.object({ id: z.number() })

export const restoreAppointment = {
  name: 'restoreAppointment',
  description:
    'Restore a soft-deleted appointment. Rejects if its time now conflicts.',
  inputSchema: restoreAppointmentInput,
  outputSchema: appointmentRecord.optional(),
  execute: auditedExecute(
    'restoreAppointment',
    'appointment',
    restoreAppointmentInput,
    async ({ id }) => {
      const [existing] = await db
        .select()
        .from(appointments)
        .where(eq(appointments.id, id))
      if (!existing) throw new Error(`Appointment ${id} not found`)
      await assertNoOverlap(existing.starts_at, existing.ends_at, id)
      const [appointment] = await db
        .update(appointments)
        .set({ deleted_at: null })
        .where(eq(appointments.id, id))
        .returning()
      return appointment
    },
    async ({ id }) => {
      const [appointment] = await db
        .select()
        .from(appointments)
        .where(eq(appointments.id, id))
      return appointment
    },
  ),
}

const findClientsInput = z.object({
  query: z.string().optional(),
})

export const findClients = {
  name: 'findClients',
  description: 'Find active clients by name',
  inputSchema: findClientsInput,
  outputSchema: z.array(clientRecord),
  execute: parsedExecute(
    findClientsInput,
    async ({ query }) =>
      db
        .select()
        .from(clients)
        .where(
          and(
            isNull(clients.deleted_at),
            query ? ilike(clients.name, `%${query}%`) : undefined,
          ),
        ),
  ),
}

async function assertNoOverlap(
  starts_at: Date,
  ends_at: Date,
  excludeId?: number,
) {
  const [conflict] = await db
    .select({
      starts_at: appointments.starts_at,
      ends_at: appointments.ends_at,
      client_name: clients.name,
    })
    .from(appointments)
    .innerJoin(
      clients,
      and(
        eq(appointments.client_id, clients.id),
        eq(appointments.owner_id, clients.owner_id),
      ),
    )
    .where(
      and(
        eq(appointments.status, 'scheduled'),
        isNull(appointments.deleted_at),
        lt(appointments.starts_at, ends_at),
        gt(appointments.ends_at, starts_at),
        excludeId ? ne(appointments.id, excludeId) : undefined,
      ),
    )
    .limit(1)
  if (conflict)
    throw new Error(
      `Time conflict with ${conflict.client_name} (${describeSantiagoSpan(conflict.starts_at, conflict.ends_at)})`,
    )
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

export const createAppointment = {
  name: 'createAppointment',
  description:
    'Book an appointment at a time the Owner stated. On an overlap error, tell the Owner what it collides with and ask for another time; never suggest one.',
  inputSchema: createAppointmentInput,
  outputSchema: appointmentRecord,
  execute: auditedExecute(
    'createAppointment',
    'appointment',
    createAppointmentInput,
    async (input) => {
      const [service] = await db
        .select()
        .from(services)
        .where(eq(services.id, input.service_id))
      if (!service || service.deleted_at != null)
        throw new Error(`Service ${input.service_id} not found`)
      const duration = input.duration_minutes ?? service.duration_minutes
      if (duration == null)
        throw new Error('duration_minutes required: service has no default')
      const starts_at = toInstant(input.starts_at)
      const ends_at = new Date(starts_at.getTime() + duration * 60000)
      const price =
        input.price ??
        (service.unit === 'flat'
          ? service.price
          : Math.round((duration / 60) * service.price))
      await assertNoOverlap(starts_at, ends_at)
      const [appointment] = await db
        .insert(appointments)
        .values({
          client_id: input.client_id,
          service_id: input.service_id,
          starts_at,
          ends_at,
          mode: input.mode,
          price,
          notes: input.notes,
        })
        .returning()
      return appointment
    },
  ),
}

const createPaymentInput = z.object({
  client_id: z.number(),
  amount: z.number().int().positive(),
  paid_at: timeInput.optional(),
  appointment_id: z.number().optional(),
  notes: z.string().optional(),
})

export const createPayment = {
  name: 'createPayment',
  description: 'Record a payment received from a client',
  inputSchema: createPaymentInput,
  outputSchema: paymentRecord,
  execute: auditedExecute(
    'createPayment',
    'payment',
    createPaymentInput,
    async ({ paid_at, ...rest }) => {
      const [payment] = await db
        .insert(payments)
        .values({ ...rest, paid_at: paid_at ? toInstant(paid_at) : new Date() })
        .returning()
      return payment
    },
  ),
}

const findPaymentsInput = z.object({
  client_id: z.number().optional(),
  from: rangeInput.optional(),
  to: rangeInput.optional(),
})

export const findPayments = {
  name: 'findPayments',
  description: 'Find payments by client and paid_at range',
  inputSchema: findPaymentsInput,
  outputSchema: z.array(paymentRecord),
  execute: parsedExecute(
    findPaymentsInput,
    async ({ client_id, from, to }) => {
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
  ),
}

const updatePaymentInput = z.object({
  id: z.number(),
  amount: z.number().int().positive().optional(),
  paid_at: timeInput.optional(),
  appointment_id: z.number().optional(),
  notes: z.string().optional(),
})

export const updatePayment = {
  name: 'updatePayment',
  description: 'Update a payment',
  inputSchema: updatePaymentInput,
  outputSchema: paymentRecord.optional(),
  execute: auditedExecute(
    'updatePayment',
    'payment',
    updatePaymentInput,
    async ({ id, paid_at, ...fields }) => {
      const set: PgUpdateSetSource<typeof payments> = {
        ...fields,
        updated_at: sql`now()`,
      }
      if (paid_at) set.paid_at = toInstant(paid_at)
      const [payment] = await db
        .update(payments)
        .set(set)
        .where(eq(payments.id, id))
        .returning()
      return payment
    },
    async ({ id }) => {
      const [payment] = await db
        .select()
        .from(payments)
        .where(eq(payments.id, id))
      return payment
    },
  ),
}

const softDeletePaymentInput = z.object({
  id: z.number(),
})

export const softDeletePayment = {
  name: 'softDeletePayment',
  description: 'Soft delete a payment',
  inputSchema: softDeletePaymentInput,
  outputSchema: paymentRecord.optional(),
  execute: auditedExecute(
    'softDeletePayment',
    'payment',
    softDeletePaymentInput,
    async ({ id }) => {
      const [payment] = await db
        .update(payments)
        .set({ deleted_at: sql`now()` })
        .where(eq(payments.id, id))
        .returning()
      return payment
    },
    async ({ id }) => {
      const [payment] = await db
        .select()
        .from(payments)
        .where(eq(payments.id, id))
      return payment
    },
  ),
}

const restorePaymentInput = z.object({ id: z.number() })

export const restorePayment = {
  name: 'restorePayment',
  description: 'Restore a soft-deleted payment',
  inputSchema: restorePaymentInput,
  outputSchema: paymentRecord.optional(),
  execute: auditedExecute(
    'restorePayment',
    'payment',
    restorePaymentInput,
    async ({ id }) => {
      const [payment] = await db
        .update(payments)
        .set({ deleted_at: null })
        .where(eq(payments.id, id))
        .returning()
      return payment
    },
    async ({ id }) => {
      const [payment] = await db
        .select()
        .from(payments)
        .where(eq(payments.id, id))
      return payment
    },
  ),
}
