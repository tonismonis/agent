/**
 * Wipes every CRM table except owners before a demo. Sign-in is invite-only,
 * so an owners row is the only thing that cannot be recreated by using the app.
 */
import { config } from 'dotenv'
import pg from 'pg'

config({ path: ['.env.local', '.env'], quiet: true })

function requiredEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const DATA_TABLES = [
  'audit_log',
  'messages',
  'runs',
  'services',
  'clients',
  'appointments',
  'payments',
  'working_hours',
] as const

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

const adminUrl = requiredEnv('DATABASE_ADMIN_URL')
const host = new URL(adminUrl).hostname
if (!LOCAL_HOSTS.has(host)) {
  console.error(`refusing to reset: DATABASE_ADMIN_URL host is ${host}, not local`)
  process.exit(1)
}

async function count(client: pg.Client, table: string) {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${client.escapeIdentifier(table)}`,
  )
  return rows[0].n
}

// The app role cannot delete audit_log rows, so this runs as the admin role.
const admin = new pg.Client({ connectionString: adminUrl })
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
