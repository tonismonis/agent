import { generateTypeStubs, toolsToBindings } from '@tanstack/ai-code-mode'
import { eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { aroundEach, beforeAll, beforeEach, expect, test } from 'vitest'
import { db, withOwnerTxn } from '#/db'
import { chatTools } from './chat-tools'
import { readRefusal } from './refusal'
import { refusalOf } from '#/test/refusals'
import {
  appointments,
  audit_log,
  clients,
  owners,
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
  listAuditLog,
  restoreAppointment,
  restoreClient,
  restorePayment,
  restoreService,
  softDeleteAppointment,
  softDeleteClient,
  softDeletePayment,
  softDeleteService,
  updateAppointment,
  updateClient,
  updateOwnerProfile,
  updatePayment,
  updateService,
} from './tools'

const ownerA = '11111111-1111-4111-8111-111111111111'
const ownerB = '22222222-2222-4222-8222-222222222222'
const adminDb = drizzle(
  process.env.DATABASE_ADMIN_URL ?? 'postgresql://crm:crm@localhost:5433/crm',
)

beforeAll(async () => {
  await adminDb
    .insert(owners)
    .values([
      {
        id: ownerA,
        email: 'alice@example.test',
        name: 'Alice',
        profession: 'Consultant',
      },
      {
        id: ownerB,
        email: 'bob@example.test',
        name: 'Bob',
        profession: 'Consultant',
      },
    ])
    .onConflictDoNothing()
})

beforeEach(async () => {
  const ownerIds = [ownerA, ownerB]
  await adminDb.delete(audit_log).where(inArray(audit_log.owner_id, ownerIds))
  await adminDb.delete(payments).where(inArray(payments.owner_id, ownerIds))
  await adminDb
    .delete(appointments)
    .where(inArray(appointments.owner_id, ownerIds))
  await adminDb.delete(clients).where(inArray(clients.owner_id, ownerIds))
  await adminDb.delete(services).where(inArray(services.owner_id, ownerIds))
  await adminDb
    .update(owners)
    .set({ name: 'Alice', profession: 'Consultant', restricted_notes: false })
    .where(eq(owners.id, ownerA))
})

aroundEach((runTest) => withOwnerTxn(ownerA, runTest))

test('chat registers restore and audit tools', () => {
  expect(chatTools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining([
      'restoreClient',
      'restoreService',
      'restoreAppointment',
      'restorePayment',
      'listAuditLog',
      'update_owner_profile',
    ]),
  )
})

test('no chat tool stores or computes availability (ADR 0006)', () => {
  const names = chatTools.map((tool) => tool.name)
  expect(names.filter((name) => /slot|hours|availab|schedule/i.test(name))).toEqual([])
})

test('code-mode stubs carry every tool result shape', () => {
  const stubs = generateTypeStubs(toolsToBindings(chatTools))

  expect(stubs).not.toContain('Promise<unknown>')
  expect(stubs).toContain(
    'declare function createClient(input: CreateClientInput): Promise<CreateClientOutput>',
  )
  expect(stubs).toContain('deleted_at: string | null;')
})

test('code-mode bindings hand the model validated JSON', async () => {
  const bindings = toolsToBindings(chatTools)

  const created = await bindings.createClient.execute({
    name: 'Rosa',
    notes: 'private',
  })

  expect(created).toEqual(
    expect.objectContaining({
      name: 'Rosa',
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
      deleted_at: null,
    }),
  )
  expect(
    await refusalOf(bindings.updateClient.execute({ id: 987_654_321 })),
  ).toEqual(
    expect.objectContaining({ kind: 'not_found', entity: 'client', id: 987_654_321 }),
  )

  await adminDb
    .update(owners)
    .set({ restricted_notes: true })
    .where(eq(owners.id, ownerA))

  const rows = await bindings.findClients.execute({})
  expect(JSON.stringify(rows)).not.toContain('private')
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

test('failed tool call writes audit row with ok=false and the refusal', async () => {
  const refusal = await refusalOf(updateClient.execute({ id: 987_654_321, name: 'X' }))

  const rows = await db.select().from(audit_log)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toEqual(
    expect.objectContaining({
      tool_name: 'updateClient',
      input: { id: 987_654_321, name: 'X' },
      entity: 'client',
      entity_id: 987_654_321,
      before: null,
      ok: false,
    }),
  )
  expect(readRefusal(rows[0]?.error ?? '')).toEqual(refusal)
})

test('invalid input is refused before anything runs, with no audit row', async () => {
  // @ts-expect-error exercising runtime validation
  const refusal = await refusalOf(createClient.execute({ name: 7 }))

  expect(refusal).toEqual(
    expect.objectContaining({
      kind: 'invalid_input',
      issues: [expect.objectContaining({ path: 'name' })],
    }),
  )
  expect(refusal).not.toHaveProperty('say')
  expect(await db.select().from(audit_log)).toEqual([])
  expect(await db.select().from(clients)).toEqual([])
})

test("a missing field the guide can ask for becomes the Owner's question", async () => {
  // @ts-expect-error exercising runtime validation
  const refusal = await refusalOf(createClient.execute({}))

  expect(refusal).toEqual({ kind: 'ask', say: '¿Cómo se llama?', needs: ['name'] })
  expect(await db.select().from(audit_log)).toEqual([])
})

test('createClient then findClients returns the created client', async () => {
  await createClient.execute({ name: 'Acme' })

  const found = await findClients.execute({ query: 'Acme' })

  expect(found).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'Acme' })]),
  )
})

