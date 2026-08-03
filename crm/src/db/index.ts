import { AsyncLocalStorage } from 'node:async_hooks'

import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'

import * as schema from './schema.ts'

const rootDb = drizzle(process.env.DATABASE_URL!, { schema })
const ownerTransactions = new AsyncLocalStorage<typeof rootDb>()

export const db = new Proxy(rootDb, {
  get(_target, property) {
    const target = ownerTransactions.getStore() ?? rootDb
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  },
})

export function withOwnerTransaction<TResult>(
  ownerId: string,
  operation: () => Promise<TResult>,
) {
  return rootDb.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.owner_id', ${ownerId}, true)`)
    return ownerTransactions.run(tx as unknown as typeof rootDb, operation)
  })
}
