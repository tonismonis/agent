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

function auditedExecute<TSchema extends z.ZodType, TResult>(
  toolName: string,
  schema: TSchema,
  operation: (input: z.output<TSchema>) => Promise<TResult>,
) {
  return async (input: z.input<TSchema>) => {
    let ok = false

    try {
      const result = await operation(schema.parse(input))
      ok = true
      return result
    } finally {
      await db.insert(audit_log).values({ tool_name: toolName, input, ok })
    }
  }
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
  execute: auditedExecute(
    'findServices',
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
    updateServiceInput,
    async ({ id, ...fields }) => {
      const [service] = await db
        .update(services)
        .set({ ...fields, updated_at: sql`now()` })
        .where(eq(services.id, id))
        .returning()
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
    softDeleteServiceInput,
    async ({ id }) => {
      const [service] = await db
        .update(services)
        .set({ deleted_at: sql`now()` })
        .where(eq(services.id, id))
        .returning()
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
    updateClientInput,
    async ({ id, ...fields }) => {
      const [client] = await db
        .update(clients)
        .set({ ...fields, updated_at: sql`now()` })
        .where(eq(clients.id, id))
        .returning()
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
    softDeleteClientInput,
    async ({ id }) => {
      const [client] = await db
        .update(clients)
        .set({ deleted_at: sql`now()` })
        .where(eq(clients.id, id))
        .returning()
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
  execute: auditedExecute(
    'findAppointments',
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
    softDeleteAppointmentInput,
    async ({ id }) => {
      const [appointment] = await db
        .update(appointments)
        .set({ deleted_at: sql`now()` })
        .where(eq(appointments.id, id))
        .returning()
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
  execute: auditedExecute(
    'findClients',
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
    .innerJoin(clients, eq(appointments.client_id, clients.id))
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
  execute: auditedExecute(
    'findPayments',
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
    softDeletePaymentInput,
    async ({ id }) => {
      const [payment] = await db
        .update(payments)
        .set({ deleted_at: sql`now()` })
        .where(eq(payments.id, id))
        .returning()
      return payment
    },
  ),
}
