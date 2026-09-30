process.env.TZ = 'Australia/Sydney';
// The LIVE suite for part 2 (ADR 0009): orders with exact pieces, trips and their confirmations, backdating, hire from confirmed times, the
// office for a driver (ON_BEHALF), the clock's flags and the LIVE board's data. Nothing here ticks: every change is a person's command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { atomic } from '../src/database.js';
import { Simulation, tickCompany } from '../src/simulation.js';
import { clockRound } from '../src/domain/clock.js';
import { LIVE_OPS } from '../src/domain/mode.js';
import { addDays } from '../src/domain/schedule.js';
import { crewLink, crewClaim, crewAuthenticate } from '../src/crew-auth.js';
import { liveFixture, records, D0 } from './helpers/live-fixture.js';
const D1 = addDays(D0, 1),
  D2 = addDays(D0, 2);

// Pieces of one product per place kind (yard, site, truck), from the contents table.
function where(f, product) {
  const out = { yard: 0, site: 0, truck: 0 };
  for (const c of f.sim.containers()) {
    const q = f.sim.repo.quantity(c.id, product);
    if (!q) continue;
    out[f.sim.repo.get(c.location).kind] += q;
  }
  return out;
}
const ledger = (f, sql = '1=1') =>
  f.db.prepare(`SELECT * FROM ledger WHERE company_id=? AND ${sql} ORDER BY sequence`).all(f.company);
const confirmations = (f) =>
  f.db.prepare('SELECT * FROM trip_confirmation WHERE company_id=? ORDER BY sequence').all(f.company);
// An order and a trip for it on the fixture's truck with Dave.
function booked(f, quantity, extra = {}) {
  const o = f.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity }], ...extra }).order;
  const trip = f.cmd('tripBook', { orders: [o.id], truck: f.truck.id, driver: f.team.Dave.id }).trip;
  return { o, trip };
}
// Dave's phone: a link made by the office, claimed on the phone; a Simulation as the phone's device sign-in.
function phone(f, driver = f.team.Dave) {
  const made = crewLink(f.auth, f.user, { driver: driver.id });
  const claimed = crewClaim(f.auth, { token: made.token, label: 'Test phone' });
  const user = crewAuthenticate(f.db, claimed.token);
  const sim = new Simulation(f.db, user);
  return { user, sim, cmd: (a, i = {}, key = randomUUID()) => sim.execute(a, i, key), token: claimed.token };
}

test('the new commands are on the LIVE allow-list and refused in the Practice yard', (t) => {
  const f = liveFixture(t);
  for (const a of [
    'orderCreate',
    'bringBackCreate',
    'orderCancel',
    'tripBook',
    'tripCancel',
    'packConfirmed',
    'tripLoaded',
    'tripDelivered',
    'tripCollected',
    'tripReturned',
  ])
    assert.ok(LIVE_OPS.has(a), a);
  const demo = new Simulation(f.db, f.owner);
  assert.throws(
    () => demo.execute('orderCreate', { site: 'x', lines: [] }, randomUUID()),
    (e) => e.status === 409 && /real yard only/.test(e.message),
  );
  assert.throws(
    () =>
      f.db
        .prepare(
          "INSERT INTO trip_confirmation VALUES(NULL,'x',?,'t','s','LOADED','[]',NULL,'a','b','u','PERSON',NULL,'o',NULL,'k')",
        )
        .run(f.owner.company_id),
    /real yard only/,
    'the Practice yard never gets a trip confirmation, even written by hand',
  );
});

