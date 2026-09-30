# 0010. Today as LIVE dispatch, returns counted and resolved, "Needs you" (Phase 1A, part 3)

- Status: Accepted, 30 September 2026 (Phase 1A part 3 of 4). Builds audit §12 #33 (Today as a LIVE dispatch tool), §11 #4 with H3
  (count what comes back, charge for what doesn't, replacement value and purchase cost), H5/#17 v1 ("Needs you") and §7.3 (the Dispatch
  lanes view of Today). Rests on [0008](0008-live-foundation.md) and [0009](0009-record-reality.md). A real yard only: the Practice yard
  and its ticking suite are unchanged.

## Context

After part 2 a real yard records trips people confirm, but Today still means what the simulation meant by it: a booking that carries
itself out. The owner needs a booking to be an instruction that waits for people (the driver's own yes, the yard's pack, the leading
hand's sign-on), a day he can move when it rains, one place that shows what has not been confirmed, and a count at the gate that ends
with someone deciding what happened to every missing piece. Nothing here may move, answer or complete by itself.

## Decision

**One rule for every state change in LIVE.** A Today item, a trip, a return or a site changes state only from (a) a person's own
confirmation on their phone (a CREW or YARD device sign-in, provenance `PERSON`), or (b) an office entry recorded for them (`ON_BEHALF`).
The business clock sends, reminds and flags; it never sets a stage that means "done", "packed", "on site" or "answered". The LIVE Today
suite proves it: 10,000 clock passes over a booked day leave every record as booked, answer nothing, pack nothing, load nothing and move
nobody (`test/live-dispatch.test.js`, on top of the invariant of 0008).

**Bookings that wait for people (#33).** The four kinds, their calendar and their look stay. In a real yard:

- `TRUCK`: Booked → Asked (the clock sends the ask) → Yes: the driver's own answer from the phone (`messageAnswer` over `/api/crew/…`,
  scope: their own asks only, `via: 'PHONE'`) or the office's, recorded `ON_BEHALF` (`via: 'OFFICE'`, as before). **No trip leaves
  without a named driver**: `tripLoaded` / `tripCollected` refuse a booking with no driver. "Next free truck" is only a suggestion the
  dispatch view makes for an order waiting (`suggestedTruck`); nothing picks a truck by itself.
- `MATERIALS`: the order of 0009 on a booked truck at a planned time. The yard confirms `packConfirmed` with counts from a yard-hand phone
  (a worker's device sign-in with the new `YARD` role, or the office); the driver confirms Loaded & left and Delivered as in 0009.
- `WORKERS`: each person answers their own ask on their phone (a worker's device sign-in, `CREW`), or the office answers for them.
  Arrival is a tap: `crewSignOn` by a leading hand on that booking (from their phone) or the office (`ON_BEHALF`), never the clock. A day
  is closed by `planDone` (the leading hand or the office); the clock flags a day nobody closed as "Not confirmed".
- `RESTACK`: a dated yard task in a real yard. Nobody is asked; `planDone` (a yard hand's phone or the office) marks it done; the clock
  flags one that was never tapped.
- `DRAFT`: any item may be booked with `draft: true` (`status: 'DRAFT'`): planned, on the calendar, holding the truck's slot, sent to
  nobody, no order made and nothing held. `planSend` makes it a booking (the asks go out then; a Materials draft makes its order then).
  A draft can be moved, cancelled or sent; the clock and the phones never see it.
- **One booking model.** The Schedule page in a real yard is a view of the same Today items (`GET /api/plan`); the old yard lists,
  requests and collections stay the Practice yard's (their commands are not on the allow-list).
- **Move the day** (`planMoveDay {from, to}`): every open item of one day (drafts, planned, active and missed) to another day in one
  command; the whole command fails if one item cannot move (a truck already booked that day, a person already at another site, a trip
  that has left). Lists stay on their trucks: a list whose truck booking moved with it is booked onto it again on the new day.
- **Copy yesterday's crews** (`planCopyCrews {from, to}`): every Workers booking of one day (with its people, site, time and count) made
  again on another day; all or nothing, in the words of the person who clashes.
- **The run sheet**: `GET /api/run-sheet?day=&driver=` for the office (one printed page: the driver, the truck, the trips in order with
  site, address, contact, what to load and who received it); the driver's phone has the same in `GET /api/crew/me`. No new Office page.
- **The Dispatch lanes view** (`GET /api/dispatch?day=`): one lane per truck booked that day with its driver's answer and each trip's
  state dot, `BOOKED`, `ASKED`, `YES`, `PACKED`, `LOADED`, `DELIVERED`, `BACK`, derived from the records only; lanes with something
  unconfirmed first; orders waiting for a truck with a suggested truck; the day's people (drivers by answer, workers by site with who has
  signed on, the yard's lists to pack and the re-stack). It is a view of Today and replaces the Control room in a real yard (§7.3).

**Back & counted, with a resolution for every shortfall (#4, H3).** `tripReturned` counts per product (0009); what did not come back
stays on the trip as `notBack`. `countLater: true` records Back at yard with nothing counted (`countPending`) and `returnCount` counts
later from the yard-hand phone or the office. Then `returnResolve {trip, lines: [{product, quantity, outcome, reason?}]}` gives every
missing piece exactly one outcome:

- `STILL_ON_SITE`: the pieces go back on the site's record (ledger `STILL_ON_SITE`, truck → site, from the container they were collected
  in, so hire reopens the same lots and **continues** without a gap);
- `LOST`: the pieces leave the records (ledger `LOST`) and a **charge line** is written at the product's replacement value;
- `DAMAGED`: the pieces go to the yard's **quarantine** container (ledger `DAMAGED`, condition `QUARANTINED`, `quarantine: true`), which
  no order, pick or top-up ever takes from (`tripStockAt` takes serviceable containers only); later `quarantineResolve` repairs them
  (back to serviceable stock), scraps them (ledger `SCRAPPED`) or charges them (`SCRAPPED` plus a charge line);
- `OUR_LOSS`: written off (ledger `WRITTEN_OFF`), needs an approver: `company.manage` (the owner).

`returnResolve` processes `STILL_ON_SITE` lines first (hire's transit record is per container: once a loss settles it, nothing later can
reopen it). A trip's flag `RETURN_SHORT` is set by the clock when a return is still uncounted or unresolved at the end of its company
day (5 pm; a return after 5 pm has until the next day's end), said once as a notification, and cleared by the count or the resolution.

**One site-finish question.** `siteFinish {site, outcome, reason?}`: "sent N · back M · K missing: charge, write off or still looking?"
(`siteAccount` gives N, M and K from the records: N = delivered there, M = counted back or quarantined from there, K = still on the
site's record plus unresolved trip shortfalls from there). `CHARGE` writes `LOST` rows and charge lines for the K pieces and archives the
site; `WRITE_OFF` writes `WRITTEN_OFF` rows (approver: the owner) and archives; `STILL_LOOKING` keeps the site open with `looking`
(a `RETURN_SHORT` item on Needs you). At a closed site, sent − back − on site − charged − written off = 0, by construction and by test.
Remove site in a real yard points at this question when scaffolding is still on record there.

**Money records.** `replacementValue` (cents ex GST) per product is company product settings (`productValue`, owner only:
`company.manage`; one product or a bulk list, the CSV column of the Materials catalogue), carried on the effective product. Add stock in a
real yard keeps an `intake` record per line: `unitCost`, `supplier`, `reference`, `receivedOn`. Charge lines are the append-only table
`charge_lines` (migration 009, refused for a DEMO company): `{id, company_id, site_id, customer_id (null until part 4), product_id,
quantity, unit_value, amount, reason (LOST | DAMAGED | SITE_FINISH), source (trip, container or site id), occurred_at, recorded_at, actor,
approved_by, command_key}`. Part 4's statements pick them up by site and period; `chargeLines(site)` reads them now. A product with no
replacement value can still be charged at 0 with `unitValue` typed on the line (the owner's call), never silently.

**One definition of "available"** (`src/domain/stock-math.js availableOf`): quantity − reserved − unserviceable, clamped at zero. The
Materials register, the stock-by-location blocks, the minimum-stock rule and the Overview all use it, so a damaged stillage shows the same
number everywhere (the audit's 416 versus 415).

**"Needs you" v1 (H5/#17).** `needsYou()` (`src/domain/needs.js`) is deterministic rules over LIVE records only, each item with one
action: `UNCONFIRMED_TRIP` (a trip the clock flagged), `RETURN_SHORT` (an uncounted or unresolved return, or a site still looking),
`NO_DRIVER_YES` (a truck booked tomorrow whose driver has not said yes by 5 pm today), `CLASH` (a truck, a driver or a person booked
twice on one day), the clock's booking flags (`NOT_ASKED`, `NO_ANSWER`, `CANT_MAKE_IT`, `NOT_CONFIRMED`), `PAPERWORK` (expired or due for
review) and `UNPRICED_ON_HIRE` (a product on hire with no rate). Ranked in that order, **at most 5 shown** (`count` says how many there
are); `needsYouDismiss {id, reason}` hides one item with a reason (kind `needsDismissal`), and an item's id changes when its fact changes,
so a dismissed one comes back only when something new happens. The snapshot carries it as `result.needsYou` (the board's one chip) and
`GET /api/needs-you` serves the Today card; nothing else in a real yard shows alert strips.

**Phones.** The crew link mechanism of 0009 now links any person on the team (`crewLink {person}`; `driver` still accepted): a driver's
sign-in has the `CREW` role (`trips.confirm`, `asks.answer`); a worker's has `CREW` (`asks.answer`) and, for a yardsman, `YARD`
(`packs.confirm`), kept in step when their role changes. `/api/crew/commands/<action>` takes the phone ops (`CREW_PHONE_OPS`): the trip
confirmations, `packConfirmed`, `returnCount`, `messageAnswer`, `messageSeen`, `crewSignOn` and `planDone`; every one is scoped in the
command to the person's own asks, bookings and yard. `GET /api/crew/me` returns their trips (a driver), their open asks with I'll be
there / Can't make it, the lists to pack and returns to count (a yardsman), the gang to sign on (a leading hand) and the re-stack (yard).

## Consequences

- New commands, all LIVE only and on the allow-list: `planSend`, `planDone`, `planMoveDay`, `planCopyCrews`, `crewSignOn`,
  `planRestack` (now allowed in LIVE, as a task), `returnCount`, `returnResolve`, `quarantineResolve`, `siteFinish`, `productValue`,
  `needsYouDismiss`. Permissions: office commands need `operations.manage`; `packConfirmed` and `returnCount` need `packs.confirm`
  (owners, general managers, `YARD`); answers, sign-on and done from a phone need `asks.answer`; `OUR_LOSS`, `WRITE_OFF` and
  `productValue` need `company.manage`.
- Views: `GET /api/dispatch`, `GET /api/run-sheet`, `GET /api/needs-you`; `snapshot.needsYou`; `tripsView` orders carry
  `suggestedTruck`; `trip.notBack`, `countPending`, `resolutions`, `count`; `site.looking`; `product.replacementValue`.
- Hire (`hire.js`) reads the new ledger events: `STILL_ON_SITE`, `DAMAGED` and `RETURNED`-by-count as moves; `LOST`, `WRITTEN_OFF` and
  `SCRAPPED` as removals (no minimum-hire top-up).
- The Practice yard is untouched: every command here is `requireLive`; `DRAFT` cannot be made there; the DEMO suite is unchanged.
- Screens (no new Office page, §13.7): Today in a real yard carries the Needs-you card and the day's tools at the top (Day / Dispatch
  lanes, Move the day, Copy yesterday's crews, Print run sheets), a Draft toggle on the four booking forms, Send on a draft, On site
  and Day done on a Workers booking, Done on a re-stack (`public/live-today.js`, loaded beside `live-office.js`); the lanes view
  replaces the calendar and day panel in place; the run sheet prints from the page (one sheet per driver). The Schedule and Control
  room tiles of a real yard both mean Today. Back & counted lives on the trip card: Back, count later; Count it now; Sort it out with
  the four outcomes (`public/live-returns.js`); the Stock page gets a Quarantine card, the Materials catalogue the owner's Replacement
  values (with a paste from a spreadsheet), the board's Add stock the intake fields, Client sites the one finish question in place of
  Remove site where scaffolding is on record; the board's top bar the one chip "Needs you · N". The phone page (`public/crew.js`)
  shows a person's own asks with I'll be there / Can't make it (a reason in one tap), the yard hand's lists to pack (Packed, with
  counts), returns to count and the re-stack (Done), the leading hand's gang (On site, Day done), each tap queued with its own key.
- Tests: `test/live-dispatch.test.js` (the LIVE Today suite: never ticks; draft never sends; the driver's own yes; no driverless trip;
  sign-on never automatic; Move the day all-or-nothing for 10 items; Copy yesterday; run sheet; dispatch lanes; 0 state changes from the
  clock), `test/live-returns.test.js` (count later, every shortfall one outcome, LOST at replacement value, DAMAGED quarantined and never
  picked, hire continues for STILL_ON_SITE, the site-finish question and 0 unaccounted at a closed site, one "available", intake and
  owner-only values), `test/live-needs.test.js` (each rule, the cap, dismissal, permissions), and the e2e specs the UI builder writes.

## Review (30 September 2026): what the records review and the first-timer walkthrough changed

- **Hire settles by the piece.** A load's transit record (`hire.js`) is per container and product with the pieces still on the truck under
  each tag, and follows a `SPLIT` row (pieces moved between containers on the truck). A partial return settles only what came back
  (collected, with its minimum-hire top-up), a loss (`LOST`, `WRITTEN_OFF`, `SCRAPPED`) removes only what was lost (never a top-up), and
  `STILL_ON_SITE` reopens the same lots from the container they were collected in, in one command or in separate commands days apart.
- **The site account stays whole.** `siteFinish WRITE_OFF` records only the site's own pieces in `finish.writtenOffSite` (trip shortfalls
  are on their trips' resolutions, counted once); a send that came back short and was resolved counts its resolved pieces as sent
  (`STILL_ON_SITE` on a send is "delivered after all": the order's delivered line moves and hire runs from the delivery day); what is
  still unresolved on a send is the trip's, not the site's. `siteAccount.summary` says an active site's numbers as they are ("on site
  (hire running)"), and the finish question is asked only when someone taps *Finish this site…* (or the site is already still looking).
- **Quarantine is not a stillage.** `condition`, `scrapContainer` and `retire` refuse the quarantine container; `tripStockAt` never picks
  from it whatever its condition says; a `quarantineResolve CHARGED` charges each lot's own site (a site named on the tap must be one of them).
- **Money is the owner's.** A value typed on a line (`unitValue`, `unitValues`) needs `company.manage` and is recorded as `approved_by`;
  anyone else gets the product's replacement value or a refusal that names the Materials catalogue.
- **Needs you says the fact.** A `RETURN_SHORT` item's id carries its state (not counted, or how many missing), and `returnCount` /
  `returnResolve` rewrite the flag's words and `since` when pieces are still missing, so a dismissal made while it was "not counted" lapses
  when the count comes up short. One item per booking: the clock's own flag (can't make it, no answer, not asked) wins over `NO_DRIVER_YES`,
  which also waits an hour after an ask sent after 5 pm. No alert bell, strip or drawer in a real yard; the Who's-in and Paperwork cards
  carry no red or amber strips (the one card and the one chip say it).
- **Dispatch.** The yard's PACKED count is on every line (`lines[].packed`) and is what everything downstream starts from: the driver's
  Loaded & left, the office docket's Sent column, the lanes' piece count and the run sheet (asked beside it when different). PACKED keeps
  a truck booking planned (still in the yard), so *Move the day* moves a packed day (rain at 6 am included: a real yard's booking moves
  while nothing has left on it) and says packed lists pack again. The office's PACKED entry is `ON_BEHALF` of the list's packer. A
  driver's "can't make it" puts the lane first before the day starts. A fully held list is never "short" of itself. The phones show
  tomorrow's re-stack and gang read-only (taps on the day), and a driver's packed trip stays under Tomorrow. The Today picker in a real
  yard keeps the number typed and a tap adds one piece (exact orders, ADR 0009).
- **Stock.** The register's *Free in yard* is `availableOf` applied to the yard's own rows (pieces at sites are on hire, not available);
  the board's "free to send" is the same number. Add stock keeps a cost per line and writes the supplier, invoice and cost each on the
  ledger row people read.
- Tests: `test/live-review3.test.js` pins each of these.
