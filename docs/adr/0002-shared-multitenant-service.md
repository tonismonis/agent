# Shared multitenant service

One managed Node deployment and one managed Postgres database serve all Owners. Every Owner-owned relation carries `owner_id`; trusted authenticated context, transaction-local Postgres RLS, a non-bypass application role, and Owner-scoped foreign keys enforce isolation independently of agent-generated tool calls.

This supersedes database-per-Instance because shared compute and storage operations fit the intended scale better. Device-local storage was rejected because data must survive computer loss without a v1 sync system; schema/database-per-Owner was rejected because RLS can preserve isolation without multiplying infrastructure. [Prototype: pooled Postgres RLS isolation for Owner data](https://github.com/tonismonis/agent/issues/14) validated the isolation design under its trusted-host constraints.
