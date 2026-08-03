# Runbook

## RLS pooled verification

The local pooled endpoint is PgBouncer on `localhost:6433`, configured for transaction pooling with one backend slot to force connection reuse.

```sh
cd crm
docker compose up -d --wait
npm run db:migrate
npm test -- src/lib/owner-context.pooled.test.ts
```

The test connects as `crm_app`, interleaves two Owners through `withOwnerTxn`, covers CRM and chat-persistence rows, and verifies that transaction-local context attempted outside a transaction grants no access. Override only when needed with `DATABASE_POOLED_URL`.

## Render PITR restore

Stub: restore the chosen point in time into a new Render Postgres instance, verify it, replace the Web Service `DATABASE_URL` with the new instance URL, and redeploy. Keep the old instance until application read/write smoke checks pass.
