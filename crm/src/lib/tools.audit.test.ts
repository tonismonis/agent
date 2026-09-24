// Tool calls as chat runs them: each in its own Owner transaction via
// runOwnerTool. tools.test.ts wraps whole tests in one transaction, which hides
// what a failed call commits.
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { beforeAll, beforeEach, expect, test } from 'vitest'

import { appointments, audit_log, clients, owners, services } from '#/db/schema'
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
  await adminDb.delete(appointments).where(eq(appointments.owner_id, ownerId))
  await adminDb.delete(clients).where(eq(clients.owner_id, ownerId))
  await adminDb.delete(services).where(eq(services.owner_id, ownerId))
})

test('a failed write is audited and reports its own error', async () => {
  await expect(
    runOwnerTool(ownerId, () =>
      createAppointment.execute({
        client_id: 1,
        service_id: 999999,
        starts_at: '2026-09-24T13:00:00Z',
        mode: 'online',
      }),
    ),
  ).rejects.toThrow(/Service 999999 not found/)

  const [audit] = await failedAudits('createAppointment')
  expect(audit?.error).toMatch(/Service 999999 not found/)
})

test('a write Postgres rejects is audited with the driver error, not the SQL', async () => {
  const failure = runOwnerTool(ownerId, () =>
    createPayment.execute({ client_id: 999999, amount: 1000 }),
  )

  await expect(failure).rejects.toThrow(/foreign key/)
  await expect(failure).rejects.not.toThrow(/Failed query/)
  const [audit] = await failedAudits('createPayment')
  expect(audit?.error).toMatch(/foreign key/)
  expect(audit?.error).not.toMatch(/Failed query|params/)
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
      expect(String(result.reason)).toMatch(/Time conflict/)
    }
  }
  expect(await failedAudits('createAppointment')).toHaveLength(2)
  const booked = await adminDb
    .select()
    .from(appointments)
    .where(eq(appointments.owner_id, ownerId))
  expect(booked).toHaveLength(1)
})
