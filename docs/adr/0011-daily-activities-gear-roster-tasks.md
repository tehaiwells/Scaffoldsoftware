# 0011. Daily activities, gear lists, the workers' roster, tasks, Task progress and Pre-start (Phase 1A, part 5)

- Status: Accepted, 1 October 2026 (owner brief of 30 September 2026). Rests on [0008](0008-live-foundation.md), [0009](0009-record-reality.md)
  and [0010](0010-dispatch-and-returns.md). Two builders in parallel: GEAR (gear lists, the driver's chain) and CREW (this section: the
  Office drawer, workers, roster, tasks, Task progress, Pre-start). GEAR's section is added at the merge.

## The Office, the workers, their roster and their tasks (CREW)

**The drawer in the owner's order.** Every day: Yard & sites, Daily activities (Today renamed; the Schedule tile went, the calendar does
that, and `?view=SCHEDULE` opens Daily activities in both yards), Gear list (the Materials catalogue renamed), Workers, Task progress,
Pre-start. Yard and fleet: Client sites, Yard layout, Equipment, Big trucks, Small trucks, Stock ledger, Control room. Business unchanged.
The view ids (`TODAY`, `MATERIALS`) do not change; `PROGRESS` and `PRESTART` are new. The Schedule's data and commands stay (the Practice
yard's simulated loads run through them).

**+1 worker (`teamAdd`, both yards).** Name, job (Yard worker → YARDSMAN, Onsite worker → SCAFFOLDER, so the phone's permissions follow),
where (the yard or an active site: the Practice yard stands them with that site's crew; a real yard keeps it as a record), phone, email
(`normEmail`). `teamUpdate` takes the same. Leading hands and drivers are still added on the folded "More" form.

**The roster (`src/domain/roster.js`).** One record per person per day, kind `rosterDay` (`source` PICKED or PATTERN; `status` ROSTERED,
CONFIRMED, DENIED, REMOVED; where; time). `rosterPick` / `rosterClear` are the taps on the Workers page's calendar; `rosterPattern`
(Mon–Fri or Mon–Sat, kind `rosterPattern`, stored as `type`) fills **today + 1 … today + 14 only**, never today, never a day that has a
row (a removed day is never refilled, a picked day never doubled); each company day the clock (`rosterFillDue`, once a day through
`clockState.rosterFillDay`) adds the next day so the window stays a fortnight ahead. Firing someone (`teamRemove` → `rosterPersonGone`)
removes only their days ahead (at most the fortnight plus any picked), ends the pattern and calls off their asks; today's row stays.
Rostering is record keeping: LIVE and DEMO run the same code.

**The day-before ask.** At 3 pm company time the day before (`rosterAsks`, from the clock's pass and the Practice yard's `planPass`
through `installCrewPasses`), each rostered person gets one ROSTER message ("you're on tomorrow at Bondi from 7:00 am, Confirm or Deny");
a day picked after 3 pm is asked at once; a day that has begun unasked is flagged "Not asked in time" (a notification), never sent. The
answer (the person's phone, PERSON; the office for them, ON_BEHALF; the Practice yard's simulated reply, SIMULATED) sets the day
CONFIRMED or DENIED at once; a denied day shows red on the roster and as `ROSTER_DENIED` on Needs you. The clock's `clockRemind` sends
the one reminder after two hours (the message carries the day and time). The clock never confirms or denies (the LIVE invariant).

**Tasks (`src/domain/tasks.js`, stored kind `workTask`: `task` is the engine's movement task).** A task is a gear list to pack and load
(LIST, linked to its MATERIALS plan item; its name, site, time and day follow the list through `taskListSync`) or a plain job (PLAIN),
on one day, with one or more workers each at priority 1, 2 or 3: one task per priority per person per day, three a day at most. Steps of
a LIST task: Got the list (each worker), Packed and ready (once, by anyone on it), Truck loaded (once; the task is DONE). A yard hand's
Packed and ready from their phone also records `packConfirmed` on the list's trip in a real yard (already packed: the task mark is kept).
A PLAIN task is done when every worker has tapped Done, or the office marks it (`taskDone` for one, or `all: true`). Every mark carries
`{at, by, byName, kind: PERSON | ON_BEHALF | ENGINE | SIMULATED, onBehalfOf}` like a trip's steps; a step already there is 409
`ALREADY_DONE` with its time; a phone's tap is always its own person's (`for` is ignored) and scoped to tasks that name them (404 else).
Messages: one TASK_READY per worker per day at 3 pm the day before listing their tasks in priority order (Confirm / Can't make it), one
TASK_DAY notice at 6 am (Got it); a task still open at the end of its day is flagged NOT_CONFIRMED once (a notification, `TASK_NOT_DONE`
on Needs you), never done. The Practice yard's simulated workers tap Done on a timed plain task two hours after its time (off with the
demo answers switch); a list task there is done by the engine through `taskListSync` (the gear-list builder's call sites).

**The seam with the gear-list builder.** `taskListSync(planItemId, step, now, mark)` with RECEIVED, PACKED, LOADED, CANCELLED, MOVED;
`taskForList(planItemId)`; `taskCreate({kind:'LIST', list, workers:[{person, priority}]})` from the gear-list form. Message kinds:
roster and task asks carry `about: {kind, id}` (`item: null`, `itemType` ROSTER / TASK); their hooks (`isOpen`, `deadline`, `text`,
`summary`, `onAnswer`) go through `registerMessageKind` when plan.js exports it, else the local stub in roster.js
(`installMessageKindStub`) wraps `messageAnswer`, `messageSeen` and `planAnswerMsg`, and `installCrewPasses` runs the fill and the asks
after `planPass` / `clockPass`. Both switch themselves off once the registry is in plan.js (`seamReady`).

**Views and pages.** `GET /api/roster` (one person's grid, or a day), `GET /api/tasks?day=` (every worker with their tasks, "N of M done";
a supervisor: their sites' workers, read-only, plain tasks at their site only), `GET /api/prestart?day=`, `GET /api/team?roster=1`,
`crewMe.myDay` / `roster` and the Practice yard's `personView` / `crewDay` the same. Pages: Workers (Your team first, +1 worker, a
Roster button per worker that unfolds the month grid: tap to roster, tap again to clear, ✓ confirmed, ✕ can't, Mon–Fri / Mon–Sat, Where
and Time), Task progress (`public/tasks.js`, a 1 s poll redrawn only when the answer changed, tick boxes per step, "Tick for them" with
a one-line confirm, + Task, Text them, Swap), Pre-start (`public/prestart.js`, a date picker and one Print through `prOpen` with the
kind `prestart`; `prestartSheet(view)` is pure), the worker's phone "My day" (`public/crew.js`: the roster card with Confirm / Deny, Now
with one big button for the next step, Next, Tomorrow; one key per tap as before) and the office's phone view (My day, ticks for them).

**Migration 010** adds the roster and task indexes on `objects` (the gear-list builder's `trip_arrival` table lands in the same file).

- Tests: `test/roster.test.js`, `test/tasks.test.js` (the DEMO suite), `test/live-roster-tasks.test.js` (the LIVE suite: the phones, 3 pm
  company time, the invariant over 10,000 passes with a pattern, a shared task and a list, migration 010 on a copy of a real database
  with `SCAFFOLD_MIGRATION_SAMPLE_V9`), `test/prestart.test.js`, `test/office-tiles.test.js`, `e2e/roster-tasks.spec.js`; the LIVE
  invariant helper (`records()`) now strips only what the clock may write on roster days and tasks (asks, notices, flags) and leaves
  out a pattern's still-rostered days.
