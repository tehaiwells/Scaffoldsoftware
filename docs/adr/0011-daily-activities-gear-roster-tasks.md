# 0011. Daily activities, gear lists, the workers' roster and their tasks (Phase 1A, part 5)

- Status: Accepted, 1 October 2026 (Phase 1A part 5, the owner's brief of 30 September 2026). Two builders: **GEAR** (the gear list, its
  truck and driver, the day-before asks and the confirmation chain) and **CREW** (the Office drawer, workers with a roster calendar,
  tasks, Task progress and Pre-start), merged into one tree. Rests on [0008](0008-live-foundation.md),
  [0009](0009-record-reality.md) and [0010](0010-dispatch-and-returns.md). Both yards: the Practice yard keeps its engine and its
  simulated people; the real yard changes state only from a person's phone or the office recording it for them.

## Context

The owner wants the materials list to be "the list that will be prepared and loaded when the truck arrives": from the yard to a site,
site to site, or from a site back to the yard, with how many of each part, linked to the truck so that confirming the list books the
truck to where the gear is and delivers it where it goes, at a date and a time; on the Daily activities calendar the moment it is
confirmed; the driver told the day before and asked to confirm; then a confirmation at each point (arrived at the yard, packed, arrived at
the site, landed), and the workers on the list confirming that they received it, packed it and loaded the truck. SMS comes later; the
in-app messages and the "Text them" link stay.

## Decision (GEAR)

