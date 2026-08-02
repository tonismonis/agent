// PROTOTYPE — throw away after issue #14 is decided.
// Question: does Postgres RLS isolate Owner data when pooled host-side tool SQL omits owner filters?
// Verdict: yes, if every operation is transaction-wrapped, trusted code SET LOCALs Owner context,
// and the application role neither owns tables nor has BYPASSRLS.

import pg from 'pg'

const { Client, Pool } = pg
const database = 'rls_isolation_prototype'
const role = 'rls_isolation_app'
const password = 'prototype-only'
const adminUrl =
  process.env.PROTOTYPE_ADMIN_URL ??
  'postgresql://crm:crm@localhost:5433/postgres'
const appUrl = `postgresql://${role}:${password}@localhost:5433/${database}`
const alice = '11111111-1111-4111-8111-111111111111'
const bob = '22222222-2222-4222-8222-222222222222'

const admin = new Client({ connectionString: adminUrl })
await admin.connect()

async function clean() {
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [database],
  )
  await admin.query(`DROP DATABASE IF EXISTS ${database}`)
  await admin.query(`DROP ROLE IF EXISTS ${role}`)
}

if (process.argv.includes('--cleanup')) {
  await clean()
  await admin.end()
  console.log(`Removed scratch database ${database} and role ${role}.`)
  process.exit(0)
}

await clean()
await admin.query(
  `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
)
await admin.query(`CREATE DATABASE ${database}`)
await admin.end()

const setup = new Client({
  connectionString: adminUrl.replace(/\/postgres$/, `/${database}`),
})
await setup.connect()
await setup.query(`
  CREATE SCHEMA app;

  CREATE FUNCTION app.current_owner_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.owner_id', true), '')::uuid $$;

  CREATE TABLE owners (
    id uuid PRIMARY KEY,
    name text NOT NULL
  );

  CREATE TABLE clients (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id uuid NOT NULL DEFAULT app.current_owner_id() REFERENCES owners(id),
    name text NOT NULL,
    UNIQUE (owner_id, id)
  );

  CREATE TABLE appointments (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id uuid NOT NULL DEFAULT app.current_owner_id() REFERENCES owners(id),
    client_id bigint NOT NULL,
    starts_at timestamptz NOT NULL,
    FOREIGN KEY (owner_id, client_id) REFERENCES clients(owner_id, id)
  );

  INSERT INTO owners (id, name) VALUES
    ('${alice}', 'Alice Owner'),
    ('${bob}', 'Bob Owner');

  ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
  ALTER TABLE clients FORCE ROW LEVEL SECURITY;
  CREATE POLICY owner_isolation ON clients
    USING (owner_id = app.current_owner_id())
    WITH CHECK (owner_id = app.current_owner_id());

  ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
  ALTER TABLE appointments FORCE ROW LEVEL SECURITY;
  CREATE POLICY owner_isolation ON appointments
    USING (owner_id = app.current_owner_id())
    WITH CHECK (owner_id = app.current_owner_id());

  GRANT CONNECT ON DATABASE ${database} TO ${role};
  GRANT USAGE ON SCHEMA public, app TO ${role};
  GRANT EXECUTE ON FUNCTION app.current_owner_id() TO ${role};
  GRANT SELECT, INSERT, UPDATE, DELETE ON clients, appointments TO ${role};
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role};
`)
await setup.end()

const pool = new Pool({ connectionString: appUrl, max: 2 })
const scenarios = []

function record(scenario, expected, actual, pass) {
  const row = { scenario, expected, actual, verdict: pass ? 'PASS' : 'FAIL' }
  scenarios.push(row)
  console.log(`\n[${row.verdict}] ${scenario}\n  expected: ${expected}\n  actual:   ${actual}`)
}

async function withOwner(targetPool, ownerId, operation) {
  const client = await targetPool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.owner_id', $1, true)`, [ownerId])
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function denied(operation) {
  try {
    await operation()
    return { denied: false, code: 'none' }
  } catch (error) {
    return { denied: true, code: error.code ?? error.message }
  }
}

// Tool-shaped host functions: input has no owner_id; SQL has no owner predicate.
async function createClient(ownerId, input) {
  return withOwner(pool, ownerId, async (client) => {
    const result = await client.query(
      'INSERT INTO clients (name) VALUES ($1) RETURNING id, owner_id, name',
      [input.name],
    )
    return result.rows[0]
  })
}

async function readClients(ownerId) {
  return withOwner(pool, ownerId, async (client) => {
    const result = await client.query('SELECT id, owner_id, name FROM clients ORDER BY id')
    return result.rows
  })
}

const posture = await pool.query(`
  SELECT NOT r.rolsuper AND NOT r.rolbypassrls AND c.relowner <> r.oid AS safe
  FROM pg_roles r CROSS JOIN pg_class c
  WHERE r.rolname = current_user AND c.relname = 'clients'
`)
record(
  'application role posture',
  'non-superuser, non-BYPASSRLS, non-table-owner',
  `safe=${posture.rows[0].safe}`,
  posture.rows[0].safe === true,
)

const aliceClient = await createClient(alice, { name: 'Alice Client' })
const bobClient = await createClient(bob, { name: 'Bob Client' })
record(
  'normal inserts derive Owner from trusted transaction context',
  'tool input omits owner_id; each row gets transaction Owner',
  `${aliceClient.name}=>${aliceClient.owner_id}; ${bobClient.name}=>${bobClient.owner_id}`,
  aliceClient.owner_id === alice && bobClient.owner_id === bob,
)

const aliceRows = await readClients(alice)
record(
  'tool-shaped read omits owner_id predicate',
  'Alice sees only Alice Client',
  aliceRows.map((row) => row.name).join(', ') || '(none)',
  aliceRows.length === 1 && aliceRows[0].owner_id === alice,
)

