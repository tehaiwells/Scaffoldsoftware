# 0009. Record what really happened: orders, trips and their confirmations (Phase 1A, part 2)

- Status: Accepted, 30 September 2026 (Phase 1A part 2 of 4). Builds audit §11 #2 (confirmed movements with provenance), #3 (exact
  quantities), the thin version of #5 (a driver's phone), the data of §12 #22 (the LIVE board) and the `trip_confirmation` record of
  [0003](0003-provenance-before-events.md). Rests on [0008](0008-live-foundation.md). A real yard only: the Practice yard is unchanged.

## Context

After part 1 a real yard keeps records but nothing in it can move: every step of a delivery was the simulation's. The owner needs to send
exactly what a site asked for, have the driver (or the office for the driver) say what really went and arrived and when, bill hire from
those moments, and see his trucks on the board by what people confirmed, never by a timer.

## Decision

**Orders (kind `order`, audit #3).** One order is one site's request, `OUT` (send) or `BACK` (bring back), with lines `{product, requested}`
kept exactly as typed (never snapped; the pack size comes back beside it as a hint, never a gate). Creating one (`orderCreate`,
`bringBackCreate`: from the board's Send / Bring back, from Today's Materials in a real yard, or the office) **holds exact pieces** at once:
yard stock for OUT, the site's stock for BACK; a container holding exactly what is left first, then whole stillages, then the smallest one
that covers the rest. A line that cannot all be held now says how many are short and is topped up when it is loaded. Holds are the
existing `reservation` kind with `order` in place of `task`, so "free" means the same on every page; a used or released hold is removed
(it records nothing: the order's lines and the confirmations do). `orderCancel` releases them while nothing has left.

**Trips (kind `trip`, audit #2).** A trip is one run of one truck with its driver to one site, carrying one or more orders of one direction.
It always belongs to a Today truck booking (a `TRUCK` plan item: truck, driver, day), which may hold several trips. `tripBook` takes a
booking, or a truck + driver + day and makes the booking (the driver is asked, as today). Today's Materials in a real yard makes the order
and, when a truck is chosen, the trip; cancelling or moving the list or the booking follows (refused once something has left).

**Confirmations.** Five steps, each a command through `Simulation.execute` (idempotency key; on the LIVE allow-list; refused in DEMO):
`packConfirmed` (yard, optional, moves nothing), `tripLoaded` (Loaded & left: what went on, per product), `tripDelivered` (per product,
received by a name, required), `tripCollected` (bring-backs: what came off the site) and `tripReturned` (Back at yard: a simple per-product
count; count/loss/damage is part 3). Lines left out mean "as expected" (one tap). Each writes one append-only `trip_confirmation` row
(migration 008: site, lines, `occurred_at`, `recorded_at`, actor, `actor_kind` PERSON or ON_BEHALF, `on_behalf_of` = `driver:<id>`, origin
`command:<action>`, backdate reason, key; a trigger refuses it for a DEMO company) and moves stock through the existing ledger pipeline with
the same provenance and `occurred_at`. **Stock changes place only here:** yard to truck on Loaded & left, truck to site on Delivered, site to
truck on Collected, truck to yard on Back at yard. The truck record follows (`status`, `at`, `liveTrip`).

**Custody of exact pieces.** A container whose whole content goes (and that no other order holds) moves as it is; a stillage going back to
the yard returns to its own spot (or on top of the stack there). A part is split: the pieces go into a new `BUNDLE` container at the same
place (ledger `SPLIT`, container to container, no change of place) and the bundle moves. Loose pieces set down at a yard or site join that
place's one loose bundle (`CONSOLIDATED`, no change of place; the emptied bundle is retired with no place), so a yard does not collect a
bundle per trip. Ledger events `LOADED`, `DELIVERED`, `COLLECTED`, `RETURNED` carry places as `source`/`destination`, so Reports and Hire
replay them as the simulation's lifts (LOADED/COLLECTED as loaded onto a truck, DELIVERED/RETURNED as set down). `contents` stays the one
no-negative balance; the ledger and `trip_confirmation` stay append-only. Loaded may differ from held: fewer releases the rest, more picks
free stock or is refused ("only 12 more free"). Delivered less than loaded leaves the rest on the truck ("Delivered short") until Back at
yard, and that truck cannot be loaded for another trip until then.

**Time.** `occurred_at` defaults to now. A person may type an earlier time (`at`): more than 15 minutes back needs a `reason`, kept on the
confirmation, the ledger row and the audit log (`trip.backdated`); never in the future, within the open period (the last 7 days and never
before the real yard started; part 4's statements will close periods), never before the trip's previous step, and a collection never before
the latest delivery to that site. A phone's queued tap sends its tap time (`atSource:'tap'`, no reason) and is kept inside what is possible
rather than refused, so a phone with a slightly wrong clock never loses a tap. **Hire** reads `occurred_at`: a piece is on hire from the
confirmed Delivered day to the confirmed Collected day (pricing unchanged). Reports and Hire (and the alerts built on them) count only
non-ENGINE rows in a real yard.

**States.** Trip: `BOOKED`, `PACKED`, `LOADED` ("Loaded, not delivered yet"), `DELIVERED`, `DELIVERED_SHORT` ("Delivered short"),
`COLLECTED` ("Collected, not back yet"), `RETURNED` ("Back at yard"), `CANCELLED`; order: `OPEN`, `BOOKED`, `LOADED`, `DELIVERED`, `SHORT`,
`COLLECTED`, `RETURNED`, `CANCELLED`. The business clock flags, never advances: `UNCONFIRMED_TRIP` ("Not confirmed: ...", said once as a
notification) when a booked trip's day ends without Loaded & left, when a loaded trip passes its usual minutes + 30 without Delivered, a
collection without Back at yard, or a short delivery at day end. A confirmation clears it. The Today booking is done when every trip on it
is delivered or back; a Materials list when its order is delivered.

**The driver's phone (thin #5).** Role `CREW` (permission `trips.confirm`, also given to owners and managers). The office makes a link for a
driver on the team: a one-time token (hash kept, 7 days) with "Copy link" and an `sms:` body; a driver's first link makes their CREW sign-in
(a member with no password). The phone claims it and gets its own cookie `crew`: a device session of 180 days, renewed while used,
recorded in `crew_devices`, signed out from the phone or the office ("Sign out this phone"), and ended when the driver leaves the team or
the company. A crew cookie opens only `/api/crew/*`: its own trips (today's, and earlier ones still open) and the four confirmations of its
own trips; another driver's trip is "not found". The office confirms for a driver (ON_BEHALF). Phones reach the server only with Wi-Fi
sharing on (Account, This computer) or later hosting, and the link says so. `public/crew-queue.js` is the phone's tap queue: one
idempotency key minted per tap, stored with the tap before sending, resent with the same key until the server answers.

**The LIVE board's data (#22).** `snapshot.liveBoard`: each truck by its last confirmed step (`PARKED`; `BOOKED` with "07:30 → Bondi";
`TO_SITE` after Loaded & left; `AT_SITE` after Delivered; `TO_YARD` after Collected), with `since`, the trip, words ("Left 7:42 · usually
~35 min"), an estimate (`minutes`: the site's typed `plannedMinutes`, else the median of its last 5 confirmed trips, else 30; `cap: 0.9`, the
page never draws past it) and `late` (usual + 30 min passed); `replays` (confirmations recorded in the last 15 minutes, by id); `sites`
(pieces per product from the records). Nothing is invented: no position without a confirmation.

**Scale.** A real yard keeps years of orders, trips and bundles, so every command reads only what it needs: partial expression indexes on
`objects` (containers by place and support, trips by state, booking and truck, orders by status, holds by order) and the site on each
confirmation. 1,000 orders confirmed end to end take about 17 s in the property test, flat per command.

## Review (30 September 2026)

An adversarial pass and an owner-and-driver walk-through of part 2 changed these rules (tests: `test/live-review.test.js`,
`test/live-hire-zone.test.js`, `test/live-ui-trips.test.js`, the new cases in `test/crew-auth.test.js`, `e2e/live-trips-ui.spec.js`):

- **A phone's tap time is a phone's only.** `atSource:'tap'` counts only from a crew device sign-in; the office's time is a typed time (a
  reason past 15 minutes). A tap sent more than 15 minutes after it was made is kept with its own reason ("Tapped on the phone at 09:05,
  sent 15:00") and audited as `trip.backdated`. A typed time when the same truck was, on record, out on another trip needs a reason too.
- **A collection is dated by what the site held**, not by the last delivery there: from the site's pieces now, less deliveries and plus
  collections confirmed after the typed time, the site must have held what is collected all the way to now ("Bondi had only 0 × ... on
  record at ..."). An unrelated later delivery no longer blocks a paper docket.
- **Back at yard from Loaded & left** ("Came back, not delivered"): the pieces go truck to yard, the trip is `RETURNED` with `undelivered`,
  its orders `NOT_DELIVERED`; the office has Send again (a new order of the same pieces) and a Today list with that order can be cancelled.
- **Holds follow the stock.** A stillage an order holds cannot be removed ("Held for O-1 for Bondi. Cancel or change that first."); after a
  count, a removal or a retire in a real yard, holds beyond what is really there are cut back and topped up from free stock
  (`orderHoldsFit`); a Loaded & left takes a hold only for pieces really in that stillage.
- **Phones:** taking a sign-in off the company, or a driver leaving the team, signs out every phone and cancels open links; a later link never
  revives an old phone. The `crew` cookie gets its 180 days again when used. A tap refused with 401 stays on the phone for after a new link.
  A tap the office had already recorded differently comes back as `409 ALREADY_CONFIRMED` with `detail` (what was recorded, and whether it
  says the same); the phone shows the difference and the office gets one "Driver says different" notification per tap. "Received by" is
  never filled in (last time's name is a chip). A service worker (`public/crew-sw.js`, network first, secure addresses only) and a manifest
  open the page with no signal.
- **Days and times:** Hire and Reports count a real yard's days in the company's zone. Bookings keep a chosen time; a truck's next trip that
  day defaults to an hour after its last. Orders are numbered per direction (O-1..., B-1...).
- **The board:** usual minutes learn only from drives both tapped on the driver's phone, at least 5 minutes long and not both sent within 2
  minutes of each other, once there are 3; a delivery from an earlier day gives way to today's booking; `liveBoard.today` is the company day.
- **Guards:** a truck with an open trip cannot be removed; a site with an open order or trip cannot be removed or archived; nothing loads for
  a removed site. A trip that left answers the booking's driver ask yes.

## Consequences

- The Practice yard is untouched: every command here is LIVE-only; the simulation's request/allocate/dispatch path is unchanged (its
  pack-size gate is lifted only for a real yard, where it is not reachable anyway); the DEMO suite is unchanged.
- A trip has one site and one direction; a delivery-then-collection run is two trips on one booking. Hire trucks cannot carry a trip yet.
  A truck booking for today cannot be made after 5 pm (Today's rule).
- Returns are counted per product only; what does not come back stays on the truck record, flagged, until part 3 resolves it.
- Photos and SMS sending come later; the crew page keeps its taps in the page's storage (and its page in a service worker on a secure address).
- Tests: `test/live-trips.test.js` (the LIVE suite: exact holds, each confirmation, custody, backdating, hire from confirmed times,
  ON_BEHALF, driver scope, idempotency, Today, the clock's flags, the invariant with trips in every state, the board),
  `test/live-orders-property.test.js` (1,000 random orders: requested = held = loaded = delivered, nothing negative, nothing lost),
  `test/crew-auth.test.js` (links, device sessions, scope and revoke through the HTTP server; 50+ offline/online switches with 0 lost or
  duplicated taps) and `e2e/live-trips-api.spec.js` (order, truck and driver, the phone's two taps, the board and hire, on the running server).
