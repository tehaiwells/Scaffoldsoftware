# 0006. The ticking tests stay as the DEMO suite; LIVE gets a suite that never ticks

- Status: Accepted, 30 September 2026 (Phase 0). The LIVE suite is written with Phase 1A.

## Context

The unit suite drives the real command layer and advances the simulation with `tick()`: about 380 `tick(` calls on 238 lines across
35 files, many inside loops, plus 61 planner `pass()` calls. Every flow completes because simulated crew, forklifts, cranes and trucks
move under the ticks, and the Today tests depend on simulated replies. None of that is true of a LIVE company
([0001](0001-company-mode-live-demo.md)), where people confirm what happened.

## Decision

- The existing ticking tests are kept as the **DEMO suite**: they describe the Practice yard, and they stay green.
- LIVE gets its own suite that **never calls `tick()`** or the engine. It drives commands and confirmations the way people will (book,
  confirm loaded, confirm delivered, count the return) and runs the business clock ([0002](0002-business-clock.md)) directly.
- A guard test runs 10,000 engine rounds and 10,000 clock passes on a LIVE company and expects no new ledger rows, resources or replies.
- Tests check behaviour, not source text (Phase 0 D20): rendered HTML, served files, and the real browser for styles.

## Consequences

- No big rewrite of the current tests before LIVE exists.
- Shared fixtures gain a LIVE variant, and each test says which mode it describes.
- CI runs both suites on Linux and Windows with no retries.
