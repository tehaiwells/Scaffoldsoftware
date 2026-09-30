# 0011. Daily activities, gear lists, the workers' roster and their tasks (Phase 1A, part 5)

- Status: Accepted, 1 October 2026 (Phase 1A part 5, the owner's brief of 30 September 2026). Two builders: **GEAR** (this section:
  the gear list, its truck and driver, the day-before asks and the confirmation chain) and **CREW** (the Office drawer, workers with a
  roster calendar, tasks, Task progress and Pre-start: their section follows at the merge). Rests on [0008](0008-live-foundation.md),
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

## CREW

(Their section: the Office drawer, workers with the roster calendar, tasks, Task progress, Pre-start; added at the merge.)