test('owner cannot read another owner client via tools', async () => {
  await createClient.execute({ name: 'Alice Client' })
  await withOwnerTxn(ownerB, () =>
    createClient.execute({ name: 'Bob Client' }),
  )

  expect(await findClients.execute({})).toEqual([
    expect.objectContaining({ name: 'Alice Client', owner_id: ownerA }),
  ])
})

test('owner cannot update another owner client via tools', async () => {
  const bobClient = await withOwnerTxn(ownerB, () =>
    createClient.execute({ name: 'Bob Client' }),
  )

  expect(
    await refusalOf(updateClient.execute({ id: bobClient.id, name: 'Stolen' })),
  ).toEqual(expect.objectContaining({ kind: 'not_found', id: bobClient.id }))
  expect(
    await withOwnerTxn(ownerB, () => findClients.execute({})),
  ).toEqual([
    expect.objectContaining({ id: bobClient.id, name: 'Bob Client' }),
  ])
})

test('read tools write no audit rows', async () => {
  await findClients.execute({})
  await findServices.execute({})
  await findAppointments.execute({})
  await findPayments.execute({})

  expect(await db.select().from(audit_log)).toEqual([])
})

test('listAuditLog filters records and can explicitly list all without auditing', async () => {
  await db.insert(audit_log).values([
    {
      tool_name: 'updateClient',
      input: { id: 7 },
      entity: 'client',
      entity_id: 7,
      before: { id: 7, name: 'Before' },
      ok: true,
      error: null,
      ts: new Date('2026-08-01T10:00:00.000Z'),
    },
    {
      tool_name: 'restoreClient',
      input: { id: 7 },
      entity: 'client',
      entity_id: 7,
      before: { id: 7 },
      ok: false,
      error: 'conflict',
      ts: new Date('2026-08-02T10:00:00.000Z'),
    },
    {
      tool_name: 'updateService',
      input: { id: 9 },
      entity: 'service',
      entity_id: 9,
      before: { id: 9 },
      ok: false,
      error: 'failed',
      ts: new Date('2026-08-03T10:00:00.000Z'),
    },
  ])

  const filtered = await listAuditLog.execute({
    entity: 'client',
    entity_id: 7,
    since: '2026-08-02T00:00:00.000Z',
    until: '2026-08-02T23:59:59.999Z',
    ok: false,
  })
  const all = await listAuditLog.execute({ all: true })

  expect(filtered).toEqual([
    expect.objectContaining({ tool_name: 'restoreClient', entity_id: 7 }),
  ])
  expect(all).toHaveLength(3)
  expect(await db.select().from(audit_log)).toHaveLength(3)
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
  expect(found.updated_at.getTime()).toBeGreaterThanOrEqual(
    created.updated_at.getTime(),
  )
})

