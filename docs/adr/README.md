# Architecture decision records

One page per decision that later work depends on. Each says what the situation was, what was decided and what follows from it.
Recorded in Phase 0 of the 30 September 2026 audit (section 14.3, "Architecture decisions recorded"). A decision is changed by
writing a new record that supersedes it, never by editing an accepted one.

| No. | Decision | Status |
|---|---|---|
| [0001](0001-company-mode-live-demo.md) | Every company is LIVE or DEMO; never LIVE to DEMO; existing companies become DEMO | Accepted |
| [0002](0002-business-clock.md) | A business clock, separate from the engine, that sends, reminds and flags but never moves or completes | Accepted |
| [0003](0003-provenance-before-events.md) | Minimal provenance first; the general events table in Phase 2 | Accepted |
| [0004](0004-one-instance-per-customer.md) | Hosting: one instance per customer behind a TLS proxy | Accepted |
| [0005](0005-commercial-kind-names.md) | New commercial kinds are contract, variation, claim, scaffold, quote; never job | Accepted |
| [0006](0006-demo-and-live-test-suites.md) | The ticking tests stay as the DEMO suite; LIVE gets a suite that never ticks | Accepted |
| [0007](0007-split-operations-by-page.md) | Split operations.js by page as pages are touched; no PostgreSQL, microservices or SSE now | Accepted |
