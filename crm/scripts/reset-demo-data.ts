/**
 * Wipes every CRM table except owners before a demo. Sign-in is invite-only,
 * so an owners row is the only thing that cannot be recreated by using the app.
 */
import type pg from 'pg'

import { localAdminClient } from './local-admin.ts'

const DATA_TABLES = [
  'audit_log',
  'messages',
  'runs',
  'services',
  'clients',
  'appointments',
  'appointment_series',
  'appointment_series_days',
  'payments',
] as const

// The app role cannot delete audit_log rows, so this runs as the admin role.
const admin = localAdminClient('reset')

async function count(client: pg.Client, table: string) {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${client.escapeIdentifier(table)}`,
  )
  return rows[0].n
}

await admin.connect()
try {
  await admin.query('BEGIN')
  const removed: Array<[string, number]> = []
  for (const table of DATA_TABLES) removed.push([table, await count(admin, table)])
  await admin.query(
    `TRUNCATE ${DATA_TABLES.map((t) => admin.escapeIdentifier(t)).join(', ')} RESTART IDENTITY`,
  )
  const owners = await count(admin, 'owners')
  await admin.query('COMMIT')

  for (const [table, n] of removed) console.log(`${table}: removed ${n}`)
  console.log(`owners: kept ${owners}`)
  console.log('Reload any open chat tab; it still holds the old transcript in memory.')
} catch (error) {
  await admin.query('ROLLBACK')
  throw error
} finally {
  await admin.end()
}