**One model for both yards: a gear list is a Today MATERIALS item** (`gear: true`) with a `name` ('Bondi gear' by default), a `direction`
(`OUT` yard → site, `MOVE` site → site with `fromSite`, `BACK` site → yard), exact `lines`, a `day` and a `time`, made by one command,
`gearListCreate` (`src/domain/gear.js`). The command books the truck and driver in the same tap: an existing booking of that truck that day is
linked (a different driver named on it is refused in the booking's own words), else `planTruck` makes one and the driver is asked to drive,
as for any booking. A real yard makes the exact order (`orderMake`, holds at the yard, or at site A for a move) and the trip
(`tripBook`); the Practice yard's engine packs and drives. The list is on the calendar at once because it is a plan item. Workers given on
the form become the list's task through CREW's `taskCreate` (guarded by `typeof`, so each clone runs alone). `gearListUpdate` renames a
list and moves its lines, day, time or truck through `planMove`; `planCancel` cancels it as any item, calling off its asks and its task.

**MOVE is a third order and trip direction** (`trips.js`, additive): orders `M-1, M-2 ...` with `fromSite`; holds come from A's stock;
`tripCollected` moves A → truck (the truck then heads for B, not the yard), `tripDelivered` truck → B; the ledger rows carry the places, so
`hire.js` (untouched) reads Collected at A as the end of A's hire and Delivered at B as the start of B's, by the piece (`test/gear-move.test.js`
proves it with the hire statement); a move counts as open work at both sites; `DELIVERED_SHORT` leaves the rest on the truck until Back at
yard. The Practice yard has a `MOVE` autopilot (`game.js gameMoveStart` / `gameStep`): the truck drives to A, the site crew loads the
stillages holding the gear, it drives to B, unloads with B's crane and comes home; stock never teleports. A bring-back in the Practice yard
runs the board's own Bring back with the list as its plan.

**The chain** (`src/domain/gear-chain.js`): per direction, in order, with the owner's words:
OUT `Arrived at yard · Packed · Loaded · Arrived at <site> · Landed`; MOVE `Arrived at A · Loaded · Arrived at B · Landed`; BACK
`Arrived at <site> · Loaded · Arrived at yard · Back at yard`. The movement steps are the confirmations of ADR 0009 (they move stock);
the two arrivals are **light confirmations**: `tripArrived {trip}` (a real yard; the step is chosen from the trip's state: the pickup before
the load leaves, the drop while it is on the truck) writes one append-only `trip_arrival` row (migration 010; `trip_confirmation`'s CHECK
lists the movement steps only), the mark on the trip, no ledger row, no stock, no state. An arrival is an **optional gate**: `tripNext`
offers it beside the movement step, a driver who taps Loaded without Arrived is not held up (the dot stays empty), and the arrival cannot be
recorded once the step it gates went first ("Already loaded & left: the arrival was not recorded in time"). Provenance as every
confirmation: the driver's own tap `PERSON`, the office's `ON_BEHALF` of the driver. In the Practice yard the engine writes the same
marks on the item (`it.chain`, kind `ENGINE`) as each stage begins, and the item's view reads them; a real yard's view reads the trip's
steps (`planItemView` gets `name, direction, from, to, chain, truckItem, readyAsk, task, arrival` for every gear list).

**Messages** (`plan.js`, additive): a registry of message kinds (`MESSAGE_KINDS` / `registerMessageKind`, hooks `isOpen`, `deadline`,
`text`, `summary`, `onAnswer`, `onSeen`, `scope`) with `about: {kind, id}` on a message, so CREW's roster and task asks share the one
sender, the one answer path (`messageAnswer`, `messageSeen`, the simulated replies) and the clock's call-offs; the plan-item kind is
registered with the behaviour it always had. New subjects to the driver: `READY` at 3 pm company time the day before ("Confirm you'll be
ready?", Confirm / Can't make it; at once when the list was confirmed later, never after 6 am on its day: "Not asked in time"), and `DAY`
at 6 am on the day (a notice, Got it). A driver who says no flags the list and the truck booking ("Dave can't make it: … Pick another
driver.", on Needs you through the existing path); a driver changed on the booking is asked instead. `gearAsks(now)` runs inside both
clocks (`clockPass` and the Practice yard's `planPass`, through `planPartFive`, which also calls CREW's `rosterFillDue`, `rosterAsks`,
`taskAsks` when present, each in its own savepoint).

**Screens** (the same tiles, pills and dots as Today): Today is titled **Daily activities**; the day panel's `+ Materials` became
**+ Gear list** (`public/gear.js`, one form: Name, From / To as This yard or a site, the parts picker, Date, Time, Truck (booked ones
marked, hire in the Practice yard), Driver (fixed when the truck is already booked with one), Workers with P1 / P2 / P3 chips, Note; one
button, Confirm; the draft toggle in a real yard stays); the calendar chip says the name, the time and an arrow by direction; the card
shows From → To, the truck and driver with the driver's answer and the READY ask's, the chain as dots with the words under each (filled
when done, with the time and who), the workers' three ticks from the task, and in a real yard the trip's own buttons with a quiet
**Arrived** button when an arrival is next. The Dispatch lanes gained the dots **At yard** and **At site**. The Materials catalogue is
titled **Gear list** and carries "Gear lists this week" with **+ Gear list** (opens the form on Daily activities). The driver's phone
shows the chain's steps, an "Arrived at yard / Arrived at Bondi" button when it is next (one key per tap, queued like every tap), and the
READY / DAY messages beside its other asks.

**Not done by itself, ever:** in a real yard the clock only sends READY and DAY, flags a no, and never writes a step (the LIVE invariant
in `test/live-gear.test.js` runs 10,000 passes over a gear list); `tripArrived` is `requireLive`; the Practice yard's marks are the engine's.

## Consequences

- New commands (on the LIVE allow-list): `gearListCreate`, `gearListUpdate` (office), `tripArrived` (the trip's driver from a phone, or
  the office for them; `CREW_PHONE_OPS` includes it). Views: `GET /api/gear?day=&days=` (lists with their chain), `GET /api/gear/places`;
  `tripView` gains `fromSite`, `fromSiteName`, `chain`, `arrival`; `orderView` gains `fromSite`, `fromSiteName`.
- Migration 010: `trip_arrival` (append-only, LIVE-only, the same triggers as `trip_confirmation`) and an index on plan items by day;
  CREW appends its roster and task indexes.
- An old-style Materials list (planMaterials) is untouched: no name, no chain, no READY ask; the DEMO suite is unchanged.
- Tests: `test/gear.test.js` (the Practice yard: directions, the default name, the chip, the truck link, hire, READY / DAY, a no, the
  engine's marks and the task hook's call order, site → yard and site → site by the autopilot, an old list untouched),
  `test/live-gear.test.js` (a real yard: one tap, READY at 3 pm Perth time on a Sydney server and the driver's own phone, the invariant,
  the chain with `trip_arrival` rows and provenance, the optional gate, bring-back, move the day, cancel), `test/gear-move.test.js` (site →
  site: holds at A, the two moves, hire by the piece with `hire.js` untouched, both sites busy, short then back), `e2e/gear-list.spec.js`
  (a real yard end to end on the pages and the phone) and `e2e/gear-demo.spec.js` (the Practice yard: the dots fill by themselves).

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

## At the merge (both halves in one tree)

- **One registry.** plan.js's `MESSAGE_KINDS` is the registry; roster.js's stub and the pass wrappers switch themselves off (`seamReady`).
  `messageAnswer` on a roster or task ask keeps the words CREW's phones and tests expect ("Thanks. See you then." / "Marked as confirmed
  for Kev."), returns the record it is about (`rosterDay`, through the kind's `reply` hook), and lets an answer be changed while the day is
  still ahead, as a booking's ask does. The Practice yard's quiet-minute look at the roster and the asks (`installCrewTick`) stays on:
  the engine's tick only passes while something is busy, and a roster pattern alone is not.
- **The task is the list's.** `gearListCreate` returns the task it made (`task`) and names the workers in its reply; a worker's *Packed
  and ready* from a yard phone saves the task before it records the pack on the trip, because the trip's pack comes straight back
  through `taskListSync` (which keeps the phone's mark); the driver's *Loaded & left* finishes the task with his own mark.
- **Tasks on the calendar.** `GET /api/plan` (`planMonth`) carries `tasks` for the grid's days; a plain task is a chip of its own
  ('P2 Sweep the racks · Kev'), a gear list's task rides on the list's chip; the day panel lists the day's tasks under its bookings, one
  line per task with each worker's ticks and a link to Task progress on that day. `test/part5-merged.test.js` walks the whole story in
  both yards.

## After the review (the owner's and the adversarial findings on the merged tree)

- **One ask per person per day.** A worker's TASK_READY and TASK_DAY are one message for every task of theirs that day: off one task
  (cancelled, unassigned, moved) they are called off only when no other open task that day still needs them (`taskCallOffMsgs`); a task
  added after 3 pm joins the ask already standing (`taskOpenAsk`, its words refreshed while unanswered) and a fresh one goes only after a
  no. The driver of a truck booked by a gear list gets the list's READY at 3 pm the day before and nothing else: the booking is made
  `viaGear` (the list's id), plan.js and clock.js send no DRIVE while an open gear list is on it and the day has not begun
  (`gearAsksDriver`), the READY becomes the booking's own `message` (one answer on the card), an unanswered DRIVE on a linked booking
  gives way to it, and a driver changed before 3 pm is told he gets a message then. A list made after 6 am on its day asks as any booking
  does and is never flagged "not asked in time".
- **The roster and the tasks agree.** A pattern that stopped fills again (`rosterFill` takes back a REMOVED day it left; a day the
  office cleared by hand stays off). A place or time change on an asked day calls the ask off and asks afresh; a superseded ask is
  finished. A worker who said they can't work is refused on a task that day; one not rostered is rostered in the same tap when the form
  says so (`roster: true`, ticked by default on the gear form and + Task); Task progress, the day panel and the gear form say
  "can't work" / "not rostered" per worker; a denied day drops their tasks from their phone and Needs you names the task ("Kev can't
  work tomorrow: P1 Bondi gear needs someone"). A moved list keeps one task per priority on its new day (`taskMovedFit`: the next free
  priority, or off with a notification).
- **Marks are the person's own.** The driver's Loaded (or the office's Packed on the trip) never ticks a worker's *Got the list*; only
  the Practice yard's crew (ENGINE / SIMULATED) stands in for everyone. A phone's tap on a later task waits for their part of the earlier
  one (`taskInOrder`, P1 before P2; the office ticks in any order). The office's phoned-in Done on a gear-list task records the pack on
  its trip too. The queue drops an ALREADY_DONE like an ALREADY_CONFIRMED.
- **On screen.** The gear picker counts the place the gear comes from ("free at Bondi now") and a gear list is exact in both yards
  (the Practice yard's crew still lifts whole stillages to fill it); a gear list's trip is drawn once (on the list's card; the truck card
  has one line to it) and the chain's Arrived button only when no trip block carries it; the card names the packers ("Kev and Sam pack it
  on the day"); the phone hides the Pack ask and pack card for people on the list's task, files an answered day-before ask away once the
  day begins, lists finished tasks under Done and offers *Change my answer* while the day is ahead; a tap on an asked roster day opens a
  choice (They said yes / They said no / Take them off); the Gear list page opens on the week's lists; the pre-start says one word per
  person and the print shell one title. `test/part5-review.test.js` covers each.
