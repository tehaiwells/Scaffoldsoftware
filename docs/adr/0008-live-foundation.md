# 0008. The LIVE foundation: how 0001, 0002 and 0003 were built (Phase 1A, part 1)

- Status: Accepted, 30 September 2026 (Phase 1A part 1 of 4). Builds [0001](0001-company-mode-live-demo.md),
  [0002](0002-business-clock.md), step 1 of [0003](0003-provenance-before-events.md) and the first LIVE suite of
  [0006](0006-demo-and-live-test-suites.md).

## Context

The owner's company ("tee") and every other company were made by the simulation. He wants his real yard in the same app without losing
the Practice yard he likes, and without anything invented appearing in the real one. This part ships the wall, the clock, the provenance
columns, a way to start the real yard, and a quiet LIVE board. Confirming real movements (packed, loaded, delivered, counted back) is
part 2; until then a real yard only keeps records.

## Decision (the smallest correct version)

**Mode (migration 007).** `companies.mode` (`LIVE` / `DEMO`, default `DEMO`, so every existing company is the Practice yard) and
`companies.time_zone` (default `Australia/Sydney`). A trigger refuses any change of mode, both ways. New companies are DEMO unless made
LIVE: "Start your real yard" on Account (owners, or the server administrator), or sign-up with `mode: 'LIVE'`.

**The wall, in three layers.**
1. `Simulation.execute` takes a LIVE company's command only if it is on `LIVE_OPS` (`src/domain/mode.js`), an allow-list of
   record-keeping commands; anything else is 409 "Not in your real yard yet ... comes next". An allow-list, so a command added later is
   refused in LIVE until someone decides it records real work.
2. The engine never touches a LIVE company: the scheduler selects DEMO companies only, `tickCompany` returns at once, and
   `Simulation.tick` / `tickJobs` (the autopilot, yard jobs, site finish, the planner's day runner) do nothing for LIVE whoever calls
   them. `planPass`, `planStep` and `planTick` route a LIVE company to the clock; `planSimReplies` never answers in LIVE.
3. The ledger refuses an `ENGINE` row for a LIVE company (trigger `ledger_live_people_only`).
Inside allowed commands, the simulation's inventions are switched off for LIVE: `gameStart` makes the yard only (no crew, forklifts or
trucks); `gameSite` adds no "Crane 1" or two workers; `site()` stores no "Demonstration site" address; trucks and sites are marked
`LIVE`, not `DEMO ONLY`; the config has jobs, routine jobs and simulated replies off; Today's demo team start is never offered; the
materials booking does not claim whole stillages will be packed.

**The business clock (`src/domain/clock.js`).** `clockPass(now)` per LIVE company, on its own 30 s timer (`startClock`, started by the
server next to the engine, without the engine lease). It delivers due messages (the one sender, `clockDeliverDue`, which the Practice yard's
`planPass` now calls too), asks the driver when a truck is booked, asks each person on a Workers booking at 3 pm the day before (late
after downtime, said on the booking; never once the start time has passed: "Not asked in time" instead), asks the yardsman on the list's
pack day, sends one reminder after two hours without an answer while the time is still ahead, flags "No answer yet", "can't make it" and
"Short by n", and says once a company day when paperwork is expired, expiring or due for review. When a day ends it marks each open item
**"Not confirmed: <what the records say>"** (stage `UNCONFIRMED`, status stays open), never DONE and never "Didn't go": the office cancels
it, and part 2 adds "confirm". Company days and times come from `src/domain/zonetime.js` (Intl, the company's zone, daylight saving
included); Today's bookings (`planNowCal`, `planWhen`, `planAsk`, `planMove`, the phone view's "too late") use the same in LIVE. The
Practice yard keeps the server's local time and all its simulated steps, exactly as before.

**Provenance (ADR 0003 step 1).** Ledger columns `occurred_at` (backfilled from `created_at`), `actor_kind` (`PERSON`, `ON_BEHALF`,
`ENGINE`, `IMPORT`; old rows `ENGINE`), `on_behalf_of`, `origin` (old rows `before-provenance`). `Simulation.execute` sets the provenance
for the command's writes: `PERSON` with `origin command:<action>`, or `IMPORT` for opening stock; outside a command a row is `ENGINE`
(`origin engine`), which only the Practice yard can write. `ON_BEHALF` is in the schema for part 2 (the office confirming for a driver);
nothing writes it yet. The engine's rows keep the owner's id as `actor` (changing it to `system:engine` would change the Practice yard's
history pages; `actor_kind` carries the truth).

