import { and, eq, ilike, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '#/db'
import { audit_log, clients, services } from '#/db/schema'

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
