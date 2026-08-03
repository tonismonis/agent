import { and, eq, gt, gte, ilike, isNull, lt, lte, ne, sql } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '#/db'
import {
  appointments,
  audit_log,
  clients,
  payments,
  services,
} from '#/db/schema'

type AuditEntity = 'client' | 'service' | 'appointment' | 'payment'

function auditedExecute<
  TSchema extends z.ZodType,
  TResult extends { id: number } | undefined,
>(
  toolName: string,
  entity: AuditEntity,
  schema: TSchema,
  operation: (input: z.output<TSchema>) => Promise<TResult>,
  getBefore?: (input: z.output<TSchema>) => Promise<unknown>,
) {
  return async (input: z.input<TSchema>) => {
    let before: unknown = null
    let entityId: number | null = null
    try {
      const parsed = schema.parse(input)
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'id' in parsed &&
        typeof parsed.id === 'number'
      )
        entityId = parsed.id
      before = getBefore ? await getBefore(parsed) : null
      const result = await operation(parsed)
      entityId = result?.id ?? entityId
      await db.insert(audit_log).values({
        tool_name: toolName,
        input,
        entity,
        entity_id: entityId,
        before,
        ok: true,
        error: null,
      })
      return result
    } catch (error) {
      await db.insert(audit_log).values({
        tool_name: toolName,
        input,
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
  return (input: z.input<TSchema>) => operation(schema.parse(input))
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
      const set: Record<string, unknown> = { ...fields, updated_at: sql`now()` }
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
      const [payment] = await db
        .update(payments)
        .set({
          ...fields,
          ...(paid_at ? { paid_at: new Date(paid_at) } : {}),
          updated_at: sql`now()`,
        })
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
