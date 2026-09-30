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
| [0008](0008-live-foundation.md) | The LIVE foundation as built: the allow-list wall, the business clock on company time, ledger provenance, "Start your real yard" | Accepted |
| [0009](0009-record-reality.md) | Record what really happened: orders with exact pieces, trips confirmed by people (the driver's phone or the office for them), stock moving only on a confirmation | Accepted |
| [0010](0010-dispatch-and-returns.md) | Today as LIVE dispatch (bookings wait for people; drafts; move a day; the lanes view), returns counted and resolved with charge lines and one "available", "Needs you" v1 | Accepted |
| [0011](0011-billing-and-go-live.md) | Billing you can send: customers, off-hire with a company hire-stop rule, issued locked statements, adjustments, the Xero/MYOB monthly file, Accounts role; opening lots and the go-live import; retention in a real yard | Accepted |
| [0012](0012-daily-activities-gear-roster-tasks.md) | Daily activities and the drawer in the owner's order; gear lists; the workers' roster (a fortnight ahead, asked the day before); tasks with a priority a day, Task progress and the Pre-start sheet | Accepted |
