# 0001. Every company is LIVE or DEMO

- Status: Accepted, 30 September 2026 (Phase 0). Built in Phase 1A (#1).

## Context

There is no live mode. The movement engine ticks every set-up, unpaused company every 250 ms and acts as one of its owners: it walks
crew, drives trucks, answers messages with simulated replies, creates cranes and people, and marks work done. A per-company Pause and
a few switches exist, but they do not add up to "nothing here is invented". A late planner pass even wrote DONE "Day done." for a crew
booking nobody went to (the clock probe; `plan.js`). Selling software that invents records under real people's names is a
misleading-conduct risk, and the owner cannot run his real yard in it.

## Decision

- A column `companies.mode` with two values, `LIVE` and `DEMO`, set when the company is created.
- A company can **never** change from LIVE to DEMO. There is no conversion from DEMO to LIVE either: a LIVE company is created new.
- Every company that exists when the column is added is migrated as **DEMO** (its data was made by the simulation).
- In LIVE the engine never selects the company, and nothing is auto-created or auto-completed. The guards live in
  `Simulation.execute` and in the job effects, not in a toggle that a setting could flip.
- DEMO keeps everything it does today, with a permanent chip on its screens and print (the "Practice yard · simulated" chip is the
  Phase 0 start) and "(demo reply)" on simulated replies.

## Consequences

- The owner's real yard starts as a new LIVE company; the current one stays as his Practice yard.
- Time-based duties (3 pm asks, message delivery, missed detection) stop with the engine for LIVE companies, so they need the business
  clock of [0002](0002-business-clock.md) in the same release.
- Every code path that writes must respect the mode. A CI test runs 10,000 engine rounds on a LIVE company and expects no new ledger
  rows, resources or replies.
- The existing ticking tests describe DEMO only ([0006](0006-demo-and-live-test-suites.md)).
