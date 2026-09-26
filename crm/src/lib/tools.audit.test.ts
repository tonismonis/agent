// Tool calls as chat runs them: each in its own Owner transaction via
// runOwnerTool. tools.test.ts wraps whole tests in one transaction, which hides
// what a failed call commits.
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { beforeAll, beforeEach, expect, test } from 'vitest'

import {
  appointments,
  audit_log,
  clients,
  owners,
  payments,
  services,
} from '#/db/schema'
import { readRefusal } from '#/lib/refusal'
import { refusalOf } from '#/test/refusals'
import {
  createAppointment,
  createClient,
  createPayment,
  createService,
  runOwnerTool,
} from './tools'

const ownerId = '77777777-7777-4777-8777-777777777777'
const adminDb = drizzle(
  process.env.DATABASE_ADMIN_URL ?? 'postgresql://crm:crm@localhost:5433/crm',
)

function failedAudits(toolName: string) {
  return adminDb
    .select()
    .from(audit_log)
    .where(
      and(
        eq(audit_log.owner_id, ownerId),
        eq(audit_log.tool_name, toolName),
        eq(audit_log.ok, false),
      ),
    )
}

beforeAll(async () => {
  await adminDb
    .insert(owners)
    .values({
      id: ownerId,
      email: 'tools-audit@example.test',
      name: 'Ema',
      profession: 'Consultant',
    })
    .onConflictDoNothing()
})

beforeEach(async () => {
  await adminDb.delete(audit_log).where(eq(audit_log.owner_id, ownerId))
  await adminDb.delete(payments).where(eq(payments.owner_id, ownerId))
  await adminDb.delete(appointments).where(eq(appointments.owner_id, ownerId))
  await adminDb.delete(clients).where(eq(clients.owner_id, ownerId))
  await adminDb.delete(services).where(eq(services.owner_id, ownerId))
})

test('a failed write is audited with the refusal the model saw', async () => {
  const refusal = await refusalOf(
    runOwnerTool(ownerId, () =>
      createAppointment.execute({
        client_id: 1,
        service_id: 999999,
        starts_at: '2026-09-24T13:00:00Z',
        mode: 'online',
      }),
    ),
  )

  expect(refusal).toEqual(
    expect.objectContaining({ kind: 'not_found', entity: 'service', id: 999999 }),
  )
  const [audit] = await failedAudits('createAppointment')
  expect(readRefusal(audit?.error ?? '')).toEqual(refusal)
})

test('a write Postgres rejects refuses by constraint, never with the SQL', async () => {
  const refusal = await refusalOf(
    runOwnerTool(ownerId, () =>
      createPayment.execute({ client_id: 999999, amount: 1000 }),
    ),
  )

  expect(refusal).toEqual(
    expect.objectContaining({ kind: 'not_found', entity: 'client', id: 999999 }),
  )
  const [audit] = await failedAudits('createPayment')
  expect(readRefusal(audit?.error ?? '')).toEqual(refusal)
  expect(audit?.error).not.toMatch(/Failed query|params|insert/)
})

test('an unplanned failure is internal to the model; the audit keeps its cause', async () => {
  const client = await runOwnerTool(ownerId, () =>
    createClient.execute({ name: 'Rosa' }),
  )
  const service = await runOwnerTool(ownerId, () =>
    createService.execute({ name: 'Sesión', price: 40000, unit: 'flat' }),
  )

  const refusal = await refusalOf(
    runOwnerTool(ownerId, () =>
      createAppointment.execute({
        client_id: client.id,
        service_id: service.id,
        starts_at: '2026-09-24T13:00:00Z',
        duration_minutes: 60,
        mode: 'online',
        price: 3_000_000_000,
      }),
    ),
  )

  expect(refusal).toEqual({
    kind: 'internal',
    say: 'Hubo un problema del sistema y esto no se guardó. Puedes intentarlo de nuevo en un rato.',
  })
  const [audit] = await failedAudits('createAppointment')
  expect(readRefusal(audit?.error ?? '')).toEqual(refusal)
  expect(JSON.parse(audit?.error ?? '{}').cause).toMatch(/out of range/)
})

test('concurrent bookings of one slot leave exactly one appointment', async () => {
  const client = await runOwnerTool(ownerId, () =>
    createClient.execute({ name: 'Rosa' }),
  )
  const service = await runOwnerTool(ownerId, () =>
    createService.execute({
      name: 'Sesión',
      price: 40000,
      unit: 'flat',
      duration_minutes: 60,
    }),
  )

  const results = await Promise.allSettled(
    Array.from({ length: 3 }, () =>
      runOwnerTool(ownerId, () =>
        createAppointment.execute({
          client_id: client.id,
          service_id: service.id,
          starts_at: '2026-09-24T13:00:00Z',
          mode: 'online',
        }),
      ),
    ),
  )

  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  for (const result of results) {
    if (result.status === 'rejected') {
      expect(readRefusal(result.reason.message)).toEqual(
        expect.objectContaining({
          kind: 'conflict',
          say: 'El jueves 24 de septiembre a las 10:00 ya tienes a Rosa, de 10:00 a 11:00.',
          dates: [
            expect.objectContaining({
              date: '2026-09-24',
              time: '10:00',
              problem: 'taken',
            }),
          ],
        }),
      )
    }
  }
  expect(await failedAudits('createAppointment')).toHaveLength(2)
  const booked = await adminDb
    .select()
    .from(appointments)
    .where(eq(appointments.owner_id, ownerId))
  expect(booked).toHaveLength(1)
})

test("a payment linked to another client's appointment is refused", async () => {
  const rosa = await runOwnerTool(ownerId, () =>
    createClient.execute({ name: 'Rosa' }),
  )
  const pedro = await runOwnerTool(ownerId, () =>
    createClient.execute({ name: 'Pedro' }),
  )
  const service = await runOwnerTool(ownerId, () =>
    createService.execute({
      name: 'Sesión',
      price: 40000,
      unit: 'flat',
      duration_minutes: 60,
    }),
  )
  const rosaAppointment = await runOwnerTool(ownerId, () =>
    createAppointment.execute({
      client_id: rosa.id,
      service_id: service.id,
      starts_at: '2026-09-24T13:00:00Z',
      mode: 'online',
    }),
  )

  const refusal = await refusalOf(
    runOwnerTool(ownerId, () =>
      createPayment.execute({
        client_id: pedro.id,
        appointment_id: rosaAppointment.id,
        amount: 40000,
      }),
    ),
  )

  expect(refusal).toEqual(
    expect.objectContaining({
      kind: 'invalid_input',
      issues: [expect.objectContaining({ path: 'appointment_id' })],
    }),
  )

  const stored = await adminDb
    .select()
    .from(payments)
    .where(eq(payments.owner_id, ownerId))
  expect(stored).toEqual([])
})
