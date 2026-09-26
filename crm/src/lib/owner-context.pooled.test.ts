import { inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'

import {
  appointments,
  audit_log,
  clients,
  messages,
  owners,
  payments,
  runs,
  services,
} from '#/db/schema'

const ownerA = '33333333-3333-4333-8333-333333333333'
const ownerB = '44444444-4444-4444-8444-444444444444'
const ownerIds = [ownerA, ownerB]
const pooledUrl =
  process.env.DATABASE_POOLED_URL ??
  'postgresql://crm_app:crm_app@localhost:6433/crm'

// This test file must load the application chokepoint against PgBouncer, not
// the direct DATABASE_URL loaded by the rest of the suite.
process.env.DATABASE_URL = pooledUrl

const { db, withOwnerTxn } = await import('#/db')
const { createOwnerChatPersistence } = await import('./chat-persistence')
const {
  createClient,
  createService,
  findClients,
  findServices,
  listAuditLog,
} = await import('./tools')

const adminDb = drizzle(
  process.env.DATABASE_ADMIN_URL ?? 'postgresql://crm:crm@localhost:5433/crm',
)
const rawPool = new Pool({ connectionString: pooledUrl, max: 4 })

async function clearOwnerData() {
  for (const table of [
    payments,
    appointments,
    audit_log,
    messages,
    runs,
    clients,
    services,
  ]) {
    await adminDb.delete(table).where(inArray(table.owner_id, ownerIds))
  }
}

beforeAll(async () => {
  await adminDb
    .insert(owners)
    .values([
      {
        id: ownerA,
        email: 'pooled-alice@example.test',
        name: 'Pooled Alice',
        profession: 'Consultant',
      },
      {
        id: ownerB,
        email: 'pooled-bob@example.test',
        name: 'Pooled Bob',
        profession: 'Consultant',
      },
    ])
    .onConflictDoNothing()
})

beforeEach(clearOwnerData)

afterAll(async () => {
  await clearOwnerData()
  await adminDb.delete(owners).where(inArray(owners.id, ownerIds))
  await rawPool.end()
})

test('two concurrent Owners remain isolated through transaction pooling', async () => {
  const backendPids = new Set<number>()
  const iterations = 12

  async function runOwner(ownerId: string, label: string) {
    const persistence = createOwnerChatPersistence(ownerId)

    for (let iteration = 0; iteration < iterations; iteration++) {
      const threadId = `shared-thread-${iteration}`
      const runId = `shared-run-${iteration}`
      const message = { role: 'user' as const, content: `${label} private` }

      await withOwnerTxn(ownerId, async (transaction) => {
        const result = await transaction.execute<{ backend_pid: number }>(
          sql`select pg_backend_pid() as backend_pid`,
        )
        backendPids.add(result.rows[0].backend_pid)

        await createClient.execute({ name: `${label} client ${iteration}` })
        await createService.execute({
          name: `${label} service ${iteration}`,
          price: 1000 + iteration,
          unit: 'flat',
        })

        const [ownerClients, ownerServices] = await Promise.all([
          findClients.execute({}),
          findServices.execute({}),
        ])
        expect(ownerClients).toHaveLength(iteration + 1)
        expect(ownerServices).toHaveLength(iteration + 1)
        expect(ownerClients.every((row) => row.owner_id === ownerId)).toBe(true)
        expect(ownerServices.every((row) => row.owner_id === ownerId)).toBe(true)
      })

      await persistence.stores.messages.saveThread(threadId, [message])
      await persistence.stores.runs.createOrResume({
        runId,
        threadId,
        status: 'running',
        startedAt: iteration,
      })

      expect(await persistence.stores.messages.loadThread(threadId)).toEqual([
        message,
      ])
      expect(await persistence.stores.runs.get(runId)).toEqual(
        expect.objectContaining({ runId, threadId, startedAt: iteration }),
      )
    }

    await withOwnerTxn(ownerId, async () => {
      expect(await findClients.execute({})).toHaveLength(iterations)
      expect(await findServices.execute({})).toHaveLength(iterations)
      const auditRows = await listAuditLog.execute({ all: true })
      expect(auditRows).toHaveLength(iterations * 2)
      expect(auditRows.every((row) => row.owner_id === ownerId)).toBe(true)
    })
  }

  await Promise.all([runOwner(ownerA, 'alice'), runOwner(ownerB, 'bob')])

  // PgBouncer has one backend slot: many concurrent client transactions reused
  // the same Postgres session without carrying Owner context across commits.
  expect(backendPids.size).toBe(1)
})

test('transaction-local Owner context outside a transaction grants no access', async () => {
  await withOwnerTxn(ownerA, () => createClient.execute({ name: 'private row' }))

  const setResult = await rawPool.query<{ owner_id: string }>(
    `select set_config('app.owner_id', $1, true) as owner_id`,
    [ownerA],
  )
  expect(setResult.rows[0].owner_id).toBe(ownerA)

  await expect(rawPool.query('select * from clients')).rejects.toMatchObject({
    code: '22P02',
  })
  await expect(
    rawPool.query(`insert into clients (name) values ('hazard write')`),
  ).rejects.toBeDefined()

  expect(
    await adminDb
      .select()
      .from(clients)
      .where(inArray(clients.owner_id, ownerIds)),
  ).toEqual([expect.objectContaining({ owner_id: ownerA, name: 'private row' })])
})

test('pooled Owner data access only works through withOwnerTxn', async () => {
  expect(() => db.select().from(clients)).toThrow(
    'Owner data requires withOwnerTxn',
  )

  await withOwnerTxn(ownerA, () => createClient.execute({ name: 'guarded' }))

  expect(
    await withOwnerTxn(ownerA, () => findClients.execute({ query: 'guarded' })),
  ).toEqual([
    expect.objectContaining({ owner_id: ownerA, name: 'guarded' }),
  ])
  expect(
    await withOwnerTxn(ownerB, () => findClients.execute({ query: 'guarded' })),
  ).toEqual([])
})
