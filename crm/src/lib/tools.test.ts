import { eq } from 'drizzle-orm'
import { beforeEach, expect, test } from 'vitest'
import { z } from 'zod'

import { db } from '#/db'
import {
  appointments,
  audit_log,
  clients,
  payments,
  services,
} from '#/db/schema'
import {
  createAppointment,
  createClient,
  createPayment,
  createService,
  findAppointments,
  findClients,
  findPayments,
  findServices,
  softDeleteAppointment,
  softDeleteClient,
  softDeletePayment,
  softDeleteService,
  updateAppointment,
  updateClient,
  updatePayment,
  updateService,
} from './tools'

beforeEach(async () => {
  await db.delete(audit_log)
  await db.delete(payments)
  await db.delete(appointments)
  await db.delete(clients)
  await db.delete(services)
})

test('tool call writes audit_log row', async () => {
  const input = { name: 'Acme', notes: 'New client' }

  const client = await createClient.execute(input)

  const rows = await db.select().from(audit_log)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toEqual(
    expect.objectContaining({
      tool_name: 'createClient',
      input,
      entity: 'client',
      entity_id: client.id,
      before: null,
      ok: true,
      error: null,
    }),
  )
})

test('failed tool call writes audit row with ok=false', async () => {
  const input = {}

  // @ts-expect-error exercising runtime validation
  await expect(createClient.execute(input)).rejects.toBeInstanceOf(z.ZodError)

  const rows = await db.select().from(audit_log)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toEqual(
    expect.objectContaining({
      tool_name: 'createClient',
      input,
      entity: 'client',
      entity_id: null,
      before: null,
      ok: false,
      error: expect.stringContaining('name'),
    }),
  )
})

test('createClient rejects input without name', async () => {
  // @ts-expect-error exercising runtime validation
  await expect(createClient.execute({})).rejects.toBeInstanceOf(z.ZodError)

  const stored = await db.select().from(clients)
  expect(stored).toHaveLength(0)
})

test('createClient then findClients returns the created client', async () => {
  await createClient.execute({ name: 'Acme' })

  const found = await findClients.execute({ query: 'Acme' })

  expect(found).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'Acme' })]),
  )
})

test('read tools write no audit rows', async () => {
  await Promise.all([
    findClients.execute({}),
    findServices.execute({}),
    findAppointments.execute({}),
    findPayments.execute({}),
  ])

  expect(await db.select().from(audit_log)).toEqual([])
})

test('createService then findServices returns it', async () => {
  await createService.execute({ name: 'Consulting', price: 50000, unit: 'hour' })

  const found = await findServices.execute({ query: 'consult' })

  expect(found).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'Consulting', price: 50000, unit: 'hour' }),
    ]),
  )
})

test('updateService changes price', async () => {
  const created = await createService.execute({
    name: 'Consulting',
    price: 50000,
    unit: 'hour',
  })

  await updateService.execute({ id: created.id, price: 75000 })
  const [found] = await findServices.execute({ query: 'Consulting' })

  expect(found.price).toBe(75000)
  expect(found.updated_at.getTime()).toBeGreaterThan(created.updated_at.getTime())
})

test('updateClient changes fields and bumps updated_at', async () => {
  const created = await createClient.execute({ name: 'Acme', notes: 'Old' })

  await updateClient.execute({ id: created.id, name: 'Beta', notes: 'New' })
  const [found] = await findClients.execute({ query: 'Beta' })

  expect(found).toEqual(expect.objectContaining({ name: 'Beta', notes: 'New' }))
  expect(found.updated_at.getTime()).toBeGreaterThan(created.updated_at.getTime())

  const [audit] = await db
    .select()
    .from(audit_log)
    .where(eq(audit_log.tool_name, 'updateClient'))
  expect(audit).toEqual(
    expect.objectContaining({
      entity: 'client',
      entity_id: created.id,
      before: expect.objectContaining({ name: 'Acme', notes: 'Old' }),
      ok: true,
      error: null,
    }),
  )
})

test('softDeleteService hides from findServices', async () => {
  const created = await createService.execute({
    name: 'Consulting',
    price: 50000,
    unit: 'hour',
  })

  await softDeleteService.execute({ id: created.id })
  const found = await findServices.execute({ query: 'Consulting' })

  expect(found).toEqual([])
})

test('softDeleteClient hides client from findClients', async () => {
  const created = await createClient.execute({ name: 'Acme' })

  await softDeleteClient.execute({ id: created.id })
  const found = await findClients.execute({ query: 'Acme' })

  expect(found).toEqual([])
})

