import { and, eq, gt, gte, ilike, isNull, lt, lte, ne, sql } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '#/db'
import {
  appointments,
  audit_log,
  clients,
  owners,
  payments,
  services,
  working_hours,
} from '#/db/schema'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'

type AuditEntity =
  | 'client'
  | 'service'
  | 'appointment'
  | 'payment'
  | 'working_hours'
  | 'owner'

function containsNotes(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsNotes)
  if (value === null || typeof value !== 'object') return false
  return Object.entries(value).some(
    ([key, nested]) => key === 'notes' || containsNotes(nested),
  )
}

function redactNotes<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redactNotes) as T
  if (value === null || typeof value !== 'object' || value instanceof Date)
    return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'notes')
      .map(([key, nested]) => [key, redactNotes(nested)]),
  ) as T
}

class RestrictedNotesError extends Error {}

async function enforceNotesBoundary(input: unknown) {
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
      restricted = await enforceNotesBoundary(input)
      const parsed = schema.parse(input)
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'id' in parsed &&
        typeof parsed.id === 'number'
      )
        entityId = parsed.id
      before = getBefore ? await getBefore(parsed) : null
      if (restricted) before = redactNotes(before)
      const result = await operation(parsed)
      if (
        typeof result === 'object' &&
        result !== null &&
        'id' in result &&
        typeof result.id === 'number'
      )
        entityId = result.id
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
    } catch (error) {
      if (error instanceof RestrictedNotesError) restricted = true
      await db.insert(audit_log).values({
        tool_name: toolName,
        input: restricted ? redactNotes(input) : input,
        entity,
        entity_id: entityId,
        before,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }
}

function parsedExecute<TSchema extends z.ZodType, TResult>(
  schema: TSchema,
  operation: (input: z.output<TSchema>) => Promise<TResult>,
) {
  return async (input: z.input<TSchema>) => {
    const restricted = await enforceNotesBoundary(input)
    const parsed = schema.parse(input)
    const result = await operation(parsed)
    return restricted ? redactNotes(result) : result
  }
}

const listAuditLogInput = z
  .object({
    entity: z.enum(['client', 'service', 'appointment', 'payment']).optional(),
    entity_id: z.number().optional(),
    since: z.string().optional(),
    until: z.string().optional(),
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
  execute: parsedExecute(
    listAuditLogInput,
    async ({ entity, entity_id, since, until, ok }) =>
      db
        .select()
        .from(audit_log)
        .where(
          and(
            entity ? eq(audit_log.entity, entity) : undefined,
            entity_id !== undefined
              ? eq(audit_log.entity_id, entity_id)
              : undefined,
            since ? gte(audit_log.ts, new Date(since)) : undefined,
            until ? lte(audit_log.ts, new Date(until)) : undefined,
            ok !== undefined ? eq(audit_log.ok, ok) : undefined,
          ),
        ),
  ),
}

const workingHourSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  start_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
})

const setWorkingHoursInput = z
  .object({ hours: z.array(workingHourSchema) })
  .superRefine(({ hours }, context) => {
    const sorted = [...hours].sort(
      (a, b) => a.weekday - b.weekday || a.start_time.localeCompare(b.start_time),
    )
    for (let index = 0; index < sorted.length; index++) {
      const current = sorted[index]
      if (current.start_time >= current.end_time)
        context.addIssue({
          code: 'custom',
          message: `start_time must be before end_time for weekday ${current.weekday}`,
        })
      const previous = sorted[index - 1]
      if (
        previous?.weekday === current.weekday &&
        current.start_time < previous.end_time
      )
        context.addIssue({
          code: 'custom',
          message: `Working hours overlap on weekday ${current.weekday}`,
        })
    }
  })

export const setWorkingHours = {
  name: 'set_working_hours',
  description:
    'Replace the complete weekly working-hours template. Omitted weekdays become days off.',
  inputSchema: setWorkingHoursInput,
  execute: auditedExecute(
    'set_working_hours',
    'working_hours',
    setWorkingHoursInput,
    async ({ hours }) => {
      await db.delete(working_hours)
      if (hours.length === 0) return []
      return db.insert(working_hours).values(hours).returning()
    },
    async () => db.select().from(working_hours),
  ),
}

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const findFreeSlotsInput = z
  .object({
    from: localDate,
    to: localDate,
    duration_minutes: z.number().int().positive(),
  })
  .refine(({ from, to }) => from <= to, {
    message: 'from must be on or before to',
  })

