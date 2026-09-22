# Validation evidence — 22 September 2026

## Executed successfully

- `npm.cmd test`: **35 tests passed, 0 failed** in the final run. Includes backend/domain, HTTP integration, frontend rendering helpers and file-based restart recovery.
- `npm.cmd run check`: syntax checks passed for **25 JavaScript files**.
- `npm.cmd run test:e2e -- --list`: discovered the one full browser workflow test. Discovery is not a completed standalone test execution.
- Synthetic seed script executed against an isolated validation SQLite file. It created two 100-piece packs and a physical empty container, yard resources, truck, site and crane.
- Consistent backup script executed. Original and reopened backup each returned `PRAGMA integrity_check = ok` and **200 pieces**. No production data was restored or overwritten.

## Browser evidence

The actual local UI was exercised through the Codex Browser tool, without direct API shortcuts for setup/stock:

Company creation → system selection → measured 20 × 16 m yard → five workers/forklift → synthetic catalogue → empty stillage → 100-piece opening receipt → truck/site/crane setup → request → forklift loading → dispatch → arrival → crane unloading → site stock → return loading → return trip → yard unloading → stocktake.

Observed weight: **550 kg** for 100 synthetic 5 kg components plus one 50 kg stillage. Observed stock: **100 at the site after placement**, then **100 back at the yard after return**. A scoped demonstration count recorded 100 expected / 95 observed, preserved a reason and approval, and displayed **95 physical pieces** after the audited correction. Reload after server restart preserved the company and delivered stock.

Reusable functions in e2e/workflow.js were also run through the supported browser driver. Automated truck/site/resource setup and crane-unload/site-stock/request-completion assertions passed in separate stages. The clean whole-scenario rerun did **not** finish: browser-driver waits timed out, and a later tool execution reset its session. A navigation-reset bug between signed-in companies was found and fixed. Do not describe the complete automated browser suite as green. The standalone Playwright runner was configured and discovered but its full Chromium execution was not performed here.

Desktop appearance was visually inspected in the in-app browser. Tablet/touch dragging, cross-browser compatibility, a full keyboard-accessibility audit and 30 FPS were not measured or certified.

## Critical rule coverage

| Rule | Evidence in automated tests |
|---|---|
| Conservation, custody, yard/truck/site/return | Simulation round-trip, partial unload and pickup tests |
| Reservation availability and competing requests | Reservation and simultaneous HTTP queue tests |
| Idempotency, restart, rollback | Replayed command, disk restart during carrying, placement failure |
| Exact partial pick and cancellation | 120-unit request, real empty pack, request/task cancellation |
| Tare/payload/deck/stack | 550 kg exact-capacity case, overbook rejection, overlap/envelope/support and 7/2-level checks |
| Geometry/path/resources | True diagonal, concave containment, self-intersection, boxed-in load, busy/missing equipment |
| Unknown values/provenance/system disable | Unknown mass/pack rejection, conflict rollback, retained stock |
| Roles, tenant isolation, site scope | Membership switching, guessed IDs, direct APIs, scoped CSV/history |
| Stocktake and ledger protection | Scope locks, incoming movement rejection, reason/permission and signed variance |
| Archive and injection | Occupied-site refusal, retained audit, forged placement fields ignored |

The suite is not an exhaustive proof. In particular, the broad independent acceptance/device matrix and remaining features in KNOWN_LIMITATIONS.md are still open.

## Measured backend reference scenario

`npm.cmd run benchmark` generated 500 synthetic containers, 10,000 ledger records and five workers in an in-memory SQLite database. Twenty samples per operation; reported p95 is the highest sampled value in this small run.

Machine: Windows 10.0.26200, Intel Core i7-13620H, Node v24.19.0.

| Operation | Median | Sample p95 |
|---|---:|---:|
| Company snapshot, first 100-container page | 5.40 ms | 7.18 ms |
| Indexed history page, 100 records | 0.16 ms | 0.31 ms |

Snapshot JSON size: **48,920 bytes**. This measures backend processing, not network, disk endurance, browser render time or FPS. PostgreSQL, million-record operational loads and public deployment were not tested.

## Source handling

No manufacturer PDF was present in the project or used. The excluded internal AT-PAC document was not read. Seed facts are explicitly synthetic, stored separately in catalogues/synthetic.json. All real manufacturer and operating values remain subject to review. No paid messages, public deployment or external document uploads occurred.


## Visual refresh
Shared design layer in public/design.css; code-native SVG artwork in public/art.js; improved truck deck drawing in public/visual.js. Browser reviewed Home, Yard, Stock, Trucks and Settings, checked Sites and Requests navigation, and checked Home at 390px width. Fixed the narrow-screen header and hero spacing. Browser error log empty during final review. Syntax checks: 26 JavaScript files; regression suite: 38 passed. Storage records and movement rules preserved.


## Mounted forklift driving and handling
Added mounted right-click driving and explicit pickup / place controls. Browser walkthrough mounted Worker 1, collected S-001, drove with cargo, and placed it at a new ground position; no browser errors. Regression checks cover exact stock conservation, unique pickup and placement events, overload, out-of-bounds routes, competing claims, blocked placement retaining cargo, pause, and restored persisted state.