test('updateClient changes fields and bumps updated_at', async () => {
  const created = await createClient.execute({ name: 'Acme', notes: 'Old' })

  await updateClient.execute({ id: created.id, name: 'Beta', notes: 'New' })
  const [found] = await findClients.execute({ query: 'Beta' })

  expect(found).toEqual(expect.objectContaining({ name: 'Beta', notes: 'New' }))
  expect(found.updated_at.getTime()).toBeGreaterThanOrEqual(
    created.updated_at.getTime(),
  )

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

test('softDeleteClient rejects scheduled future appointments with details', async () => {
  const client = await createClient.execute({ name: 'Acme' })
  const service = await createService.execute({
    name: 'Lesson',
    price: 15000,
    unit: 'hour',
    duration_minutes: 60,
  })
  const later = await createAppointment.execute({
    client_id: client.id,
    service_id: service.id,
    starts_at: '2036-10-02T17:00',
    mode: 'online',
  })
  const first = await createAppointment.execute({
    client_id: client.id,
    service_id: service.id,
    starts_at: '2036-10-01T17:00',
    mode: 'online',
  })

  expect(await refusalOf(softDeleteClient.execute({ id: client.id }))).toEqual({
    kind: 'blocked',
    say: 'Acme tiene 2 citas agendadas desde hoy, la primera el miércoles 1 de octubre a las 17:00. Hay que cancelarlas o borrarlas antes de borrar a Acme.',
    appointments: [
      { id: first.id, starts_local: 'miércoles 1 de octubre, 17:00', series_id: null },
      { id: later.id, starts_local: 'jueves 2 de octubre, 17:00', series_id: null },
    ],
  })

  expect(await findClients.execute({ query: 'Acme' })).toHaveLength(1)
  expect(await findAppointments.execute({ client_id: client.id })).toHaveLength(2)
})

test('softDeleteClient allows past, completed, and cancelled appointments without cascades', async () => {
  const client = await createClient.execute({ name: 'Acme' })
  const service = await createService.execute({
    name: 'Lesson',
    price: 15000,
    unit: 'hour',
    duration_minutes: 60,
  })
  const past = await createAppointment.execute({
    client_id: client.id,
    service_id: service.id,
    starts_at: new Date(Date.now() - 86_400_000).toISOString(),
    mode: 'online',
  })
  const completed = await createAppointment.execute({
    client_id: client.id,
    service_id: service.id,
    starts_at: new Date(Date.now() + 86_400_000).toISOString(),
    mode: 'online',
  })
  const cancelled = await createAppointment.execute({
    client_id: client.id,
    service_id: service.id,
    starts_at: new Date(Date.now() + 172_800_000).toISOString(),
    mode: 'online',
  })
  await updateAppointment.execute({ id: completed.id, status: 'completed' })
  await updateAppointment.execute({ id: cancelled.id, status: 'cancelled' })

  await softDeleteClient.execute({ id: client.id })

  expect(await findClients.execute({ query: 'Acme' })).toEqual([])
  expect(await findAppointments.execute({ client_id: client.id })).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: past.id, deleted_at: null }),
      expect.objectContaining({ id: completed.id, deleted_at: null }),
      expect.objectContaining({ id: cancelled.id, deleted_at: null }),
    ]),
  )
})

test('restoreClient makes a deleted client active and audits its deleted state', async () => {
  const client = await createClient.execute({ name: 'Acme' })
  const deleted = await softDeleteClient.execute({ id: client.id })

  const restored = await restoreClient.execute({ id: client.id })

  expect(restored.deleted_at).toBeNull()
  expect(await findClients.execute({ query: 'Acme' })).toHaveLength(1)
  expect(await db.select().from(audit_log)).toContainEqual(
    expect.objectContaining({
      tool_name: 'restoreClient',
      entity: 'client',
      entity_id: client.id,
      before: expect.objectContaining({
        id: client.id,
        deleted_at: deleted.deleted_at?.toISOString(),
      }),
      ok: true,
      error: null,
    }),
  )
})

test('restoreAppointment makes a deleted appointment active', async () => {
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
  await softDeleteAppointment.execute({ id: appointment.id })

  const restored = await restoreAppointment.execute({ id: appointment.id })

  expect(restored.deleted_at).toBeNull()
  expect(await findAppointments.execute({ client_id: client.id })).toHaveLength(1)
})

