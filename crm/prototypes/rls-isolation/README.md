# PROTOTYPE — pooled Postgres RLS isolation

Throwaway artifact for [issue #14](https://github.com/tonismonis/agent/issues/14). Not production code or a test suite.

## Question

Does Postgres RLS reliably isolate Owner data when pooled host-side tool SQL omits explicit `owner_id` filters?

## Run

From `crm/`:

```sh
npm run prototype:rls-isolation
```

This starts the existing Docker Compose Postgres, recreates scratch database `rls_isolation_prototype` plus login role `rls_isolation_app`, and prints expected result, actual result, and verdict for every scenario. It leaves both scratch artifacts for inspection. Remove them with:

```sh
npm run prototype:rls-isolation -- --cleanup
```

Override the Docker admin connection with `PROTOTYPE_ADMIN_URL` if needed. The default is the repository Compose service at `localhost:5433`.

## Verdict

**Yes, for the exercised paths and under the stated boundary.** RLS hid or rejected cross-Owner reads and writes even though normal tool-shaped SQL omitted Owner predicates. `WITH CHECK` rejected forged scope changes, an Owner-scoped composite foreign key rejected a cross-Owner child reference, missing context failed closed, and transaction-local context did not bleed across concurrent or reused pooled connections.

This depends on trusted host code wrapping every operation in a transaction and setting `app.owner_id` transaction-locally before tool SQL. The application role must remain a non-owner without superuser or `BYPASSRLS`. Agent/tool input must not expose `owner_id` or raw SQL/context mutation. PostgreSQL custom settings are not an authentication boundary by themselves: the application role can call `set_config`, so authenticated Owner derivation and query control remain server responsibilities.

Not covered: managed auth, production migrations, every CRM relation/tool, connection-loss behavior, PgBouncer modes, audit/chat persistence, operations, or adversarial SQL execution. The prototype uses fixed local credentials and deliberately leaves production schema untouched.
