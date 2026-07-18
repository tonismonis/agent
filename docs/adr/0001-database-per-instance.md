# Database per Instance

Every Instance (one Owner's deploy) gets its own Postgres database. No shared multi-tenant database, no `tenant_id` columns, no RLS — anywhere.

Chosen because the agent generates SQL from chat: in a shared database, one missing `WHERE` clause leaks one Owner's data to another. Per-Instance databases make cross-Owner leaks structurally impossible and keep the schema at its simplest.

**Considered:** shared db + `tenant_id` + Postgres RLS. Rejected for v1 — RLS misconfiguration is exactly the leak class we're avoiding, and at friends-scale the ops cost of N databases (migrations looped over N urls) is trivial. Revisit only if instance count outgrows manual ops.