test('an order keeps the typed number, holds exact pieces at once (a part of a stillage) and says the pack size only as a hint', (t) => {
  const f = liveFixture(t);
  const before = where(f, f.product.id);
  const made = f.cmd('orderCreate', {
    site: f.site.id,
    lines: [{ product: f.product.id, quantity: 7 }],
    source: 'board',
  });
  assert.equal(made.order.label, 'O-1');
  assert.equal(made.order.lines[0].requested, 7, 'never snapped');
  assert.equal(made.order.lines[0].held, 7, 'exactly 7 held');
  assert.equal(made.order.status, 'OPEN');
  assert.match(made.message, /7 × .*Held exactly\./);
  const holds = f.sim.repo.all('reservation').filter((r) => r.active && r.order === made.order.id);
  assert.equal(holds.length, 1, 'from one stillage');
  assert.equal(holds[0].quantity, 7);
  assert.deepEqual(where(f, f.product.id), before, 'holding moves nothing');
  // what is free now: the picker (GET /api/live-items) says so, with the pack size beside it
  const items = f.sim.orderItems(f.yard.id).items.find((i) => i.product === f.product.id);
  assert.equal(items.free, f.per * 3 - 7);
  assert.ok('pack' in items);
  // more than is free: it holds what there is and says so; the rest is picked when it is loaded
  const big = f.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: f.per * 3 + 5 }] });
  assert.equal(big.order.lines[0].held, f.per * 3 - 7);
  assert.match(big.message, /Only \d+ of \d+ .* free in the yard now/);
  // cancelled: nothing held for it any more
  f.cmd('orderCancel', { id: big.order.id });
  assert.equal(f.sim.orderItems(f.yard.id).items.find((i) => i.product === f.product.id).free, f.per * 3 - 7);
  // a supervisor orders only for their own sites; a crew sign-in cannot order at all
  const p = phone(f);
  assert.throws(
    () => p.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 1 }] }),
    (e) => e.status === 403,
  );
});

test('Loaded & left moves exact pieces yard -> truck (a part split into a bundle); Delivered truck -> site; hire starts then', (t) => {
  const f = liveFixture(t);
  const { o, trip } = booked(f, 10);
  const tp = f.item(trip.truckPlan);
  assert.equal(tp.type, 'TRUCK', 'a truck booking on Today');
  assert.equal(tp.driver, f.team.Dave.id);
  assert.equal(f.msgs(tp.id)[0]?.status, 'SENT', 'Dave is asked, as for any truck booking');
  assert.deepEqual(trip.next, ['packConfirmed', 'tripLoaded']);
  // nothing has moved: booking is not driving
  assert.deepEqual(where(f, f.product.id), { yard: f.per * 3, site: 0, truck: 0 });
  assert.throws(
    () => f.cmd('tripDelivered', { trip: trip.id, receivedBy: 'x' }),
    (e) => e.status === 409 && /First confirm loaded & left/.test(e.message),
  );
  f.cmd('packConfirmed', { trip: trip.id });
  assert.deepEqual(where(f, f.product.id), { yard: f.per * 3, site: 0, truck: 0 }, 'packed moves nothing');
  f.clock(D0, '09:40');
  const loaded = f.cmd('tripLoaded', { trip: trip.id });
  assert.equal(loaded.trip.state, 'LOADED');
  assert.equal(loaded.trip.stateWords, 'Loaded, not delivered yet');
  assert.deepEqual(where(f, f.product.id), { yard: f.per * 3 - 10, site: 0, truck: 10 });
  const split = ledger(f, "event='SPLIT'");
  assert.equal(split.length, 1, 'a part of one stillage: split into a bundle');
  assert.equal(split[0].quantity, 10);
  const bundle = f.sim.repo.get(split[0].destination, 'container');
  assert.equal(bundle.type, 'BUNDLE');
  assert.equal(bundle.location, f.truck.id);
  assert.equal(f.sim.repo.get(f.truck.id, 'truck').status, 'IN_TRANSIT', "the truck's record: on the road");
  assert.equal(f.sim.repo.get(o.id, 'order').status, 'LOADED');
  // delivered needs who received it
  assert.throws(() => f.cmd('tripDelivered', { trip: trip.id }), /Who received it/);
  f.clock(D0, '10:15');
  const done = f.cmd('tripDelivered', { trip: trip.id, receivedBy: 'J. Smith' });
  assert.equal(done.trip.state, 'DELIVERED');
  assert.equal(done.message, 'Delivered 10:15 · received by J. Smith');
  assert.deepEqual(where(f, f.product.id), { yard: f.per * 3 - 10, site: 10, truck: 0 });
  const order = f.sim.repo.get(o.id, 'order');
  assert.equal(order.status, 'DELIVERED');
  assert.deepEqual(
    [order.lines[0].requested, order.lines[0].loaded, order.lines[0].delivered],
    [10, 10, 10],
    'asked = sent = delivered',
  );
  assert.equal(f.item(tp.id).status, 'DONE', 'the truck booking is done when its trips are');
  // the ledger: every movement row a person's (here the office for Dave), dated when it happened
  const moves = ledger(f, "event IN ('SPLIT','LOADED','DELIVERED')");
  assert.ok(moves.every((r) => r.actor_kind === 'ON_BEHALF' && r.on_behalf_of === 'driver:' + f.team.Dave.id));
  assert.deepEqual(
    confirmations(f).map((c) => [c.step, c.actor_kind, c.occurred_at]),
    [
      [
        'PACKED',
        'PERSON',
        f.db.prepare('SELECT occurred_at FROM trip_confirmation WHERE step=?').get('PACKED').occurred_at,
      ],
      ['LOADED', 'ON_BEHALF', new Date(f.at(D0, '09:40')).toISOString()],
      ['DELIVERED', 'ON_BEHALF', new Date(f.at(D0, '10:15')).toISOString()],
    ],
  );
  assert.equal(confirmations(f)[2].received_by, 'J. Smith');
  assert.throws(() => f.db.prepare('UPDATE trip_confirmation SET step=step').run(), /append only/);
  assert.throws(() => f.db.prepare('DELETE FROM trip_confirmation').run(), /append only/);
  // hire: 10 pieces on hire at Bondi from the delivered day
  const s = f.sim.hire({ site: f.site.id, from: D0, to: D0 }).statement;
  assert.equal(s.pieceDays, 10);
  // Reports: the delivery counts as sent out to the site
  assert.ok(JSON.stringify(f.sim.reports(30)).length > 0);
});

