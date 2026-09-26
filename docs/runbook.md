# Runbook

## Database roles

`pnpm db:migrate` connects with `DATABASE_ADMIN_URL`, applies migrations, then sets the `crm_app` password to the one in `DATABASE_URL`. No password lives in a migration. In production, `DATABASE_URL` carries a generated secret for `crm_app`; rotate it by changing the env var and rerunning `pnpm db:migrate`.

## RLS pooled verification

The local pooled endpoint is PgBouncer on `localhost:6433`, configured for transaction pooling with one backend slot to force connection reuse.

```sh
cd crm
docker compose up -d --wait
pnpm db:migrate
pnpm test src/lib/owner-context.pooled.test.ts
```

The test connects as `crm_app`, interleaves two Owners through `withOwnerTxn`, covers CRM and chat-persistence rows, and verifies that transaction-local context attempted outside a transaction grants no access. Override only when needed with `DATABASE_POOLED_URL`.

## Reset demo data

`pnpm demo:reset` (from `crm/`) empties every CRM table (clients, services, appointments, payments, chat messages, runs, audit log) in one transaction and prints how many rows each lost. Owners are kept, so invited accounts can still sign in. It connects with `DATABASE_ADMIN_URL` and refuses to run unless that host is `localhost`, `127.0.0.1` or `::1`. Afterwards, reload any open chat tab: it still holds the old transcript in memory.

## Render PITR restore

Stub: restore the chosen point in time into a new Render Postgres instance, verify it, replace the Web Service `DATABASE_URL` with the new instance URL, and redeploy. Keep the old instance until application read/write smoke checks pass.