const updateOther = await withOwner(pool, alice, (client) =>
  client.query('UPDATE clients SET name = $1 WHERE id = $2 RETURNING id', [
    'stolen',
    bobClient.id,
  ]),
)
const bobRows = await readClients(bob)
record(
  'tool-shaped update omits owner_id predicate',
  'Alice changes 0 Bob rows; Bob row remains unchanged',
  `changed=${updateOther.rowCount}; Bob=${bobRows[0].name}`,
  updateOther.rowCount === 0 && bobRows[0].name === 'Bob Client',
)

const forgedInsert = await denied(() =>
  withOwner(pool, alice, (client) =>
    client.query('INSERT INTO clients (owner_id, name) VALUES ($1, $2)', [
      bob,
      'forged',
    ]),
  ),
)
record(
  'forged cross-Owner insert',
  'RLS WITH CHECK denies it',
  `denied=${forgedInsert.denied}; SQLSTATE=${forgedInsert.code}`,
  forgedInsert.denied && forgedInsert.code === '42501',
)

const forgedUpdate = await denied(() =>
  withOwner(pool, alice, (client) =>
    client.query('UPDATE clients SET owner_id = $1 WHERE id = $2', [
      bob,
      aliceClient.id,
    ]),
  ),
)
record(
  'forged cross-Owner update',
  'RLS WITH CHECK denies moving Alice row to Bob',
  `denied=${forgedUpdate.denied}; SQLSTATE=${forgedUpdate.code}`,
  forgedUpdate.denied && forgedUpdate.code === '42501',
)

const crossOwnerFk = await denied(() =>
  withOwner(pool, alice, (client) =>
    client.query(
      `INSERT INTO appointments (client_id, starts_at) VALUES ($1, now())`,
      [bobClient.id],
    ),
  ),
)
record(
  'cross-Owner composite foreign key',
  'Alice cannot attach an appointment to Bob Client',
  `denied=${crossOwnerFk.denied}; SQLSTATE=${crossOwnerFk.code}`,
  crossOwnerFk.denied && crossOwnerFk.code === '23503',
)

const child = await withOwner(pool, alice, async (client) => {
  const result = await client.query(
    `INSERT INTO appointments (client_id, starts_at) VALUES ($1, now()) RETURNING owner_id`,
    [aliceClient.id],
  )
  return result.rows[0]
})
record(
  'normal child insert uses scoped composite FK',
  'owner_id defaults to Alice and Alice Client reference succeeds',
  `owner_id=${child.owner_id}`,
  child.owner_id === alice,
)

const missingRead = await pool.query('SELECT name FROM clients')
const missingWrite = await denied(() =>
  pool.query(`INSERT INTO clients (name) VALUES ('contextless')`),
)
record(
  'missing Owner context fails closed',
  'read sees 0; write denied',
  `read=${missingRead.rowCount}; writeDenied=${missingWrite.denied}; SQLSTATE=${missingWrite.code}`,
  missingRead.rowCount === 0 && missingWrite.denied,
)

const concurrent = await Promise.all(
  [
    [alice, 'Alice Client'],
    [bob, 'Bob Client'],
  ].map(([ownerId, expectedName]) =>
    withOwner(pool, ownerId, async (client) => {
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await client.query('SELECT pg_sleep(0.15)')
      const rows = (await client.query('SELECT name FROM clients')).rows
      return { pid, expectedName, names: rows.map((row) => row.name) }
    }),
  ),
)
record(
  'concurrent pooled Owner transactions',
  'two backends overlap; each sees only its Owner row',
  concurrent.map((x) => `pid=${x.pid}:${x.names.join(',')}`).join(' | '),
  new Set(concurrent.map((x) => x.pid)).size === 2 &&
    concurrent.every(
      (x) => x.names.length === 1 && x.names[0] === x.expectedName,
    ),
)

const reusePool = new Pool({ connectionString: appUrl, max: 1 })
const first = await withOwner(reusePool, alice, async (client) => ({
  pid: (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
  names: (await client.query('SELECT name FROM clients')).rows.map((x) => x.name),
}))
const contextless = await reusePool.query(
  `SELECT pg_backend_pid() AS pid, count(*)::int AS count FROM clients GROUP BY pg_backend_pid()`,
)
const second = await withOwner(reusePool, bob, async (client) => ({
  pid: (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
  names: (await client.query('SELECT name FROM clients')).rows.map((x) => x.name),
}))
const missingCount = contextless.rows[0]?.count ?? 0
const missingPid = contextless.rows[0]?.pid ?? first.pid
record(
  'transaction-local context clears on pool reuse',
  'same backend: Alice, then no-context=0, then Bob only',
  `pids=${first.pid}/${missingPid}/${second.pid}; no-context=${missingCount}; final=${second.names.join(',')}`,
  first.pid === missingPid &&
    missingPid === second.pid &&
    first.names[0] === 'Alice Client' &&
    missingCount === 0 &&
    second.names.length === 1 &&
    second.names[0] === 'Bob Client',
)
await reusePool.end()
await pool.end()

console.log('\nSCENARIO MATRIX')
console.table(scenarios)
const passed = scenarios.every((scenario) => scenario.verdict === 'PASS')
console.log(
  `\nVERDICT: ${passed ? 'YES' : 'NO'} — RLS ${
    passed ? 'isolated every exercised Owner path.' : 'did not prove isolation.'
  }`,
)
console.log(`Scratch artifacts remain: database=${database}, role=${role}.`)
console.log('Cleanup: npm run prototype:rls-isolation -- --cleanup')
if (!passed) process.exitCode = 1
