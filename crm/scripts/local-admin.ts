/**
 * The admin connection for scripts that rewrite demo data. They bypass row
 * security and delete audit rows, so they only ever touch this machine's
 * database.
 */
import { config } from 'dotenv'
import pg from 'pg'

config({ path: ['.env.local', '.env'], quiet: true })

function requiredEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Exits unless DATABASE_ADMIN_URL is local; `action` names what was refused. */
export function localAdminClient(action: string) {
  const adminUrl = requiredEnv('DATABASE_ADMIN_URL')
  const host = new URL(adminUrl).hostname
  if (!LOCAL_HOSTS.has(host)) {
    console.error(`refusing to ${action}: DATABASE_ADMIN_URL host is ${host}, not local`)
    process.exit(1)
  }
  return new pg.Client({ connectionString: adminUrl })
}
