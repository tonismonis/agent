// Tool calls as chat runs them: each in its own Owner transaction via
// runOwnerTool. tools.test.ts wraps whole tests in one transaction, which hides
// what a failed call commits.
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { beforeAll, beforeEach, expect, test } from 'vitest'

import {
  appointmentSeries,
  appointmentSeriesDays,
  appointments,
  audit_log,
  clients,
  owners,
  payments,
  services,
} from '#/db/schema'
import { readRefusal } from '#/lib/refusal'
import { refusalOf } from '#/test/refusals'
import { addDays, santiagoClockOf, santiagoDateOf, weekdayOf } from '#/lib/santiago-time'
import {
  createAppointment,
  createAppointmentSeries,
  createClient,
  createPayment,
  createService,
  runOwnerTool,
  updateAppointmentSeries,
} from './tools.server'

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
  await adminDb
    .delete(appointmentSeriesDays)
    .where(eq(appointmentSeriesDays.owner_id, ownerId))
  await adminDb
    .delete(appointmentSeries)
    .where(eq(appointmentSeries.owner_id, ownerId))
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

function call<T>(operation: () => Promise<T>) {
  return runOwnerTool(ownerId, operation)
}

async function piano() {
  const pedro = await call(() => createClient.execute({ name: 'Pedro Soto' }))
  const service = await call(() =>
    createService.execute({
      name: 'Piano a domicilio',
      price: 35000,
      unit: 'flat',
      duration_minutes: 60,
    }),
  )
  return { pedro, service }
}

function ownerRows() {
  return adminDb
    .select()
    .from(appointments)
    .where(eq(appointments.owner_id, ownerId))
    .orderBy(appointments.starts_at)
}

test('a series books all or nothing, lists every clash, and books the rest on retry.skip', async () => {
  const { pedro, service } = await piano()
  const ana = await call(() => createClient.execute({ name: 'Ana' }))
  const rosa = await call(() => createClient.execute({ name: 'Rosa' }))
  for (const [client, starts_at] of [
    [ana, '2026-11-17T16:30'],
    [rosa, '2026-12-08T17:00'],
  ] as const)
    await call(() =>
      createAppointment.execute({
        client_id: client.id,
        service_id: service.id,
        starts_at,
        mode: 'online',
      }),
    )
  const input = {
    client_id: pedro.id,
    service_id: service.id,
    weekly: [{ day: 'tuesday' as const, time: '17:00' }],
    from: '2026-09-29',
    end: { until: '2026-12-31' },
    mode: 'in_person' as const,
  }

  const refusal = await refusalOf(call(() => createAppointmentSeries.execute(input)))

  expect(refusal).toEqual({
    kind: 'conflict',
    say: 'No agendé ninguna clase porque 2 de las 14 fechas chocan:\n- martes 17 de noviembre, 17:00: ya tienes a Ana (16:30–17:30)\n- martes 8 de diciembre, 17:00: ya tienes a Rosa (17:00–18:00)',
    of: 14,
    dates: [
      expect.objectContaining({ date: '2026-11-17', problem: 'taken' }),
      expect.objectContaining({ date: '2026-12-08', problem: 'taken' }),
    ],
    retry: { skip: ['2026-11-17', '2026-12-08'] },
  })
  expect(await ownerRows()).toHaveLength(2)
  const [audit] = await failedAudits('createAppointmentSeries')
  expect(readRefusal(audit?.error ?? '')).toEqual(refusal)

  const series = await call(() =>
    createAppointmentSeries.execute({
      ...input,
      skip: refusal.kind === 'conflict' ? refusal.retry?.skip : [],
    }),
  )
  expect(series.classes).toHaveLength(12)
  expect(await ownerRows()).toHaveLength(14)
})

test('retrying the same series cannot book a class twice', async () => {
  const { pedro, service } = await piano()
  const input = {
    client_id: pedro.id,
    service_id: service.id,
    weekly: [{ day: 'tuesday' as const, time: '17:00' }],
    from: '2036-09-30',
    end: { count: 4 },
    mode: 'online' as const,
  }

  const results = await Promise.allSettled([
    call(() => createAppointmentSeries.execute(input)),
    call(() => createAppointmentSeries.execute(input)),
  ])
  const again = await refusalOf(call(() => createAppointmentSeries.execute(input)))

  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(again).toEqual(
    expect.objectContaining({
      kind: 'conflict',
      of: 4,
      retry: { skip: ['2036-09-30', '2036-10-07', '2036-10-14', '2036-10-21'] },
    }),
  )
  expect(await ownerRows()).toHaveLength(4)
})

