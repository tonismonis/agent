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

## Seed demo data

`pnpm demo:seed` (from `crm/`) seeds the Owner named by `DEMO_OWNER_EMAIL`, or by an email passed as its argument. It puts that Owner into the state of a clinical psychologist in Santiago who has used the CRM for about five months: a service catalog, around 25 clients, weekly series and one-off appointments, payments with a few clients behind, and an audit log row for each write the Owner would have made. In one transaction it deletes that Owner's clients, services, appointments, series, payments, chat messages, runs and audit log, inserts the new data and sets their profession to `Psicología clínica`. Other owners are untouched, and running it again gives the same result. The Owner must already exist, since owners are invite-only. Every date is relative to today in America/Santiago: history starts about 22 weeks back and series run to mid-December, so seed again on the day of a demo. Same localhost-only guard as `demo:reset`. Afterwards, reload any open chat tab.

## Render PITR restore

Stub: restore the chosen point in time into a new Render Postgres instance, verify it, replace the Web Service `DATABASE_URL` with the new instance URL, and redeploy. Keep the old instance until application read/write smoke checks pass.