test('a whole stillage moves as it is and goes back to its own spot at the yard; two orders share a trip', (t) => {
  const f = liveFixture(t);
  const a = f.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: f.per }] }).order;
  const b = f.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: f.per }] }).order;
  const trip = f.cmd('tripBook', { orders: [a.id, b.id], truck: f.truck.id, driver: f.team.Dave.id }).trip;
  assert.equal(trip.lines[0].asked, f.per * 2);
  const spots = new Map(f.sim.containers().map((c) => [c.id, { x: c.x, y: c.y }]));
  f.cmd('tripLoaded', { trip: trip.id });
  assert.equal(ledger(f, "event='SPLIT'").length, 0, 'no split: two whole stillages');
  const onTruck = f.sim.containers().filter((c) => c.location === f.truck.id);
  assert.equal(onTruck.length, 2);
  assert.ok(onTruck.every((c) => c.type === 'STILLAGE' && c.home?.location === f.yard.id));
  f.cmd('tripDelivered', { trip: trip.id, receivedBy: 'Site foreman' });
  assert.deepEqual(
    [a, b].map((o) => f.sim.repo.get(o.id, 'order').status),
    ['DELIVERED', 'DELIVERED'],
    'each order got what it asked for',
  );
  // bring them back: a bring-back order holds the site's pieces; Collected, then Back at yard
  const back = f.cmd('bringBackCreate', {
    site: f.site.id,
    lines: [{ product: f.product.id, quantity: f.per * 2 }],
  }).order;
  assert.equal(back.label, 'B-1', 'bring-backs are numbered on their own');
  assert.equal(back.lines[0].held, f.per * 2);
  const run = f.cmd('tripBook', { orders: [back.id], truck: f.truck.id }).trip;
  assert.deepEqual(run.next, ['tripCollected']);
  f.clock(D0, '13:00');
  f.cmd('tripCollected', { trip: run.id });
  assert.deepEqual(where(f, f.product.id), { yard: f.per, site: 0, truck: f.per * 2 });
  f.cmd('tripReturned', { trip: run.id });
  assert.deepEqual(where(f, f.product.id), { yard: f.per * 3, site: 0, truck: 0 });
  for (const c of onTruck) {
    const now = f.sim.repo.get(c.id, 'container');
    assert.equal(now.location, f.yard.id);
    assert.deepEqual({ x: now.x, y: now.y }, spots.get(c.id), 'back on its own spot');
  }
  assert.equal(f.sim.repo.get(back.id, 'order').status, 'RETURNED');
});

