/**
 * Sets the runtime role's password from DATABASE_URL. Migrations are committed
 * and run unchanged in production, so no password may live in one.
 */
import { config } from 'dotenv'
import pg from 'pg'

config({ path: ['.env.local', '.env'], quiet: true })

function requiredEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const appUrl = new URL(requiredEnv('DATABASE_URL'))
const role = decodeURIComponent(appUrl.username)
const password = decodeURIComponent(appUrl.password)
if (!password) throw new Error('DATABASE_URL has no password')

const admin = new pg.Client({
  connectionString: requiredEnv('DATABASE_ADMIN_URL'),
})
await admin.connect()
try {
  // ALTER ROLE takes no bind parameters, so both values are escaped instead.
  await admin.query(
    `ALTER ROLE ${admin.escapeIdentifier(role)} PASSWORD ${admin.escapeLiteral(password)}`,
  )
} finally {
  await admin.end()
}
