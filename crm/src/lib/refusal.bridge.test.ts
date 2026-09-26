// The refusal contract across the real code-mode bridge: library binding,
// isolate stub, and the execute_typescript output the model reads.
import { toolDefinition } from '@tanstack/ai'
import { createCodeMode, toolsToBindings } from '@tanstack/ai-code-mode'
import { createNodeIsolateDriver } from '@tanstack/ai-isolate-node'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { beforeAll, beforeEach, expect, test } from 'vitest'

import { appointments, audit_log, clients, owners, services } from '#/db/schema'
import { withRefusalOutput } from './chat-run'
import { chatTools, createChatTools } from './chat-tools'
import { readRefusal } from './refusal'
import {
  createAppointment,
  createClient,
  createService,
  runOwnerTool,
} from './tools'

const ownerId = '88888888-8888-4888-8888-888888888888'
const adminDb = drizzle(
  process.env.DATABASE_ADMIN_URL ?? 'postgresql://crm:crm@localhost:5433/crm',
)

beforeAll(async () => {
  await adminDb
    .insert(owners)
    .values({
      id: ownerId,
      email: 'refusal-bridge@example.test',
      name: 'Ema',
      profession: 'Profesora de piano',
    })
    .onConflictDoNothing()
})

beforeEach(async () => {
  await adminDb.delete(audit_log).where(eq(audit_log.owner_id, ownerId))
  await adminDb.delete(appointments).where(eq(appointments.owner_id, ownerId))
  await adminDb.delete(clients).where(eq(clients.owner_id, ownerId))
  await adminDb.delete(services).where(eq(services.owner_id, ownerId))
})

test('code-mode hands a plain JSON Schema tool its raw input, unvalidated', async () => {
  const received: Array<string> = []
  const probe = toolDefinition({
    name: 'probe',
    description: 'Records what it was called with',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  }).server(async (input) => {
    received.push(JSON.stringify(input))
    return 'ok'
  })

  await toolsToBindings([probe]).probe.execute({ name: 7 })

  expect(received).toEqual(['{"name":7}'])
})

test('a CRM binding refuses invalid input itself, not the library', async () => {
  const bindings = toolsToBindings(chatTools)

  const error = await bindings.createClient.execute({ name: 7 }).then(
    () => null,
    (reason: Error) => reason,
  )

  expect(error?.message).not.toMatch(/Input validation failed/)
  expect(readRefusal(error?.message ?? '')).toEqual(
    expect.objectContaining({
      kind: 'invalid_input',
      issues: [expect.objectContaining({ path: 'name' })],
    }),
  )
})

async function bookPedro() {
  const pedro = await runOwnerTool(ownerId, () =>
    createClient.execute({ name: 'Pedro' }),
  )
  const service = await runOwnerTool(ownerId, () =>
    createService.execute({
      name: 'Piano',
      price: 35000,
      unit: 'flat',
      duration_minutes: 60,
    }),
  )
  await runOwnerTool(ownerId, () =>
    createAppointment.execute({
      client_id: pedro.id,
      service_id: service.id,
      starts_at: '2026-10-01T17:00',
      mode: 'online',
    }),
  )
  return { pedro, service }
}

function sandbox() {
  const { tool } = createCodeMode({
    driver: createNodeIsolateDriver(),
    tools: createChatTools((operation) => runOwnerTool(ownerId, operation)),
  })
  const wrapped = withRefusalOutput(tool)
  return (typescriptCode: string) => wrapped.execute!({ typescriptCode })
}

test('an uncaught refusal reaches the model as the refusal JSON, without a stack', async () => {
  const { pedro, service } = await bookPedro()

  const output = await sandbox()(`
    return await external_createAppointment({
      client_id: ${pedro.id},
      service_id: ${service.id},
      starts_at: '2026-10-01T17:30',
      mode: 'online',
    })
  `)

  expect(output.success).toBe(false)
  expect(output.error?.name).toBe('Refusal')
  expect(JSON.stringify(output)).not.toContain('stack')
  expect(readRefusal(output.error?.message ?? '')).toEqual(
    expect.objectContaining({
      kind: 'conflict',
      say: 'El jueves 1 de octubre a las 17:30 ya tienes a Pedro, de 17:00 a 18:00.',
    }),
  )
})

test('sandbox code can catch a refusal and read it with JSON.parse', async () => {
  const { pedro, service } = await bookPedro()

  const output = await sandbox()(`
    try {
      return await external_createAppointment({
        client_id: ${pedro.id},
        service_id: ${service.id},
        starts_at: '2026-10-01T17:30',
        mode: 'online',
      })
    } catch (error) {
      const refusal = JSON.parse(error.message)
      return { kind: refusal.kind, clashes: refusal.dates.length }
    }
  `)

  expect(output).toEqual(
    expect.objectContaining({
      success: true,
      result: { kind: 'conflict', clashes: 1 },
    }),
  )
})

test("invalid input inside the sandbox is a fix for the model, and the model's own errors keep their stack", async () => {
  const run = sandbox()

  const invalid = await run(`return await external_createClient({ name: 7 })`)
  expect(readRefusal(invalid.error?.message ?? '')).toEqual(
    expect.objectContaining({ kind: 'invalid_input' }),
  )

  const own = await run(`const client = null; return client.name`)
  expect(own.error?.name).toBe('TypeError')
  expect(own.error?.stack).toBeDefined()
})