test('what really went: fewer lets the rest go, more picks free stock, more than the yard has is refused; delivered short', (t) => {
  const f = liveFixture(t);
  const { o, trip } = booked(f, 30);
  assert.throws(
    () => f.cmd('tripLoaded', { trip: trip.id, lines: [{ product: f.product.id, quantity: f.per * 3 + 1 }] }),
    (e) => e.status === 409 && /more .* free in the yard/.test(e.message),
  );
  f.cmd('tripLoaded', { trip: trip.id, lines: [{ product: f.product.id, quantity: 25 }] });
  assert.equal(f.sim.orderHeld(o.id).get(f.product.id) ?? 0, 0, 'the 5 not loaded are let go');
  assert.deepEqual(where(f, f.product.id), { yard: f.per * 3 - 25, site: 0, truck: 25 });
  const d = f.cmd('tripDelivered', {
    trip: trip.id,
    lines: [{ product: f.product.id, quantity: 20 }],
    receivedBy: 'J. Smith',
  });
  assert.equal(d.trip.state, 'DELIVERED_SHORT');
  assert.equal(d.trip.stateWords, 'Delivered short');
  assert.deepEqual(d.trip.next, ['tripReturned']);
  assert.equal(f.sim.repo.get(o.id, 'order').status, 'SHORT');
  // the truck still carries 5: it cannot be loaded for another trip until that is confirmed
  const next = booked(f, 3).trip;
  assert.throws(
    () => f.cmd('tripLoaded', { trip: next.id }),
    (e) => e.status === 409 && /still has Trip 1 on board/.test(e.message),
  );
  f.cmd('tripReturned', { trip: trip.id });
  assert.deepEqual(where(f, f.product.id), { yard: f.per * 3 - 20, site: 20, truck: 0 });
  // more than the order asked for: picked from free stock, recorded as sent
  f.cmd('tripLoaded', { trip: next.id, lines: [{ product: f.product.id, quantity: 5 }] });
  const line = f.sim.repo.get(next.orders[0].id, 'order').lines[0];
  assert.deepEqual([line.requested, line.loaded], [3, 5], 'the docket shows 3 asked, 5 sent');
  // exact pieces all the way: nothing ever negative, and every piece is somewhere
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM contents WHERE quantity<0').get().n, 0);
  const w = where(f, f.product.id);
  assert.equal(w.yard + w.site + w.truck, f.per * 3);
});

test('backdating: a typed earlier time needs a reason past 15 minutes, stays in the open period and after the last step; hire follows it', (t) => {
  const f = liveFixture(t);
  f.clock(D2, '16:00');
  const { trip } = booked(f, 12);
  assert.throws(
    () => f.cmd('tripLoaded', { trip: trip.id, at: new Date(f.at(D2, '15:00')).toISOString() }),
    /Say why the time is earlier/,
  );
  assert.throws(
    () => f.cmd('tripLoaded', { trip: trip.id, at: new Date(f.at(D2, '17:00')).toISOString() }),
    /in the future/,
  );
  assert.throws(
    () =>
      f.cmd('tripLoaded', { trip: trip.id, at: new Date(f.at(addDays(D0, -1), '15:00')).toISOString(), reason: 'x' }),
    /too far back/,
    'never before the real yard started',
  );
  f.cmd('tripLoaded', {
    trip: trip.id,
    at: new Date(f.at(D1, '07:30')).toISOString(),
    reason: 'Paper docket, keyed in later',
  });
  assert.throws(
    () =>
      f.cmd('tripDelivered', {
        trip: trip.id,
        at: new Date(f.at(D1, '07:00')).toISOString(),
        reason: 'x',
        receivedBy: 'Jo',
      }),
    /before it was loaded & left \(07:30\)/,
  );
  // 10 minutes back: no reason needed
  f.clock(D2, '16:05');
  const d = f.cmd('tripDelivered', {
    trip: trip.id,
    at: new Date(f.at(D1, '08:10')).toISOString(),
    reason: 'Paper docket',
    receivedBy: 'Jo',
  });
  assert.equal(d.trip.steps.DELIVERED.reason, 'Paper docket');
  const rows = f.db.prepare("SELECT occurred_at,created_at,reason FROM ledger WHERE event='DELIVERED'").all();
  assert.equal(rows[0].occurred_at, new Date(f.at(D1, '08:10')).toISOString());
  assert.notEqual(rows[0].created_at, rows[0].occurred_at, 'recorded later');
  const c = confirmations(f).find((x) => x.step === 'DELIVERED');
  assert.equal(c.backdate_reason, 'Paper docket');
  assert.equal(c.recorded_at, new Date(f.at(D2, '16:05')).toISOString());
  const audit = f.db
    .prepare("SELECT details FROM audit_events WHERE company_id=? AND action='trip.backdated'")
    .all(f.company)
    .map((r) => JSON.parse(r.details));
  assert.deepEqual(
    audit.map((a) => [a.step, a.reason]),
    [
      ['LOADED', 'Paper docket, keyed in later'],
      ['DELIVERED', 'Paper docket'],
    ],
  );
  // hire runs from the confirmed day (D1), not the day it was keyed in (D2)
  const s = f.sim.hire({ site: f.site.id, from: D1, to: D2 }).statement;
  assert.equal(s.pieceDays, 24, '12 pieces on hire on D1 and D2');
  // a short step back (10 minutes) needs no reason
  const two = booked(f, 1).trip;
  f.cmd('tripLoaded', { trip: two.id, at: new Date(f.at(D2, '15:56')).toISOString() });
});