test('ending a series cancels only its future unpaid classes; undoing it reopens exactly those', async () => {
  const { pedro, service } = await piano()
  const today = santiagoDateOf(new Date())
  const tomorrow = addDays(today, 1)
  const skipped = addDays(tomorrow, 28)
  const series = await call(() =>
    createAppointmentSeries.execute({
      client_id: pedro.id,
      service_id: service.id,
      weekly: [{ day: weekdayOf(tomorrow), time: '17:00' }],
      from: addDays(today, -21),
      end: { until: addDays(today, 50) },
      mode: 'online',
      skip: [skipped],
    }),
  )
  const future = series.classes.filter((each) => each.series_date >= tomorrow)
  const past = series.classes.filter((each) => each.series_date < tomorrow)
  const until = addDays(today, 15)
  const afterEnd = future.filter((each) => each.series_date > until)
  const paid = afterEnd[0]!
  await call(() =>
    createPayment.execute({ client_id: pedro.id, appointment_id: paid.id, amount: 35000 }),
  )

  const ended = await call(() => updateAppointmentSeries.execute({ id: series.id, until }))

  const cancelledIds = afterEnd.slice(1).map((each) => each.id)
  expect(ended.cancelled).toBe(cancelledIds.length)
  expect(ended.kept_paid.map((each) => each.id)).toEqual([paid.id])
  const statusById = new Map(ended.classes.map((each) => [each.id, each.status]))
  for (const id of cancelledIds) expect(statusById.get(id)).toBe('cancelled')
  for (const each of [...past, ...future.filter((f) => f.series_date <= until), paid])
    expect(statusById.get(each.id)).toBe('scheduled')

  const undone = await call(() =>
    updateAppointmentSeries.execute({ id: series.id, until: series.ends_on }),
  )

  expect(undone.reopened).toBe(cancelledIds.length)
  expect(undone.added).toBe(0)
  expect(undone.classes.map((each) => [each.id, each.status])).toEqual(
    series.classes.map((each) => [each.id, 'scheduled']),
  )
  expect(undone.classes.map((each) => each.series_date)).not.toContain(skipped)
  expect(await ownerRows()).toHaveLength(series.classes.length)
})

test('a weekly 17:00 series stays 17:00 in Santiago across both clock changes', async () => {
  const { pedro, service } = await piano()

  const series = await call(() =>
    createAppointmentSeries.execute({
      client_id: pedro.id,
      service_id: service.id,
      weekly: [{ day: 'sunday', time: '17:00' }],
      from: '2026-08-30',
      end: { until: '2027-04-11' },
      mode: 'online',
    }),
  )

  const rows = await ownerRows()
  expect(rows).toHaveLength(33)
  expect(new Set(rows.map((row) => santiagoClockOf(row.starts_at)))).toEqual(new Set(['17:00']))
  expect(
    Object.fromEntries(
      ['2026-08-30', '2026-09-06', '2027-03-28', '2027-04-04'].map((date) => [
        date,
        rows.find((row) => row.series_date === date)?.starts_at.toISOString(),
      ]),
    ),
  ).toEqual({
    '2026-08-30': '2026-08-30T21:00:00.000Z',
    '2026-09-06': '2026-09-06T20:00:00.000Z',
    '2027-03-28': '2027-03-28T20:00:00.000Z',
    '2027-04-04': '2027-04-04T21:00:00.000Z',
  })
  expect(series.classes).toHaveLength(33)
})

test('twice a week is one series: one write, one audit row, classes interleaved', async () => {
  const { pedro, service } = await piano()

  const series = await call(() =>
    createAppointmentSeries.execute({
      client_id: pedro.id,
      service_id: service.id,
      weekly: [
        { day: 'thursday', time: '10:00' },
        { day: 'tuesday', time: '10:00' },
      ],
      from: '2036-09-30',
      end: { count: 8 },
      mode: 'online',
    }),
  )

  expect(series.rule_local).toBe(
    'todos los martes a las 10:00 y los jueves a las 10:00, del 30 de septiembre al 23 de octubre',
  )
  expect(series.classes.map((each) => each.series_date)).toEqual([
    '2036-09-30',
    '2036-10-02',
    '2036-10-07',
    '2036-10-09',
    '2036-10-14',
    '2036-10-16',
    '2036-10-21',
    '2036-10-23',
  ])
  const audits = await adminDb
    .select()
    .from(audit_log)
    .where(and(eq(audit_log.owner_id, ownerId), eq(audit_log.entity, 'series')))
  expect(audits).toEqual([expect.objectContaining({ entity_id: series.id, ok: true })])
})