**Screens.** Account: "Your yards" (two big choices, the Practice yard first, the current one marked "You are here") for anyone in more
than one company, and "Start your real yard" (name and time zone) for an owner without one; the new yard opens at the existing "How big is
your yard?" step. The board's chip says "Practice yard · simulated" or "Live · your real yard"; for someone in two companies it is a
button with the same two choices. The LIVE board draws the yard, sites and trucks from records where they were last put (nothing drives,
no people are drawn until sign-on exists, no site crane unless one is a record), has no Send or Bring back (a calm hint and a site note
say they come next) and keeps Add stock. The LIVE Office hides the Control room and Schedule; its Workers page is "Your team"; its pages
carry a calm Live strip instead of the simulation strip, and no Pause, "answer by themselves", Re-stack, movement panel or synthetic
catalogue. `public/mode.js` holds the chip, the tile rule and the switcher, so the pages share one rule (ADR 0007: new code in its own
module; the pages touched in `operations.js` changed in place by a line or two each).

## Consequences

- A real yard can keep its catalogue, stock received, removed, opening stock and stocktakes, stillages, sites, trucks and people as
  records, paperwork, hire rates and company details, and plan its days on Today with real asks. It cannot yet send, bring back, pack,
  load, deliver or count back a truck: every such step waits for part 2's confirmations. The LIVE board therefore shows parked trucks.
- Messages are still in the app only; the clock is the seam a text-message provider plugs into (`planDeliver`).
- Views other than the clock and Today's booking rules still read days in the server's local time; they agree while the server runs in the
  company's zone (customer zero). Hosting in another zone (ADR 0004) needs those views moved to company time.
- Tests: `test/live.test.js` (the LIVE suite: never ticks to make anything happen; 10,000 engine rounds and 10,000 clock passes leave a
  LIVE company's records byte-identical apart from messages, notifications and booking flags; permissions; the wall; provenance),
  `test/clock.test.js` (3 pm ask, 8-hour catch-up, too late to ask, Perth on a Sydney server, zone arithmetic across daylight saving),
  `test/live-migration.test.js` (every company DEMO and nothing else changed, on a made database and, with SCAFFOLD_MIGRATION_SAMPLE, a
  copy of a real one), `test/live-ui.test.js` and `e2e/live.spec.js`. The ticking tests remain the DEMO suite, unchanged.

## After review (fixes)

- **Company time everywhere a day is decided on Today**: the Today page, its month, the phone view's "can still answer", "no answer",
  the snapshot's calendar (`scheduleMethods.calendar`) and the crane hold read the company's zone through `planNowCal`, `planToday`,
  `planAt`, `planDayOfIso` and `planParts`; the Practice yard keeps the process's local time. Hire and Reports still use the server's.
- **One real yard per owner** (`createLiveCompany` refuses a second with 409, whoever calls it and from wherever).
- **The Office in a real yard offers only what it can record**: the Control room and Schedule are unreachable from any link (render
  redirects, links hidden); Big trucks shows the truck as a record (parked, payload) with one "comes next" line; Client sites has no
  requests, yard lists or drag-to-return; Yard layout has no crew orders, Turn/Load, planner, truck drop zones or DEMO resources form;
  Equipment, Overview and Today say how many people are on the team, never who is at the yard, idle or working; the Today legend lists
  only Truck, Materials and Workers. `e2e/live-office.spec.js` walks every Office page of a real yard and fails on any simulation
  control or refused command.
- **Remove site in a real yard** (`gameRemoveSite`, `gameRestoreSite`, `gameReopen` and `siteBoundary` are record keeping): a site with
  nothing recorded goes (with Undo); one with scaffolding recorded is refused in plain words, never "brought back" by a simulated crew.
- **People by name only**: `quickAdjust` WORKER is refused in LIVE (people come from Your team).
- **ON_BEHALF provenance**: an answer recorded by the office (or on the office's phone view) is `ON_BEHALF` of that person; a real yard
  stores it as via OFFICE until people sign in on their own phones. The enum stays `ON_BEHALF` (the name in the Phase 1A brief).
- **The clock only flags**: a list whose site is gone is flagged for the office to cancel; a whole day with the computer off says "not
  asked in time". A booking that ended "Not confirmed" can be moved to a new day and starts again.