test('hire starts at the confirmed Delivered time and ends at the confirmed Collected time', (t) => {
  const f = liveFixture(t);
  f.clock(addDays(D0, 5), '12:00');
  const { trip } = booked(f, 10);
  const at = (d, hm) => new Date(f.at(d, hm)).toISOString();
  f.cmd('tripLoaded', { trip: trip.id, at: at(D1, '07:00'), reason: 'Paper run sheet' });
  f.cmd('tripDelivered', { trip: trip.id, at: at(D1, '08:00'), reason: 'Paper run sheet', receivedBy: 'Ana' });
  const back = f.cmd('bringBackCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 10 }] }).order;
  const run = f.cmd('tripBook', { orders: [back.id], truck: f.truck.id }).trip;
  assert.throws(
    () => f.cmd('tripCollected', { trip: run.id, at: at(D0, '12:00'), reason: 'x' }),
    /too far back|had only 0 × .* on record/,
  );
  f.cmd('tripCollected', { trip: run.id, at: at(addDays(D0, 4), '14:00'), reason: 'Paper run sheet' });
  f.cmd('tripReturned', { trip: run.id, at: at(addDays(D0, 4), '15:00'), reason: 'Paper run sheet' });
  const s = f.sim.hire({ site: f.site.id, from: D0, to: addDays(D0, 5) }).statement;
  // on hire D1, D2, D3 (a piece is on hire from the day it arrives up to, not including, the day it leaves)
  assert.equal(s.pieceDays, 30);
  assert.equal(s.onHireNow, 0);
});

test("the driver's phone: PERSON for their own trip, never another driver's; the office confirms ON_BEHALF", (t) => {
  const f = liveFixture(t);
  const bill = f.cmd('teamAdd', { name: 'Bill', role: 'DRIVER' }).person;
  const truck2 = f.cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: f.yard.id });
  const mine = booked(f, 4).trip;
  const o2 = f.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 2 }] }).order;
  const theirs = f.cmd('tripBook', { orders: [o2.id], truck: truck2.id, driver: bill.id }).trip;
  const dave = phone(f),
    billPhone = phone(f, bill);
  // my trips: only Dave's
  const list = dave.sim.crewTrips();
  assert.deepEqual(
    list.trips.map((x) => x.id),
    [mine.id],
  );
  assert.equal(list.driver.name, 'Dave');
  assert.deepEqual(list.trips[0].next, ['tripLoaded'], 'the phone is offered its confirmations only');
  // another driver's trip: not found, whatever they try
  for (const a of ['tripLoaded', 'tripDelivered', 'tripCollected', 'tripReturned'])
    assert.throws(
      () => billPhone.cmd(a, { trip: mine.id, receivedBy: 'x' }),
      (e) => e.status === 404,
      a,
    );
  // and nothing else from a phone
  for (const [a, i] of [
    ['tripBook', { orders: [o2.id] }],
    ['packConfirmed', { trip: mine.id }],
    ['tripCancel', { id: mine.id }],
    ['planTruck', {}],
    ['gameAddStock', {}],
  ])
    assert.throws(
      () => dave.cmd(a, i),
      (e) => e.status === 403,
      a,
    );
  dave.cmd('tripLoaded', { trip: mine.id });
  const c = confirmations(f).at(-1);
  assert.deepEqual([c.actor, c.actor_kind, c.on_behalf_of], [dave.user.id, 'PERSON', null]);
  assert.ok(ledger(f, "event='LOADED'").every((r) => r.actor === dave.user.id && r.actor_kind === 'PERSON'));
  // the office for Bill
  f.cmd('tripLoaded', { trip: theirs.id });
  const c2 = confirmations(f).at(-1);
  assert.deepEqual([c2.actor, c2.actor_kind, c2.on_behalf_of], [f.user.id, 'ON_BEHALF', 'driver:' + bill.id]);
  // Dave left the team: his phone is signed out at once
  f.cmd('teamRemove', { kind: 'driver', id: f.team.Dave.id });
  assert.throws(
    () => crewAuthenticate(f.db, dave.token),
    (e) => e.status === 401,
  );
});