test('createAppointment snapshots flat price and computes ends_at', async () => {
  const client = await createClient.execute({ name: 'Rosa' })
  const service = await createService.execute({
    name: 'Home visit',
    price: 40000,
    unit: 'flat',
  })

  const appt = await createAppointment.execute({
    client_id: client.id,
    service_id: service.id,
    starts_at: '2026-08-01T15:00:00.000Z',
    duration_minutes: 90,
    mode: 'in_person',
  })

  expect(appt.price).toBe(40000)
  expect(appt.ends_at).toEqual(new Date('2026-08-01T16:30:00.000Z'))
  expect(appt.status).toBe('scheduled')
})

test('createAppointment derives hourly price from duration', async () => {
  const client = await createClient.execute({ name: 'Rosa' })
  const service = await createService.execute({
    name: 'Lesson',
    price: 15000,
    unit: 'hour',
  })

  const appt = await createAppointment.execute({
    client_id: client.id,
    service_id: service.id,
    starts_at: '2026-08-01T15:00:00.000Z',
    duration_minutes: 90,
    mode: 'online',
  })

  expect(appt.price).toBe(22500)
})

test('createAppointment uses service default duration, overridable by input', async () => {
  const client = await createClient.execute({ name: 'Rosa' })
  const service = await createService.execute({
    name: 'Lesson',
    price: 15000,
    unit: 'hour',
    duration_minutes: 60,
  })

  const byDefault = await createAppointment.execute({
    client_id: client.id,
    service_id: service.id,
    starts_at: '2026-08-01T15:00:00.000Z',
    mode: 'online',
  })
  expect(byDefault.ends_at).toEqual(new Date('2026-08-01T16:00:00.000Z'))
  expect(byDefault.price).toBe(15000)

  const overridden = await createAppointment.execute({
    client_id: client.id,
    service_id: service.id,
    starts_at: '2026-08-02T15:00:00.000Z',
    duration_minutes: 120,
    mode: 'online',
  })
  expect(overridden.ends_at).toEqual(new Date('2026-08-02T17:00:00.000Z'))
  expect(overridden.price).toBe(30000)
})

test('createAppointment throws when duration unresolvable', async () => {
  const client = await createClient.execute({ name: 'Rosa' })
  const service = await createService.execute({
    name: 'Consulting',
    price: 15000,
    unit: 'hour',
  })

  await expect(
    createAppointment.execute({
      client_id: client.id,
      service_id: service.id,
      starts_at: '2026-08-01T15:00:00.000Z',
      mode: 'online',
    }),
  ).rejects.toThrow(/duration/i)

  expect(await db.select().from(appointments)).toHaveLength(0)
})

test('createAppointment rejects overlap with conflicting client name in message', async () => {
  const rosa = await createClient.execute({ name: 'Rosa' })
  const pedro = await createClient.execute({ name: 'Pedro' })
  const service = await createService.execute({
    name: 'Lesson',
    price: 15000,
    unit: 'hour',
    duration_minutes: 60,
  })

  await createAppointment.execute({
    client_id: rosa.id,
    service_id: service.id,
    starts_at: '2026-08-01T15:00:00.000Z',
    mode: 'online',
  })

  await expect(
    createAppointment.execute({
      client_id: pedro.id,
      service_id: service.id,
      starts_at: '2026-08-01T15:30:00.000Z',
      mode: 'online',
    }),
  ).rejects.toThrow(/Rosa/)

  expect(await db.select().from(appointments)).toHaveLength(1)
})

test('createAppointment allows adjacent back-to-back appointments', async () => {
  const rosa = await createClient.execute({ name: 'Rosa' })
  const pedro = await createClient.execute({ name: 'Pedro' })
  const service = await createService.execute({
    name: 'Lesson',
    price: 15000,
    unit: 'hour',
    duration_minutes: 60,
  })

  await createAppointment.execute({
    client_id: rosa.id,
    service_id: service.id,
    starts_at: '2026-08-01T15:00:00.000Z',
    mode: 'online',
  })

  const second = await createAppointment.execute({
    client_id: pedro.id,
    service_id: service.id,
    starts_at: '2026-08-01T16:00:00.000Z',
    mode: 'online',
  })

  expect(second.starts_at).toEqual(new Date('2026-08-01T16:00:00.000Z'))
  expect(await db.select().from(appointments)).toHaveLength(2)
})

