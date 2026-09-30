# 0003. Minimal provenance first; the general events table in Phase 2

- Status: Accepted, 30 September 2026 (Phase 0). Step 1 in Phase 1A, step 2 in Phase 2.

## Context

The product already rests on an append-only ledger with incremental projections: Reports, Hire and the low-stock alerts replay it from
a sequence watermark. What the ledger lacks is truthfulness and structure. The command input is kept only as a hash, engine moves carry
an owner's id, there is no occurred-at separate from recorded-at, truck dispatch and arrival never reach it, sign-ins are not recorded,
and alerts are never stored. Full event sourcing, a message bus or microservices would be far more than a one-yard business needs.

## Decision

One structured operational log, grown from the existing ledger, in two steps.

- **Step 1 (with LIVE mode):** ledger columns `occurred_at`, `actor_kind` (PERSON, OFFICE_ON_BEHALF, IMPORT, ENGINE), `on_behalf_of`
  and `origin`, with existing rows backfilled as ENGINE in DEMO companies; an append-only `trip_confirmation` per trip step; an
  append-only `security_events` table; engine writes in DEMO use `system:engine`; a redacted copy of each command's input next to its
  COMMAND row; hire reads `occurred_at`.
- **Step 2 (Phase 2):** an `events` table (type and version, occurred and recorded times, actor type, channel, provenance RECORDED /
  CONFIRMED / ESTIMATED / SIMULATED, subject, correlation = the command's idempotency key, `supersedes` for corrections, JSON payload),
  written in the same transaction as the state change through one `emit()`, with about 35 business event types. Ticks and forklift
  steps are not events.

## Consequences

- No event bus, no full event sourcing, no second database.
- A test that every state-changing command emits at least one event, and projection-versus-state checks.
- Personal details stay in mutable records referenced by id, so retention and deletion stay possible.