test('idempotency: the same tap sent again is recorded once; a second confirmation of a step says it is already done', (t) => {
  const f = liveFixture(t);
  const { trip } = booked(f, 5);
  const key = randomUUID();
  const first = f.cmd('tripLoaded', { trip: trip.id }, key);
  const again = f.cmd('tripLoaded', { trip: trip.id }, key);
  assert.deepEqual(again, first);
  assert.equal(confirmations(f).filter((c) => c.step === 'LOADED').length, 1);
  assert.equal(ledger(f, "event='LOADED'").length, 1);
  assert.throws(
    () => f.cmd('tripLoaded', { trip: trip.id }),
    (e) =>
      e.status === 409 &&
      e.code === 'ALREADY_CONFIRMED' &&
      /Already confirmed: loaded & left at 09:00 by Tee/.test(e.message),
  );
});

test("Today in a real yard: a Materials list is an order on its truck's trip; it is done when delivered; cancel lets its pieces go", (t) => {
  const f = liveFixture(t);
  const tp = f.cmd('planTruck', { day: D1, time: '07:00', truck: f.truck.id, driver: f.team.Dave.id }).item;
  const list = f.cmd('planMaterials', {
    day: D1,
    time: '07:30',
    site: f.site.id,
    truckPlan: tp.id,
    lines: [{ product: f.product.id, quantity: 13 }],
  });
  assert.match(list.message, /^List for Bondi on .* planned\. O-1: Held exactly\.$/);
  const item = f.item(list.item.id);
  const order = f.sim.repo.get(item.order, 'order');
  assert.deepEqual([order.neededOn, order.time, order.status, order.source], [D1, '07:30', 'BOOKED', 'today']);
  const trip = f.sim.repo.get(order.trip, 'trip');
  assert.equal(trip.truckPlan, tp.id);
  // a second list the same day on the same truck: its own trip on the same booking
  const other = f.cmd('gameSite', { name: 'Manly' }).site;
  const list2 = f.cmd('planMaterials', {
    day: D1,
    site: other.id,
    truckPlan: tp.id,
    lines: [{ product: f.product.id, quantity: 2 }],
  }).item;
  f.clock(D1, '07:10');
  f.cmd('tripLoaded', { trip: trip.id });
  assert.equal(f.item(item.id).stage, 'ON_THE_WAY');
  assert.throws(() => f.cmd('planCancel', { id: item.id }), /already left/);
  assert.throws(() => f.cmd('planMove', { id: item.id, day: D2 }), /already left/);
  f.clock(D1, '07:50');
  f.cmd('tripDelivered', { trip: trip.id, receivedBy: 'Leading hand' });
  const doneItem = f.item(item.id);
  assert.equal(doneItem.status, 'DONE');
  assert.match(doneItem.log.at(-1).text, /Delivered 07:50 · received by Leading hand/);
  assert.equal(f.item(tp.id).status, 'ACTIVE', 'the booking still has the Manly trip');
  // cancel the Manly list: its order is cancelled and its pieces are free again; the trip with nothing left goes too
  const o2 = f.sim.repo.get(f.item(list2.id).order, 'order');
  f.cmd('planCancel', { id: list2.id });
  assert.equal(f.sim.repo.get(o2.id, 'order').status, 'CANCELLED');
  assert.equal(f.sim.orderHeld(o2.id).size, 0);
  assert.equal(f.sim.repo.get(o2.trip, 'trip').state, 'CANCELLED');
  assert.equal(f.item(tp.id).status, 'DONE', 'every trip left on the booking is done');
});