export const findFreeSlots = {
  name: 'find_free_slots',
  description:
    'Find exact-duration free slots in America/Santiago between inclusive local dates, excluding non-cancelled appointments.',
  inputSchema: findFreeSlotsInput,
  execute: parsedExecute(
    findFreeSlotsInput,
    async ({ from, to, duration_minutes }) => {
      const result = await db.execute<{
        starts_at: Date
        ends_at: Date
      }>(sql`
        with days as (
          select generate_series(${from}::date, ${to}::date, interval '1 day')::date as day
        ), windows as (
          select tstzrange(
            (days.day + ${working_hours.start_time}) at time zone 'America/Santiago',
            (days.day + ${working_hours.end_time}) at time zone 'America/Santiago',
            '[)'
          ) as slot
          from days
          join ${working_hours}
            on ${working_hours.weekday} = extract(dow from days.day)::integer
        ), free_ranges as (
          select free.slot
          from windows
          left join lateral (
            select coalesce(
              range_agg(tstzrange(
                greatest(${appointments.starts_at}, lower(windows.slot)),
                least(${appointments.ends_at}, upper(windows.slot)),
                '[)'
              )),
              '{}'::tstzmultirange
            ) as occupied
            from ${appointments}
            where ${appointments.status} <> 'cancelled'
              and ${appointments.deleted_at} is null
              and tstzrange(${appointments.starts_at}, ${appointments.ends_at}, '[)') && windows.slot
          ) busy on true
          cross join lateral unnest(
            tstzmultirange(windows.slot) - busy.occupied
          ) as free(slot)
        )
        select candidate as starts_at,
          candidate + make_interval(mins => ${duration_minutes}) as ends_at
        from free_ranges
        cross join lateral generate_series(
          lower(slot),
          upper(slot) - make_interval(mins => ${duration_minutes}),
          make_interval(mins => ${duration_minutes})
        ) as candidate
        order by starts_at
      `)
      return result.rows.map(({ starts_at, ends_at }) => ({
        starts_at: new Date(starts_at),
        ends_at: new Date(ends_at),
      }))
    },
  ),
}

const updateOwnerProfileInput = z.object({ name: z.string().min(1) }).strict()

export const updateOwnerProfile = {
  name: 'update_owner_profile',
  description: "Update the Owner's name. Other profile fields are operator-only.",
  inputSchema: updateOwnerProfileInput,
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
  from: z.string().optional(),
  to: z.string().optional(),
  status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']).optional(),
})

export const findAppointments = {
  name: 'findAppointments',
  description: 'Find appointments by client, date range, and status',
  inputSchema: findAppointmentsInput,
  execute: parsedExecute(
    findAppointmentsInput,
    async ({ client_id, from, to, status }) =>
      db
        .select()
        .from(appointments)
        .where(
          and(
            isNull(appointments.deleted_at),
            client_id ? eq(appointments.client_id, client_id) : undefined,
            from ? gte(appointments.starts_at, new Date(from)) : undefined,
            to ? lte(appointments.starts_at, new Date(to)) : undefined,
            status ? eq(appointments.status, status) : undefined,
          ),
        ),
  ),
}

const updateAppointmentInput = z.object({
  id: z.number(),
  starts_at: z.string().optional(),
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
        const newStarts = starts_at ? new Date(starts_at) : existing.starts_at
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
      `Time conflict with ${conflict.client_name} (${conflict.starts_at.toISOString()} – ${conflict.ends_at.toISOString()})`,
    )
}

const createAppointmentInput = z.object({
  client_id: z.number(),
  service_id: z.number(),
  starts_at: z.string(),
  duration_minutes: z.number().int().positive().optional(),
  price: z.number().int().nonnegative().optional(),
  mode: z.enum(['online', 'in_person']),
  notes: z.string().optional(),
})

export const createAppointment = {
  name: 'createAppointment',
  description:
    'Book an appointment. On an overlap error, relay the conflict to the owner and ask them to rebook another time.',
  inputSchema: createAppointmentInput,
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
      const starts_at = new Date(input.starts_at)
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
  paid_at: z.string().optional(),
  appointment_id: z.number().optional(),
  notes: z.string().optional(),
})

export const createPayment = {
  name: 'createPayment',
  description: 'Record a payment received from a client',
  inputSchema: createPaymentInput,
  execute: auditedExecute(
    'createPayment',
    'payment',
    createPaymentInput,
    async ({ paid_at, ...rest }) => {
      const [payment] = await db
        .insert(payments)
        .values({ ...rest, paid_at: paid_at ? new Date(paid_at) : new Date() })
        .returning()
      return payment
    },
  ),
}

const findPaymentsInput = z.object({
  client_id: z.number().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
})

export const findPayments = {
  name: 'findPayments',
  description: 'Find payments by client and paid_at range',
  inputSchema: findPaymentsInput,
  execute: parsedExecute(
    findPaymentsInput,
    async ({ client_id, from, to }) =>
      db
        .select()
        .from(payments)
        .where(
          and(
            isNull(payments.deleted_at),
            client_id ? eq(payments.client_id, client_id) : undefined,
            from ? gte(payments.paid_at, new Date(from)) : undefined,
            to ? lte(payments.paid_at, new Date(to)) : undefined,
          ),
        ),
  ),
}

const updatePaymentInput = z.object({
  id: z.number(),
  amount: z.number().int().positive().optional(),
  paid_at: z.string().optional(),
  appointment_id: z.number().optional(),
  notes: z.string().optional(),
})

export const updatePayment = {
  name: 'updatePayment',
  description: 'Update a payment',
  inputSchema: updatePaymentInput,
  execute: auditedExecute(
    'updatePayment',
    'payment',
    updatePaymentInput,
    async ({ id, paid_at, ...fields }) => {
      const set: PgUpdateSetSource<typeof payments> = {
        ...fields,
        updated_at: sql`now()`,
      }
      if (paid_at) set.paid_at = new Date(paid_at)
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