test('cancelled and soft-deleted appointments do not block a slot', async () => {
  const rosa = await createClient.execute({ name: 'Rosa' })
  const pedro = await createClient.execute({ name: 'Pedro' })
  const service = await createService.execute({
    name: 'Lesson',
    price: 15000,
    unit: 'hour',
    duration_minutes: 60,
  })

  const cancelled = await createAppointment.execute({
    client_id: rosa.id,
    service_id: service.id,
    starts_at: '2026-08-01T15:00:00.000Z',
    mode: 'online',
  })
  await db
    .update(appointments)
    .set({ status: 'cancelled' })
    .where(eq(appointments.id, cancelled.id))

  const deleted = await createAppointment.execute({
    client_id: rosa.id,
    service_id: service.id,
    starts_at: '2026-08-01T18:00:00.000Z',
    mode: 'online',
  })
  await db
    .update(appointments)
    .set({ deleted_at: new Date() })
    .where(eq(appointments.id, deleted.id))

  const a = await createAppointment.execute({
    client_id: pedro.id,
    service_id: service.id,
    starts_at: '2026-08-01T15:30:00.000Z',
    mode: 'online',
  })
  const b = await createAppointment.execute({
    client_id: pedro.id,
    service_id: service.id,
    starts_at: '2026-08-01T18:30:00.000Z',
    mode: 'online',
  })

  expect(a.id).toBeDefined()
  expect(b.id).toBeDefined()
})

test('updateAppointment reschedules, preserving duration and excluding self from overlap', async () => {
  const rosa = await createClient.execute({ name: 'Rosa' })
  const service = await createService.execute({
    name: 'Lesson',
    price: 15000,
    unit: 'hour',
    duration_minutes: 60,
  })
  const appt = await createAppointment.execute({
    client_id: rosa.id,
    service_id: service.id,
    starts_at: '2026-08-01T15:00:00.000Z',
    mode: 'online',
  })

  const updated = await updateAppointment.execute({
    id: appt.id,
    starts_at: '2026-08-01T15:30:00.000Z',
  })

  expect(updated.starts_at).toEqual(new Date('2026-08-01T15:30:00.000Z'))
  expect(updated.ends_at).toEqual(new Date('2026-08-01T16:30:00.000Z'))
  expect(updated.updated_at.getTime()).toBeGreaterThan(appt.updated_at.getTime())
})

test('updateAppointment reschedule rejects overlap with another appointment', async () => {
  const rosa = await createClient.execute({ name: 'Rosa' })
  const pedro = await createClient.execute({ name: 'Pedro' })
  const service = await createService.execute({
    name: 'Lesson',
    price: 15000,
    unit: 'hour',
    duration_minutes: 60,
  })
  const rosaAppt = await createAppointment.execute({
    client_id: rosa.id,
    service_id: service.id,
    starts_at: '2026-08-01T15:00:00.000Z',
    mode: 'online',
  })
  await createAppointment.execute({
    client_id: pedro.id,
    service_id: service.id,
    starts_at: '2026-08-01T17:00:00.000Z',
    mode: 'online',
  })

  await expect(
    updateAppointment.execute({
      id: rosaAppt.id,
      starts_at: '2026-08-01T17:30:00.000Z',
    }),
  ).rejects.toThrow(/Pedro/)

  const [found] = await db
    .select()
    .from(appointments)
    .where(eq(appointments.id, rosaAppt.id))
  expect(found.starts_at).toEqual(new Date('2026-08-01T15:00:00.000Z'))
})

test('findAppointments filters by client, starts_at range, and status; excludes soft-deleted', async () => {
  const rosa = await createClient.execute({ name: 'Rosa' })
  const pedro = await createClient.execute({ name: 'Pedro' })
  const service = await createService.execute({
    name: 'Lesson',
    price: 15000,
    unit: 'hour',
    duration_minutes: 60,
  })
  const rosaAug1 = await createAppointment.execute({
    client_id: rosa.id,
    service_id: service.id,
    starts_at: '2026-08-01T15:00:00.000Z',
    mode: 'online',
  })
  await createAppointment.execute({
    client_id: rosa.id,
    service_id: service.id,
    starts_at: '2026-08-05T15:00:00.000Z',
    mode: 'online',
  })
  await createAppointment.execute({
    client_id: pedro.id,
    service_id: service.id,
    starts_at: '2026-08-01T17:00:00.000Z',
    mode: 'online',
  })

  expect(await findAppointments.execute({ client_id: rosa.id })).toHaveLength(2)

  const ranged = await findAppointments.execute({
    from: '2026-08-03T00:00:00.000Z',
    to: '2026-08-10T00:00:00.000Z',
  })
  expect(ranged).toHaveLength(1)
  expect(ranged[0].starts_at).toEqual(new Date('2026-08-05T15:00:00.000Z'))

  await db
    .update(appointments)
    .set({ status: 'completed' })
    .where(eq(appointments.id, rosaAug1.id))
  const completed = await findAppointments.execute({ status: 'completed' })
  expect(completed).toHaveLength(1)
  expect(completed[0].id).toBe(rosaAug1.id)

  await softDeleteAppointment.execute({ id: rosaAug1.id })
  expect(await findAppointments.execute({ status: 'completed' })).toHaveLength(0)
})