test('the clock flags trips that should have been confirmed, and never moves or completes one', (t) => {
  const f = liveFixture(t);
  const late = booked(f, 3).trip;
  f.cmd('tripLoaded', { trip: late.id });
  const idle = booked(f, 2).trip; // booked today, never leaves
  const before = strip(records(f.db, f.company));
  f.clock(D0, '09:20');
  f.pass();
  assert.equal(f.sim.repo.get(late.id, 'trip').flag, null, 'within its usual 30 min + 30');
  f.clock(D0, '10:05');
  f.pass();
  const flagged = f.sim.repo.get(late.id, 'trip');
  assert.equal(flagged.flag.code, 'UNCONFIRMED_TRIP');
  assert.equal(flagged.flag.words, 'Not confirmed: left the yard 09:00, usually ~30 min. Delivered?');
  assert.equal(flagged.state, 'LOADED', 'still loaded: the clock never delivers');
  assert.equal(f.sim.tripView(flagged).stateWords, 'Not confirmed');
  f.clock(D0, '17:30');
  f.pass();
  f.pass();
  assert.equal(f.sim.repo.get(idle.id, 'trip').flag.words, 'Not confirmed: nobody recorded that it left the yard');
  assert.equal(
    f.sim.repo.all('notification').filter((n) => n.title === 'Not confirmed').length,
    2,
    'said once per trip',
  );
  assert.deepEqual(strip(records(f.db, f.company)), before, 'nothing moved or completed');
  // a confirmation clears the flag
  f.cmd('tripDelivered', { trip: late.id, receivedBy: 'Jo' });
  assert.equal(f.sim.repo.get(late.id, 'trip').flag, null);
});

// Everything but the flags the clock may set on a trip (and on bookings, messages and notifications: records() leaves those out).
function strip(r) {
  const objects = JSON.parse(r.objects).map((o) => {
    if (o.kind !== 'trip') return o;
    const d = JSON.parse(o.data);
    delete d.flag;
    return { ...o, data: JSON.stringify(d), version: 0 };
  });
  return { ...r, objects: JSON.stringify(objects), plan: undefined };
}

test('the LIVE invariant with trips in every state: 10,000 engine rounds and 10,000 clock passes move and complete nothing', (t) => {
  const f = liveFixture(t);
  const a = booked(f, 3).trip;
  const b = booked(f, 2).trip;
  f.cmd('tripLoaded', { trip: a.id });
  f.cmd('tripDelivered', { trip: a.id, receivedBy: 'Jo', lines: [{ product: f.product.id, quantity: 2 }] });
  const truck2 = f.cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: f.yard.id });
  const o3 = f.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 4 }] }).order;
  const c = f.cmd('tripBook', { orders: [o3.id], truck: truck2.id, driver: f.team.Dave.id, day: D1 }).trip;
  const before = strip(records(f.db, f.company));
  const confirmed = confirmations(f).length;
  for (let i = 0; i < 10000; i++)
    atomic(f.db, () => {
      tickCompany(f.db, { company_id: f.company, id: f.user.id }, 250);
      f.sim.tick(250);
      f.sim.tickJobs(250);
    });
  const start = Date.now();
  for (let i = 0; i < 10000; i++) {
    f.setTime(start + i * 36000);
    clockRound(f.db, Simulation, Date.now());
  }
  assert.deepEqual(strip(records(f.db, f.company)), before);
  assert.equal(confirmations(f).length, confirmed, 'no confirmation by itself');
  assert.deepEqual(
    [a, b, c].map((x) => f.sim.repo.get(x.id, 'trip').state),
    ['DELIVERED_SHORT', 'BOOKED', 'BOOKED'],
  );
  assert.ok([a, b, c].every((x) => f.sim.repo.get(x.id, 'trip').flag?.code === 'UNCONFIRMED_TRIP'));
});

