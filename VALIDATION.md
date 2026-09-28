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

## Database location, automatic backups and CI — 26 September 2026
- `npm test`: **923 passed, 0 failed** (912 before plus 11 in test/backups.test.js: default paths, scripts never stranding the old file, the one-time move — verified copy, old file renamed and kept, note written, idempotent — refusal while another server's lease is live, expired lease, copy failure, another program holding the file open, rotation rule, a real backup with rotation and rate limit, owner-only HTTP endpoints). `npm run check`: 54 files.
- The move was also run with the real server on a **copy** of the owner's database (5.5 MB + WAL, 18 tables) in a scratch folder, with LOCALAPPDATA and BACKUP_DIR pointed at scratch folders: with a live lease it printed "Database NOT moved" and changed nothing; with the lease expired it moved the database (integrity ok, identical row counts), kept the old file as scaffold.sqlite.moved-<time>, wrote DATABASE-MOVED.txt, served on the new file and saved the start-up backup 30 s later; the next start did nothing. The owner's live database was not opened.
- Browser tests (`PW_CHANNEL=msedge E2E_PORT=3417 npm run test:e2e`): **9 passed**, four full runs in a row, including the rewritten delivery flow (sidebar pages, first-run Create yard, stock register columns, truck card states). The Account page Backups panel was checked at 1280 px and 375 px (no sideways scroll) and Back up now refused a second press within a minute.
- `.github/workflows/ci.yml` was written but has not run on GitHub yet; the Linux Chromium browser job is unproven until the first push.

## Review fixes for the database move and backups — 26 September 2026
- Fixes: a lock file serialises every program that chooses, moves or creates the database (servers until their engine holds the lease; seed/import scripts until done); the verified copy is placed at the new home before the old file is renamed; the old file is write-locked (BEGIN IMMEDIATE on a guard connection, released by the OS on a crash) instead of a 10-minute lease row; a write in the gap before the rename undoes the move; an empty new-home database never wins over the real one; a missing database after a move, or an emptied one while the moved-aside file has data, refuses to start; the old file's rename is recorded before its -shm is touched, so a failure there can never strand it; per-database backup names; future/invalid dates ignored by rotation; 10 newest manual copies kept; stale *.partial files swept; e2e scratch folder removed.
- `npm test`: **934 passed, 0 failed** (22 in test/backups.test.js, 11 new: kills after the copy, after the new home is placed and after the old file is renamed; two servers started together; stale and live locks; a writer blocked during the copy and a writer just before the rename; empty and zero-byte new-home files; a missing database after a move; an emptied new-home database after a move; shared backup folder; future/invalid dates and the manual cap; partial sweep). test/backups.test.js also passes with TZ=UTC and five runs in a row. `npm run check`: 54 files.
- The reviewer's repro scripts (scratchpad review/: fault.mjs with every fault, twin.mjs and twin2.mjs, shared.mjs, rot.mjs, heavy.mjs) were re-run against this code on a synthetic database: every fault (none, disk full, failed rename, kill after the copy, kill after the old file was renamed, a writer during the copy, a writer just before the rename) ended with the old file untouched and in use, or the complete data at the new home with the engine starting at once, and nothing lost; two servers started together (0–70 ms apart, same and different ports, 10 runs) always ended with one server on the moved database with all companies; shared.mjs no longer takes the live daily slot; rot.mjs keeps all 14 real dailies; heavy.mjs copies stayed consistent (stall ≤ 11 ms).
- Browser tests (`PW_CHANNEL=msedge E2E_PORT=3417 npm run test:e2e`): 9 passed, twice in a row; the temp folder is removed afterwards.

## Faster, steadier tests and CI — 28 September 2026
Measured on one 4 vCPU Linux box (the same vCPU count as GitHub's ubuntu-latest), Node 24.21. main and this branch ran alternately, so machine drift hit both equally.
- `npm test` on main: **2589 test runs in 97–101 s** (3 runs). There were only 543 different tests: 31 files imported the fixture from simulation.test.js, so its 66 tests ran in 32 processes.
- `npm test` on this branch: **545 tests in 10.4–10.9 s**. These are the same 543 tests (same files and names, checked from JUnit reports), plus two new ones: one checks that no test file or test helper imports a test file, the other that a catalogue batch repeating a variant within itself is refused. Steps, each measured on the full suite:
  - fixture moved to test/fixture.js: 110 → 30 s
  - test users' passwords hashed at scrypt N=1024 via the test/setup.js preload: 30 → 16 s
  - mock timers instead of real sleeps (perf-server scheduler 3.6 s → 0.04 s; shape editor 4.8 s → 0.2 s): 16 → 14 s
  - `f.idle(n)` and the shared `settle`, plus the catalogue import no longer quadratic: 14 → 10.7 s
- `f.idle(n)` is checked, not assumed. A checking version ran the skipped ticks anyway and compared every table and every live object: all **432** early stops (**52,273** skipped ticks) were identical to the full run.
- Browser tests (`npm run test:e2e`, CI=1, so a failed test retries once as on GitHub): main **14 passed in 3.3–3.5 min** (one test at a time). This branch: **14 passed in 51–58 s** in 12 runs in a row, with no retries, 4 of them with two busy CPU loops alongside. This box cannot download Playwright's pinned Chromium, so the runs used the pre-installed headless shell (build 1194) through a local config with executablePath.
- GitHub CI before: main run 36352642644 took **6m15s**: the unit job (2m11s) and then the browser job (3m56s; 29 s installing Chromium and system libraries, 3m18s of tests). After: not measured on GitHub yet, because CI runs only for main and pull requests. Expected: about 1½–2 min, with both jobs at once, the browser from the cache and only the headless shell.

Flaky tests found (stress runs: busy CPUs, `--test-concurrency=8`, several time zones, the clock shifted to just before midnight, each file alone) and fixed:
- reports '50,000 ledger rows': single wall-clock readings failed about 1 run in 20 under load, and a CI log showed the cached read at 6× its usual time. Now CPU time, with the same budgets. The cached read keeps the wall clock on Windows, whose CPU time moves in 15.6 ms ticks.
- revision 'a large relocation previews and saves quickly': failed once at concurrency 8. The budgets and the preview's own 400 ms deadline now use CPU time.
- Midnight: crew-day (2 tests), runs done today (4 tests in simulation.test.js) and the game board Send / Bring back. Work was stamped with the real clock and read back as 'today'. Before the fix, crew failed at 1 and simulation at 3 of 12 start times just before midnight; after it, none failed. These tests now use a fixed clock.
- backups 'two servers started at the same moment': the single-engine check relied on a 600 ms pause. Both children now keep their engine until both have reported, so a broken lease guard fails every time.
- perf-server scheduler and the shape editor debounce tests: real sleeps raced real work. They now use mock timers, stepped so the order of events is the same as in real time. They catch the same mutations as before.
- e2e shape.spec 'focus stays…' and 'the gate cannot…': the 1 s poll repaints the plan while Playwright scrolls a handle into view ("Element is not attached to the DOM"). This failed once on CI (run 36305275821) and 2 in 50 times locally under load. The scroll is now retried.
- e2e sign-ups: the server allows 10 a minute from one address and the suite used exactly 10. There are now two servers (6 and 8 sign-ups), and a refused sign-up fails at once with its reason.

After the fixes, all of these runs passed:
- the full unit suite 3 times plain, 2 times at concurrency 8, 2 times with 3 busy loops, and once each in Kiritimati and Los Angeles time;
- the full suite with the clock 0.3 / 0.8 / 1.5 / 3 s before midnight, in UTC, Los Angeles and Sydney time;
- the 14 formerly timing-sensitive files 5 times each under 3 busy loops.

Still on wall-clock budgets, with wide measured margins and no failures seen: global-search (averaged over 20/60 calls), material-card (averaged over 200) and hire-rules (1500 ms).
