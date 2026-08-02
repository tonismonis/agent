# TanStack AI persistence layer (ticket #8)

Researched 2026-08-01. Source: TanStack/ai repo `docs/persistence/`, `docs/memory/`, `docs/resumable-streams/`. Full persistence section landed after our #2 research (was a stub then).

## What ships

- `@tanstack/ai-persistence`: server chat middleware `withPersistence(stores)` + client `persistence: true` on `useChat`.
- Server-authoritative mode: client sends **empty `messages`** → server loads stored transcript, runs from there. Non-empty `messages` = full-history overwrite (client-authoritative). One rule, no merge logic.
- Client `persistence: true`: browser stores nothing; on mount `useChat` GETs `reconstructChat(persistence, request)` → `{ messages, activeRun }`, paints transcript. Reload/multi-device restore free.
- Stores are BYO-backend, implement over own db: `messages` (required), `runs` (status/timings/**per-run token usage**, `findActiveRun`), `interrupts` (durable approval waits, needs `runs`), `metadata`. SQLite walkthrough + conformance testkit ship.
- Write moments: run start (best-effort pending turn), interrupt boundary, finish (authoritative, transcript saved before run marked completed), optional throttled `snapshotStreaming`.
- Keyed on `threadId` (stable conversation) vs `runId` (one execution). `reconstructChat({ authorize })` for ownership checks — single-tenant, trivial for us.

## What does NOT ship

- **No retention/compaction/windowing.** Zero TTL/prune/summarize/trim anywhere in docs. Server-authoritative mode loads the FULL stored transcript into every run — context growth unbounded unless you cap it yourself.
- Related-but-separate layers, all skippable for us:
  - `@tanstack/ai-memory`: cross-session recall middleware (mem0/redis/etc adapters). Our db already is the memory.
  - Resumable streams: delivery durability (mid-answer reconnect via per-run byte log). Separate from state persistence.

## Decision (#8 resolution)

Flip prior "no persistence" lean → minimal server persistence:

- `withPersistence` + drizzle/pg adapter in same Postgres; stores `messages` + `runs` only. Skip `interrupts` (no approval gates per #5), resumable-streams, ai-memory.
- Client `persistence: true`; `snapshotStreaming` off.
- **Inference cap = daily thread rotation**: `threadId = day-YYYY-MM-DD` owner tz, auto. No compaction v1. Cross-day continuity = agent queries db/audit log, not transcript.
- Retention: keep old threads forever, no pruning.
- Bonus: `runs` usage column → per-instance spend queryable (owner's cost-financing gripe).