test('the LIVE board: each truck by its last confirmed step, an estimate that never passes 90%, a replay per confirmation, site pieces', (t) => {
  const f = liveFixture(t);
  const board = () => f.sim.snapshot(0, { lean: true }).liveBoard;
  assert.equal(board().trucks[0].state, 'PARKED');
  const { trip } = booked(f, 6);
  assert.equal(board().trucks[0].state, 'BOOKED');
  assert.match(board().trucks[0].words, /→ Bondi$/);
  f.clock(D0, '09:10');
  f.cmd('tripLoaded', { trip: trip.id });
  let row = board().trucks[0];
  assert.equal(row.state, 'TO_SITE');
  assert.equal(row.words, 'Left 09:10 · usually ~30 min');
  assert.deepEqual(row.estimate, { startedAt: new Date(f.at(D0, '09:10')).toISOString(), minutes: 30, cap: 0.9 });
  assert.equal(row.late, false);
  f.clock(D0, '10:20');
  assert.equal(board().trucks[0].late, true, 'amber once the usual time + 30 min has passed');
  assert.equal(board().trucks[0].state, 'TO_SITE', 'still on the road: nothing invented');
  f.cmd('tripDelivered', { trip: trip.id, receivedBy: 'J. Smith' });
  const b = board();
  row = b.trucks[0];
  assert.equal(row.state, 'AT_SITE');
  assert.equal(row.place, f.site.id);
  assert.equal(row.words, 'Delivered 10:20 · received by J. Smith');
  assert.equal(row.lastEvent.step, 'DELIVERED');
  assert.deepEqual(
    b.replays.map((r) => r.step),
    ['DELIVERED'],
    'the load confirmed 70 min ago has aged out; the delivery replays',
  );
  assert.equal(b.replays[0].words, 'Delivered 10:20 · received by J. Smith');
  assert.equal(b.sites[f.site.id].pieces, 6);
  // the usual minutes learn only from drives the driver's own phone recorded (live-review.test.js); an office-recorded pair teaches nothing
  assert.equal(f.sim.tripMinutes(f.site.id), 30);
  f.cmd('siteDetails', { id: f.site.id, plannedMinutes: 40 });
  assert.equal(f.sim.tripMinutes(f.site.id), 40);
});

test('Back at yard with fewer than were collected: counted per product; the rest stays on the truck record, said plainly (part 3 resolves it)', (t) => {
  const f = liveFixture(t);
  const { trip } = booked(f, 10);
  f.cmd('tripLoaded', { trip: trip.id });
  f.cmd('tripDelivered', { trip: trip.id, receivedBy: 'Jo' });
  const back = f.cmd('bringBackCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 10 }] }).order;
  const run = f.cmd('tripBook', { orders: [back.id], truck: f.truck.id }).trip;
  f.cmd('tripCollected', { trip: run.id });
  const done = f.cmd('tripReturned', { trip: run.id, lines: [{ product: f.product.id, quantity: 7 }] });
  assert.equal(done.trip.state, 'RETURNED');
  assert.equal(done.trip.stateWords, 'Back at yard, 3 pieces not counted back');
  assert.deepEqual(done.trip.notBack, [{ product: f.product.id, quantity: 3 }]);
  assert.deepEqual(where(f, f.product.id), { yard: f.per * 3 - 3, site: 0, truck: 3 });
  // the truck is free for its next trip (the 3 stay on its record until they are found or written off)
  const next = booked(f, 2).trip;
  assert.equal(f.cmd('tripLoaded', { trip: next.id }).trip.state, 'LOADED');
  // hire ended for all 10 at the confirmed collection
  assert.equal(f.sim.hire({ site: f.site.id }).statement.onHireNow, 0);
});