test('restoreAppointment rejects a rebooked slot with conflict details', async () => {
  const rosa = await createClient.execute({ name: 'Rosa' })
  const pedro = await createClient.execute({ name: 'Pedro' })
  const service = await createService.execute({
    name: 'Lesson',
    price: 15000,
    unit: 'hour',
    duration_minutes: 60,
  })
  const deleted = await createAppointment.execute({
    client_id: rosa.id,
    service_id: service.id,
    starts_at: '2026-08-01T15:00:00.000Z',
    mode: 'online',
  })
  await softDeleteAppointment.execute({ id: deleted.id })
  await createAppointment.execute({
    client_id: pedro.id,
    service_id: service.id,
    starts_at: '2026-08-01T15:30:00.000Z',
    mode: 'online',
  })

  expect(await refusalOf(restoreAppointment.execute({ id: deleted.id }))).toEqual(
    expect.objectContaining({
      kind: 'conflict',
      say: 'No pude restaurar la cita. El sábado 1 de agosto a las 11:00 ya tienes a Pedro, de 11:30 a 12:30.',
    }),
  )

  expect((await db.select().from(appointments)).find((a) => a.id === deleted.id))
    .toEqual(expect.objectContaining({ deleted_at: expect.any(Date) }))
  expect(await db.select().from(audit_log)).toContainEqual(
    expect.objectContaining({
      tool_name: 'restoreAppointment',
      entity_id: deleted.id,
      before: expect.objectContaining({ id: deleted.id }),
      ok: false,
      error: expect.stringContaining('11:30–12:30'),
    }),
  )
})

