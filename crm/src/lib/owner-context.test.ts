import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterEach, expect, test } from 'vitest'

import { db } from '#/db'
import { clients, owners } from '#/db/schema'
import { resolveOwnerContext } from './owner-context.server'

const adminDb = drizzle(
  process.env.DATABASE_ADMIN_URL ?? 'postgresql://crm:crm@localhost:5433/crm',
)
const invitedEmail = 'invited-owner@example.test'
const externalId = 'user_clerk_invited'

afterEach(async () => {
  await adminDb.delete(owners).where(eq(owners.email, invitedEmail))
})

test('first verified session stamps invited Owner by primary email', async () => {
  const [invitedOwner] = await adminDb
    .insert(owners)
    .values({
      email: invitedEmail,
      name: 'Invited Owner',
      profession: 'Consultant',
    })
    .returning()

  const owner = await resolveOwnerContext({ externalId, primaryEmail: invitedEmail })

  expect(owner.id).toBe(invitedOwner.id)
  expect(owner.external_id).toBe(externalId)
  expect(
    await adminDb.select().from(owners).where(eq(owners.id, invitedOwner.id)),
  ).toEqual([expect.objectContaining({ external_id: externalId })])
})

test('verified session without an invitation is forbidden', async () => {
  await expect(
    resolveOwnerContext({
      externalId: 'user_clerk_unknown',
      primaryEmail: 'unknown-owner@example.test',
    }),
  ).rejects.toMatchObject({ status: 403 })
})

test('Owner data access outside withOwnerTxn is refused', () => {
  expect(() => db.select().from(clients)).toThrow(
    'Owner data requires withOwnerTxn',
  )
})