test('createPayment then findPayments sums a month window', async () => {
  const rosa = await createClient.execute({ name: 'Rosa' })

  await createPayment.execute({
    client_id: rosa.id,
    amount: 30000,
    paid_at: '2026-08-03T12:00:00.000Z',
  })
  await createPayment.execute({
    client_id: rosa.id,
    amount: 45000,
    paid_at: '2026-08-20T12:00:00.000Z',
  })
  await createPayment.execute({
    client_id: rosa.id,
    amount: 22500,
    paid_at: '2026-08-28T12:00:00.000Z',
  })
  await createPayment.execute({
    client_id: rosa.id,
    amount: 99999,
    paid_at: '2026-09-02T12:00:00.000Z',
  })

  const august = await findPayments.execute({
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-09-01T00:00:00.000Z',
  })

  expect(august).toHaveLength(3)
  expect(august.reduce((sum, p) => sum + p.amount, 0)).toBe(97500)
})

test('createPayment defaults paid_at to now', async () => {
  const rosa = await createClient.execute({ name: 'Rosa' })
  const before = Date.now()

  const payment = await createPayment.execute({ client_id: rosa.id, amount: 5000 })

  expect(payment.paid_at.getTime()).toBeGreaterThanOrEqual(before - 1000)
})

test('softDeleteAppointment hides it from findAppointments', async () => {
  const rosa = await createClient.execute({ name: 'Rosa' })
  const service = await createService.execute({
    name: 'Lesson',
    price: 15000,
    unit: 'hour',
    duration_minutes: 60,
  })
  const appt = await createAppointment.execute({
    client_id: rosa.id,
    service_id: service.id,
    starts_at: '2026-08-01T15:00:00.000Z',
    mode: 'online',
  })

  await softDeleteAppointment.execute({ id: appt.id })

  expect(await findAppointments.execute({ client_id: rosa.id })).toEqual([])
})

test('softDeletePayment hides it from findPayments', async () => {
  const rosa = await createClient.execute({ name: 'Rosa' })
  const payment = await createPayment.execute({
    client_id: rosa.id,
    amount: 5000,
    paid_at: '2026-08-01T12:00:00.000Z',
  })

  await softDeletePayment.execute({ id: payment.id })

  expect(await findPayments.execute({ client_id: rosa.id })).toEqual([])
})

test('updates and deletes audit each entity with its pre-mutation row', async () => {
  const client = await createClient.execute({ name: 'Rosa' })
  const service = await createService.execute({
    name: 'Lesson',
    price: 15000,
    unit: 'hour',
    duration_minutes: 60,
  })
  const appointment = await createAppointment.execute({
    client_id: client.id,
    service_id: service.id,
    starts_at: '2026-08-01T15:00:00.000Z',
    mode: 'online',
  })
  const payment = await createPayment.execute({
    client_id: client.id,
    amount: 15000,
  })
  await db.delete(audit_log)

  await updateClient.execute({ id: client.id, notes: 'Updated' })
  await updateService.execute({ id: service.id, price: 20000 })
  await updateAppointment.execute({ id: appointment.id, notes: 'Updated' })
  await updatePayment.execute({ id: payment.id, amount: 20000 })
  await softDeleteClient.execute({ id: client.id })
  await softDeleteService.execute({ id: service.id })
  await softDeleteAppointment.execute({ id: appointment.id })
  await softDeletePayment.execute({ id: payment.id })

  const rows = await db.select().from(audit_log)
  const expected = [
    ['updateClient', 'client', client.id],
    ['updateService', 'service', service.id],
    ['updateAppointment', 'appointment', appointment.id],
    ['updatePayment', 'payment', payment.id],
    ['softDeleteClient', 'client', client.id],
    ['softDeleteService', 'service', service.id],
    ['softDeleteAppointment', 'appointment', appointment.id],
    ['softDeletePayment', 'payment', payment.id],
  ] as const

  expect(rows).toHaveLength(expected.length)
  for (const [toolName, entity, entityId] of expected) {
    expect(rows.find((row) => row.tool_name === toolName)).toEqual(
      expect.objectContaining({
        entity,
        entity_id: entityId,
        before: expect.objectContaining({ id: entityId }),
        ok: true,
        error: null,
      }),
    )
  }
})