test('restoreService and restorePayment make deleted rows active', async () => {
  const client = await createClient.execute({ name: 'Acme' })
  const service = await createService.execute({
    name: 'Lesson',
    price: 15000,
    unit: 'hour',
  })
  const payment = await createPayment.execute({
    client_id: client.id,
    amount: 15000,
  })
  await softDeleteService.execute({ id: service.id })
  await softDeletePayment.execute({ id: payment.id })

  await restoreService.execute({ id: service.id })
  await restorePayment.execute({ id: payment.id })

  expect(await findServices.execute({ query: 'Lesson' })).toHaveLength(1)
  expect(await findPayments.execute({ client_id: client.id })).toHaveLength(1)
  const restoreRows = (await db.select().from(audit_log)).filter((row) =>
    row.tool_name.startsWith('restore'),
  )
  expect(restoreRows).toEqual([
    expect.objectContaining({ entity: 'service', before: expect.any(Object) }),
    expect.objectContaining({ entity: 'payment', before: expect.any(Object) }),
  ])
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

  expect(
    await refusalOf(
      createAppointment.execute({
        client_id: client.id,
        service_id: service.id,
        starts_at: '2026-08-01T15:00:00.000Z',
        mode: 'online',
      }),
    ),
  ).toEqual({
    kind: 'ask',
    say: '¿Cuánto dura cada sesión de Consulting?',
    needs: ['duration_minutes'],
  })

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

  expect(
    await refusalOf(
      createAppointment.execute({
        client_id: pedro.id,
        service_id: service.id,
        starts_at: '2026-08-01T15:30:00.000Z',
        mode: 'online',
      }),
    ),
  ).toEqual(
    expect.objectContaining({
      kind: 'conflict',
      say: 'El sábado 1 de agosto a las 11:30 ya tienes a Rosa, de 11:00 a 12:00.',
      of: 1,
    }),
  )

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
  expect(updated.updated_at.getTime()).toBeGreaterThanOrEqual(
    appt.updated_at.getTime(),
  )
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

test('findAppointments filters by client, overlapping range, and status; excludes soft-deleted', async () => {
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

  const straddling = await createAppointment.execute({
    client_id: pedro.id,
    service_id: service.id,
    starts_at: '2026-08-02T23:30:00.000Z',
    mode: 'online',
  })

  expect(await findAppointments.execute({ client_id: rosa.id })).toHaveLength(2)

  const ranged = await findAppointments.execute({
    from: '2026-08-03T00:00:00.000Z',
    to: '2026-08-10T00:00:00.000Z',
  })
  expect(ranged.map((a) => a.starts_at)).toEqual([
    straddling.starts_at,
    new Date('2026-08-05T15:00:00.000Z'),
  ])

  const saturday = await findAppointments.execute({
    from: '2026-08-01',
    to: '2026-08-01',
  })
  expect(
    saturday.map(({ starts_local, ends_local }) => [starts_local, ends_local]),
  ).toEqual([
    ['sábado 1 de agosto, 11:00', 'sábado 1 de agosto, 12:00'],
    ['sábado 1 de agosto, 13:00', 'sábado 1 de agosto, 14:00'],
  ])

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

test('createAppointment reads an offsetless time as Santiago clock time', async () => {
  const client = await createClient.execute({ name: 'Pedro' })
  const service = await createService.execute({
    name: 'Clase',
    price: 35000,
    unit: 'flat',
    duration_minutes: 60,
  })

  const booked = await createAppointment.execute({
    client_id: client.id,
    service_id: service.id,
    starts_at: '2026-10-01T17:00',
    mode: 'in_person',
  })

  expect(booked.starts_at).toEqual(new Date('2026-10-01T20:00:00.000Z'))
  expect(
    await refusalOf(
      createAppointment.execute({
        client_id: client.id,
        service_id: service.id,
        starts_at: '2026-09-06T00:30',
        mode: 'in_person',
      }),
    ),
  ).toEqual({
    kind: 'conflict',
    say: 'El domingo 6 de septiembre no existe la hora 00:30: esa noche se adelanta el reloj.',
    of: 1,
    dates: [{ date: '2026-09-06', time: '00:30', problem: 'no_such_hour' }],
  })
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

test('createPayment reads a bare paid_at date as the start of that Santiago day', async () => {
  const rosa = await createClient.execute({ name: 'Rosa' })

  const payment = await createPayment.execute({
    client_id: rosa.id,
    amount: 5000,
    paid_at: '2026-09-29',
  })

  expect(payment.paid_at.toISOString()).toBe('2026-09-29T03:00:00.000Z')
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
  await updateClient.execute({ id: client.id, notes: 'Updated' })
  await updateService.execute({ id: service.id, price: 20000 })
  await updateAppointment.execute({
    id: appointment.id,
    notes: 'Updated',
    status: 'completed',
  })
  await updatePayment.execute({ id: payment.id, amount: 20000 })
  await softDeleteClient.execute({ id: client.id })
  await softDeleteService.execute({ id: service.id })
  await softDeleteAppointment.execute({ id: appointment.id })
  await softDeletePayment.execute({ id: payment.id })

  const rows = (await db.select().from(audit_log)).filter(
    (row) =>
      row.tool_name.startsWith('update') ||
      row.tool_name.startsWith('softDelete'),
  )
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

  expect(
    await refusalOf(
      createAppointment.execute({
        client_id: rosa.id,
        service_id: 999999,
        starts_at: '2026-08-01T15:00:00.000Z',
        duration_minutes: 60,
        mode: 'online',
      }),
    ),
  ).toEqual(expect.objectContaining({ kind: 'not_found', entity: 'service', id: 999999 }))

  const deleted = await createService.execute({
    name: 'Gone',
    price: 15000,
    unit: 'hour',
    duration_minutes: 60,
  })
  await softDeleteService.execute({ id: deleted.id })

  expect(
    await refusalOf(
      createAppointment.execute({
        client_id: rosa.id,
        service_id: deleted.id,
        starts_at: '2026-08-01T15:00:00.000Z',
        mode: 'online',
      }),
    ),
  ).toEqual(expect.objectContaining({ kind: 'not_found', id: deleted.id }))
})

test('updateAppointment throws clean error for nonexistent appointment', async () => {
  expect(
    await refusalOf(
      updateAppointment.execute({
        id: 999999,
        starts_at: '2026-08-01T15:00:00.000Z',
      }),
    ),
  ).toEqual(
    expect.objectContaining({ kind: 'not_found', entity: 'appointment', id: 999999 }),
  )
})

test('restricted notes rejects writes and removes notes from all tool reads', async () => {
  const client = await createClient.execute({ name: 'Rosa', notes: 'private' })
  const service = await createService.execute({
    name: 'Lesson',
    price: 15000,
    unit: 'hour',
    duration_minutes: 60,
  })
  const appointment = await createAppointment.execute({
    client_id: client.id,
    service_id: service.id,
    starts_at: '2026-08-03T14:00:00.000Z',
    mode: 'online',
    notes: 'private',
  })
  await createPayment.execute({
    client_id: client.id,
    appointment_id: appointment.id,
    amount: 15000,
    notes: 'cash',
  })
  await adminDb
    .update(owners)
    .set({ restricted_notes: true })
    .where(eq(owners.id, ownerA))

  await expect(
    updateClient.execute({ id: client.id, notes: 'blocked' }),
  ).rejects.toThrow(/notes_off/)
  await expect(
    updateAppointment.execute({ id: appointment.id, notes: 'blocked' }),
  ).rejects.toThrow(/notes_off/)
  await expect(
    createPayment.execute({ client_id: client.id, amount: 1, notes: 'cash' }),
  ).rejects.toThrow(/notes_off/)

  for (const rows of [
    await findClients.execute({}),
    await findAppointments.execute({}),
    await findPayments.execute({}),
    await listAuditLog.execute({ all: true }),
  ]) {
    expect(JSON.stringify(rows)).not.toContain('private')
    expect(JSON.stringify(rows)).not.toContain('cash')
    expect(rows.some((row) => 'notes' in row)).toBe(false)
  }
})

test('updateOwnerProfile changes name only and exposes no operator fields', async () => {
  expect(updateOwnerProfile.inputSchema.safeParse({ name: 'Alicia' }).success).toBe(
    true,
  )
  expect(
    updateOwnerProfile.inputSchema.safeParse({
      name: 'Alicia',
      email: 'changed@example.test',
      profession: 'Changed',
      restricted_notes: true,
    }).success,
  ).toBe(false)

  const result = await updateOwnerProfile.execute({ name: 'Alicia' })
  const [stored] = await db.select().from(owners).where(eq(owners.id, ownerA))
  expect(result).toEqual({ name: 'Alicia', updated_at: expect.any(Date) })
  expect(stored).toEqual(
    expect.objectContaining({
      name: 'Alicia',
      email: 'alice@example.test',
      profession: 'Consultant',
      restricted_notes: false,
    }),
  )
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

const crmTools = [
  createClient,
  findClients,
  updateClient,
  softDeleteClient,
  restoreClient,
  createService,
  findServices,
  updateService,
  softDeleteService,
  restoreService,
  createAppointment,
  findAppointments,
  updateAppointment,
  softDeleteAppointment,
  restoreAppointment,
  createPayment,
  findPayments,
  updatePayment,
  softDeletePayment,
  restorePayment,
  listAuditLog,
  updateOwnerProfile,
]

test('every chat tool explains itself to the Owner in Spanish', () => {
  expect(crmTools.map((tool) => tool.name).sort()).toEqual(
    chatTools.map((tool) => tool.name).sort(),
  )
  for (const tool of crmTools) {
    const sentences = [
      tool.guide.does,
      tool.guide.wont ?? '',
      ...Object.values(tool.guide.asks ?? {}),
    ]
    expect(tool.guide.does, tool.name).toMatch(/^[A-ZÁÉÍÓÚÑ]/)
    expect(sentences.join(' '), tool.name).not.toMatch(/!|¡|_id\b|\bid\b/)
  }
})

test('a write naming a missing id refuses as not found, for every entity', async () => {
  expect(await refusalOf(softDeleteService.execute({ id: 999_999 }))).toEqual(
    expect.objectContaining({ kind: 'not_found', entity: 'service', id: 999_999 }),
  )
  expect(await refusalOf(restorePayment.execute({ id: 999_999 }))).toEqual(
    expect.objectContaining({ kind: 'not_found', entity: 'payment', id: 999_999 }),
  )
  expect(
    await refusalOf(updatePayment.execute({ id: 999_999, amount: 5000 })),
  ).toEqual(expect.objectContaining({ kind: 'not_found', entity: 'payment' }))
})

test("missing service fields become the Owner's questions, in field order", async () => {
  // @ts-expect-error exercising runtime validation
  const refusal = await refusalOf(createService.execute({ name: 'Piano' }))

  expect(refusal).toEqual({
    kind: 'ask',
    say: '¿Cuánto cobras? ¿Cobras por hora o un precio fijo?',
    needs: ['price', 'unit'],
  })
})
