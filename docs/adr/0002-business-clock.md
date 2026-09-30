# 0002. A business clock separate from the engine

- Status: Accepted, 30 September 2026 (Phase 0). Built with [0001](0001-company-mode-live-demo.md) in Phase 1A (#32).

## Context

Every time rule (asking people at 3 pm, delivering messages, the packing day, missed detection, and later reminders, inspection dates
and billing cut-offs) runs inside the movement engine: `planTick` has one caller, reached only through the scheduler loop, and
`planNow()` is the office PC's clock. Stopping the engine for LIVE companies would stop all of them. A probe showed that with no
engine pass nothing was sent or flagged, and one late pass then marked a booking DONE although nobody went.

## Decision

A `clockPass(now)` per company on its own timer (every 30-60 s), independent of the engine and of the engine lease, with three rules:

1. **It never changes where anything is.** It delivers messages whose send time has passed, sends one reminder, raises and clears
   flags (not asked, no answer, not packed, not left, unconfirmed trip, inspection due, unbilled, document expiry) and rolls days over.
2. **It never records success.** A late pass marks items "not confirmed" or "missed", never DONE.
3. **It runs on company time** (time zone and state public holidays). After downtime it catches up in order and does not send an ask
   that is now too late; it raises "not asked in time" instead.

In DEMO the engine calls the same clock, then runs the simulation's own steps.

## Consequences

- `planDeliverDue`, the 3 pm ask rule and the day-over checks move to `clock.js`; packing, sending, moving workers and simulated replies
  stay in the simulation.
- Tests: 10,000 clock passes change no stock, location or ledger row; the clock probe rerun on LIVE sends every due ask within 60 s and
  leaves 0 items DONE without a confirmation; an 8-hour catch-up; a Perth time-zone test.
- Phase 0 already stops a late pass from writing "Day done." (D8); this record is the full fix.