test('appointment and payment tools write audit rows, ok=false on overlap', async () => {
  const rosa = await createClient.execute({ name: 'Rosa' })
  const pedro = await createClient.execute({ name: 'Pedro' })
  const service = await createService.execute({
    name: 'Lesson',
    price: 15000,
    unit: 'hour',
    duration_minutes: 60,
  })

  await createAppointment.execute({
    client_id: rosa.id,
    service_id: service.id,
    starts_at: '2026-08-01T15:00:00.000Z',
    mode: 'online',
  })
  await createPayment.execute({ client_id: rosa.id, amount: 15000 })
  await expect(
    createAppointment.execute({
      client_id: pedro.id,
      service_id: service.id,
      starts_at: '2026-08-01T15:30:00.000Z',
      mode: 'online',
    }),
  ).rejects.toThrow(/Rosa/)

  const rows = await db.select().from(audit_log)
  const ok = rows.filter((r) => r.tool_name === 'createAppointment' && r.ok)
  const failed = rows.filter((r) => r.tool_name === 'createAppointment' && !r.ok)
  expect(ok).toHaveLength(1)
  expect(ok[0]).toEqual(
    expect.objectContaining({
      entity: 'appointment',
      entity_id: expect.any(Number),
      before: null,
      error: null,
    }),
  )
  expect(failed).toHaveLength(1)
  expect(failed[0]).toEqual(
    expect.objectContaining({
      entity: 'appointment',
      entity_id: null,
      before: null,
      error: expect.stringContaining('Rosa'),
    }),
  )
  expect(rows).toContainEqual(
    expect.objectContaining({
      tool_name: 'createPayment',
      entity: 'payment',
      entity_id: expect.any(Number),
      before: null,
      ok: true,
      error: null,
    }),
  )
})

test('createAppointment throws clean error for nonexistent or deleted service', async () => {
  const rosa = await createClient.execute({ name: 'Rosa' })

  await expect(
    createAppointment.execute({
      client_id: rosa.id,
      service_id: 999999,
      starts_at: '2026-08-01T15:00:00.000Z',
      duration_minutes: 60,
      mode: 'online',
    }),
  ).rejects.toThrow(/Service 999999 not found/)

  const deleted = await createService.execute({
    name: 'Gone',
    price: 15000,
    unit: 'hour',
    duration_minutes: 60,
  })
  await softDeleteService.execute({ id: deleted.id })

  await expect(
    createAppointment.execute({
      client_id: rosa.id,
      service_id: deleted.id,
      starts_at: '2026-08-01T15:00:00.000Z',
      mode: 'online',
    }),
  ).rejects.toThrow(new RegExp(`Service ${deleted.id} not found`))
})

test('updateAppointment throws clean error for nonexistent appointment', async () => {
  await expect(
    updateAppointment.execute({
      id: 999999,
      starts_at: '2026-08-01T15:00:00.000Z',
    }),
  ).rejects.toThrow(/Appointment 999999 not found/)
})

test('updateAppointment reviving to scheduled re-runs overlap check', async () => {
  const rosa = await createClient.execute({ name: 'Rosa' })
  const pedro = await createClient.execute({ name: 'Pedro' })
  const service = await createService.execute({
    name: 'Lesson',
    price: 15000,
    unit: 'hour',
    duration_minutes: 60,
  })
  const rosaAppt = await createAppointment.execute({
    client_id: rosa.id,
    service_id: service.id,
    starts_at: '2026-08-01T15:00:00.000Z',
    mode: 'online',
  })
  await updateAppointment.execute({ id: rosaAppt.id, status: 'cancelled' })

  // slot rebooked for pedro while rosa's was cancelled
  await createAppointment.execute({
    client_id: pedro.id,
    service_id: service.id,
    starts_at: '2026-08-01T15:00:00.000Z',
    mode: 'online',
  })

  await expect(
    updateAppointment.execute({ id: rosaAppt.id, status: 'scheduled' }),
  ).rejects.toThrow(/Pedro/)
})
