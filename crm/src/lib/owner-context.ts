import { AsyncLocalStorage } from 'node:async_hooks'

import { auth, clerkClient } from '@clerk/tanstack-react-start/server'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'

import * as schema from '#/db/schema'
import { owners } from '#/db/schema'

function createRootDb() {
  return drizzle(process.env.DATABASE_URL!, { schema })
}

type RootDb = ReturnType<typeof createRootDb>
type OwnerTransaction = Parameters<Parameters<RootDb['transaction']>[0]>[0]
let rootDb: RootDb | undefined
const ownerTransactions = new AsyncLocalStorage<OwnerTransaction>()

function getRootDb() {
  rootDb ??= createRootDb()
  return rootDb
}

export type VerifiedClerkSession = {
  externalId: string
  primaryEmail: string
}

export const db = new Proxy(
  // SAFETY: the target object is never read; every property access delegates to the active owner transaction.
  {} as RootDb,
  {
    get(_target, property) {
      const transaction = ownerTransactions.getStore()
      if (!transaction) throw new Error('Owner data requires withOwnerTxn')
      const value = Reflect.get(transaction, property, transaction)
      return typeof value === 'function' ? value.bind(transaction) : value
    },
  },
)

export function withOwnerTxn<TResult>(
  ownerId: string,
  operation: (transaction: OwnerTransaction) => Promise<TResult>,
) {
  return getRootDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`select set_config('app.owner_id', ${ownerId}, true)`,
    )
    return ownerTransactions.run(transaction, () => operation(transaction))
  })
}

async function findOwnerByExternalId(externalId: string) {
  const [owner] = await getRootDb()
    .select()
    .from(owners)
    .where(eq(owners.external_id, externalId))
    .limit(1)
  return owner
}

export async function resolveOwnerContext(session: VerifiedClerkSession) {
  const existingOwner = await findOwnerByExternalId(session.externalId)
  if (existingOwner) return existingOwner

  const [stampedOwner] = await getRootDb()
    .update(owners)
    .set({ external_id: session.externalId, updated_at: sql`now()` })
    .where(
      and(
        eq(owners.email, session.primaryEmail),
        isNull(owners.external_id),
      ),
    )
    .returning()
  if (stampedOwner) return stampedOwner

  const concurrentlyStampedOwner = await findOwnerByExternalId(
    session.externalId,
  )
  if (concurrentlyStampedOwner) return concurrentlyStampedOwner

  throw new Response('Forbidden', { status: 403 })
}

export async function requireVerifiedOwner() {
  const session = await auth()
  if (!session.isAuthenticated || !session.userId) {
    throw new Response('Unauthorized', { status: 401 })
  }

  const existingOwner = await findOwnerByExternalId(session.userId)
  if (existingOwner) return existingOwner

  const user = await clerkClient().users.getUser(session.userId)
  const primaryEmail = user.emailAddresses.find(
    ({ id }) => id === user.primaryEmailAddressId,
  )?.emailAddress
  if (!primaryEmail) throw new Response('Forbidden', { status: 403 })

  return resolveOwnerContext({ externalId: session.userId, primaryEmail })
}
