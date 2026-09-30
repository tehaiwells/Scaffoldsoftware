process.env.TZ = 'Australia/Sydney';
// Gear lists in a real yard (ADR 0011, the LIVE suite: it never ticks). One tap makes the list, its exact order, the truck booking and the
// trip; the driver is asked to be ready at 3 pm company time the day before (Perth on a Sydney server too) and answers on his own phone;
// then the chain: Arrived at yard, Packed, Loaded & left, Arrived at Bondi, Landed, each a person's tap (or the office's ON_BEHALF), the
// arrivals light (no stock, no ledger row, an append-only trip_arrival row); the clock only asks and flags, under 10,000 passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Simulation } from '../src/simulation.js';
import { addDays } from '../src/domain/schedule.js';
import { zoneAt } from '../src/domain/zonetime.js';
import { crewLink, crewClaim, crewAuthenticate } from '../src/crew-auth.js';
import { liveFixture, records, D0 } from './helpers/live-fixture.js';
const D1 = addDays(D0, 1),
  D2 = addDays(D0, 2);
const list = (f, extra = {}) =>
  f.cmd('gearListCreate', {
    from: { kind: 'yard' },
    to: { kind: 'site', id: f.site.id },
    lines: [{ product: f.product.id, quantity: 7 }],
    day: D1,
    time: '07:00',
    truck: f.truck.id,
    driver: f.team.Dave.id,
    ...extra,
  });
function phone(f, person = f.team.Dave) {
  const made = crewLink(f.auth, f.user, { person: person.id });
  const claimed = crewClaim(f.auth, { token: made.token, label: 'Test phone' });
  const user = crewAuthenticate(f.db, claimed.token);
  const sim = new Simulation(f.db, user);
  return { user, sim, cmd: (a, i = {}, key = randomUUID()) => sim.execute(a, i, key), me: () => sim.crewMe() };
}
const arrivals = (f) => f.db.prepare('SELECT * FROM trip_arrival WHERE company_id=? ORDER BY sequence').all(f.company);
const tripOf = (f, r) => f.sim.repo.get(f.sim.repo.get(f.item(r.item.id).order, 'order').trip, 'trip');

test('one tap: the list, its exact order (held), the truck booking (driver asked) and the trip to the site; on the calendar at once', (t) => {
  const f = liveFixture(t);
  const r = list(f);
  assert.equal(r.item.name, 'Bondi gear');
  assert.equal(r.item.direction, 'OUT');
  assert.equal(r.item.order, 'O-1');
  assert.match(r.message, /^Bondi gear on Wed 14 Oct at 7:00 am\. T-01 with Dave booked\. O-1: Held exactly\.$/);
  const it = f.item(r.item.id);
  assert.equal(it.gear, true);
  const o = f.sim.repo.get(it.order, 'order');
  assert.equal(o.direction, 'OUT');
  assert.equal(f.sim.orderHeld(o.id).get(f.product.id), 7, 'held exactly');
  const trip = f.sim.repo.get(o.trip, 'trip');
  assert.equal(trip.state, 'BOOKED');
  assert.equal(trip.truckPlan, it.truckPlan);
  const tp = f.item(it.truckPlan);
  assert.equal(tp.driver, f.team.Dave.id);
  assert.equal(f.msgs(tp.id)[0].subject, 'DRIVE', 'the driver is asked to drive, as for any booking');
  assert.equal(r.truckItem.id, tp.id);
  // the calendar: the chip with its time and arrow, the chain of empty dots, the truck and driver
  const month = f.sim.planMonth(D1.slice(0, 7)).items.find((i) => i.id === it.id);
  assert.equal(month.name, 'Bondi gear');
  assert.deepEqual(
    month.chain.map((c) => [c.words, c.done]),
    [
      ['Arrived at yard', false],
      ['Packed', false],
      ['Loaded', false],
      ['Arrived at Bondi', false],
      ['Landed', false],
    ],
  );
  assert.equal(month.truckItem.driverName, 'Dave');
  assert.equal(month.truckItem.driverAnswer, 'WAITING');
  // GET /api/gear: the day's lists; a week from today for the Gear list page
  const g = f.sim.gearView({ day: D1 });
  assert.equal(g.lists.length, 1);
  assert.equal(g.lists[0].id, it.id);
  assert.equal(f.sim.gearView({ day: D0, days: 7 }).lists.length, 1);
  const places = f.sim.gearPlaces();
  assert.equal(places.sites[0].name, 'Bondi');
  assert.equal(places.hire, false, 'no hire trucks in a real yard');
  assert.throws(() => list(f, { truck: 'HIRE:BIG', day: D2 }), /Hire trucks come later/);
  // a draft: on the calendar, nothing held, nobody asked; sent later it keeps its direction (a bring-back holds at the site)
  const d = list(f, { day: D2, draft: true, truck: null, driver: null });
  assert.equal(d.item.status, 'DRAFT');
  assert.equal(f.item(d.item.id).order, undefined);
  const bd = list(f, {
    day: D2,
    draft: true,
    truck: null,
    driver: null,
    from: { kind: 'site', id: f.site.id },
    to: { kind: 'yard' },
  });
  assert.equal(bd.item.direction, 'BACK');
  f.cmd('planSend', { id: bd.item.id });
  assert.equal(f.sim.repo.get(f.item(bd.item.id).order, 'order').direction, 'BACK');
  // the office cannot run it in the Practice yard (a gear list is fine there: it is the engine's): the refusal is for hire trucks only
  const demo = new Simulation(f.db, f.owner);
  assert.throws(() => demo.execute('tripArrived', { trip: 'x' }, randomUUID()), /real yard only/);
});

test('the driver: READY at 3 pm company time the day before (Perth on a Sydney server), his own yes on the phone; DAY at 6 am; a no flags both', (t) => {
  const f = liveFixture(t, { zone: 'Australia/Perth', now: zoneAt(D0, '09:00', 'Australia/Perth') });
  const r = list(f);
  const it = () => f.item(r.item.id);
  f.setTime(zoneAt(D0, '15:00', 'Australia/Sydney')); // 12:00 in Perth
  f.pass();
  assert.equal(it().driverAsk, null, "not Sydney's 3 pm");
  f.setTime(zoneAt(D0, '14:59', 'Australia/Perth'));
  f.pass();
  assert.equal(it().driverAsk, null);
  f.setTime(zoneAt(D0, '15:00', 'Australia/Perth'));
  f.pass();
  const ask = f.sim.repo.get(it().driverAsk, 'message');
  assert.equal(ask.subject, 'READY');
  assert.equal(ask.status, 'SENT');
  assert.equal(ask.item, it().id, 'about the list');
  // his own phone: the READY ask is there, with the trip's chain; he answers it himself
  const dave = phone(f);
  const me = dave.me();
  const ready = me.asks.find((a) => a.subject === 'READY');
  assert.ok(ready, 'the phone shows the ask');
  assert.equal(ready.canAnswer, true);
  assert.equal(me.trips[0].chain.length, 5);
  assert.equal(me.trips[0].arrival.words, 'Arrived at yard');
  dave.cmd('messageAnswer', { id: ask.id, yes: true });
  const answered = f.sim.repo.get(ask.id, 'message');
  assert.equal(answered.status, 'YES');
  assert.equal(answered.answer.via, 'PHONE');
  assert.equal(f.sim.planItemView(it()).readyAsk.answer, 'YES');
  // 10,000 passes over the night: nothing answers, packs, loads or moves (the LIVE invariant); the DAY notice goes at 6 am
  const before = records(f.db, f.company);
  const start = zoneAt(D0, '15:01', 'Australia/Perth');
  for (let i = 0; i < 10000; i++) {
    f.setTime(start + i * 3000); // 8 hours, to a little after 11 pm
    f.pass();
  }
  assert.deepEqual(records(f.db, f.company), before, 'the clock changed no record');
  assert.equal(it().dayNotice, null, 'the day has not begun');
  f.setTime(zoneAt(D1, '06:00', 'Australia/Perth'));
  f.pass();
  const notice = f.sim.repo.get(it().dayNotice, 'message');
  assert.equal(notice.subject, 'DAY');
  assert.equal(notice.needsAnswer, false);
  assert.equal(notice.status, 'SENT');
  assert.equal(notice.seenAt, null, 'nobody sees it by itself in a real yard');
  assert.deepEqual(records(f.db, f.company), before);
  dave.cmd('messageSeen', { id: notice.id });
  assert.ok(f.sim.repo.get(notice.id, 'message').seenAt);
  assert.equal(arrivals(f).length, 0);
  assert.equal(tripOf(f, r).state, 'BOOKED');
});

test('READY = no from the phone: the list and the truck booking are flagged for the office; a new driver on the booking is asked instead', (t) => {
  const f = liveFixture(t);
  f.clock(D0, '15:30');
  const r = list(f);
  f.pass();
  const ask = f.sim.repo.get(f.item(r.item.id).driverAsk, 'message');
  assert.equal(ask.status, 'SENT', 'made after 3 pm: asked at once');
  phone(f).cmd('messageAnswer', { id: ask.id, yes: false, reason: 'Crook' });
  f.pass();
  assert.equal(f.item(r.item.id).problem, "Dave can't make it: Crook. Pick another driver.");
  assert.equal(f.item(r.item.truckPlan).problem, "Dave can't make it: Crook. Pick another driver.");
  assert.ok(
    f.sim.needsYou().items.some((x) => /Dave/.test(x.words)),
    'Needs you says so',
  );
  const bill = f.cmd('teamAdd', { name: 'Bill', role: 'DRIVER' }).person;
  f.cmd('planAsk', { item: r.item.truckPlan, person: bill.id });
  f.pass();
  assert.equal(f.sim.repo.get(ask.id, 'message').status, 'CALLED_OFF');
  const again = f.sim.repo.get(f.item(r.item.id).driverAsk, 'message');
  assert.equal(again.person, bill.id);
  assert.equal(f.item(r.item.id).problem, null);
  assert.equal(f.item(r.item.truckPlan).readyNo, null);
  // after 6 am on the day: never asked late
  f.clock(D1, '06:30');
  const late = list(f, {
    truck: f.cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: f.yard.id }).id,
    driver: f.team.Dave.id,
    time: '10:00',
  });
  f.pass();
  assert.equal(f.item(late.item.id).driverAsk, null);
  assert.ok(f.item(late.item.id).readyNotAsked);
});

test('the chain on the phone: Arrived at yard (light), Packed, Loaded & left, Arrived at Bondi (light), Landed; arrivals are append-only rows', (t) => {
  const f = liveFixture(t);
  const r = list(f, { day: D0, time: '10:00' });
  const trip = tripOf(f, r);
  const dave = phone(f),
    kev = phone(f, f.team.Kev);
  f.clock(D0, '09:10');
  assert.deepEqual(dave.me().trips[0].next, ['tripLoaded', 'tripArrived']);
  // 1. arrived at the yard: a person's own tap, no stock moved, one trip_arrival row
  const a1 = dave.cmd('tripArrived', { trip: trip.id }, 'k-arrive-1');
  assert.equal(a1.message, 'Arrived at yard 09:10.');
  assert.equal(a1.confirmation.step, 'ARRIVED_PICKUP');
  let rows = arrivals(f);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].step, 'ARRIVED_PICKUP');
  assert.equal(rows[0].actor_kind, 'PERSON');
  assert.equal(rows[0].site_id, null, 'the yard');
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE company_id=? AND event NOT IN ('COMMAND')").get(f.company).n,
    f.db
      .prepare("SELECT COUNT(*) n FROM ledger WHERE company_id=? AND event NOT IN ('COMMAND') AND created_at<?")
      .get(f.company, new Date(f.at(D0, '09:10')).toISOString()).n,
    'no ledger row for an arrival',
  );
  assert.equal(tripOf(f, r).state, 'BOOKED', 'a label, not a state');
  assert.equal(
    dave.cmd('tripArrived', { trip: trip.id }, 'k-arrive-1').message,
    a1.message,
    'the same key: the same answer',
  );
  assert.throws(
    () => dave.cmd('tripArrived', { trip: trip.id }),
    (e) => e.code === 'ALREADY_CONFIRMED',
  );
  assert.throws(() => f.db.prepare('DELETE FROM trip_arrival').run(), /append only/);
  assert.equal(f.sim.planItemView(f.item(r.item.id)).chain[0].done, true);
  assert.equal(f.sim.planItemView(f.item(r.item.id)).words, 'Arrived at yard 09:10');
  assert.equal(f.item(r.item.truckPlan).stage, 'AT_YARD', 'the truck booking says he is here');
  // 2. packed by Kev's phone (the yard's count), 3. loaded & left by Dave: the stock moves only now
  f.clock(D0, '09:20');
  kev.cmd('packConfirmed', { trip: trip.id });
  f.clock(D0, '09:30');
  dave.cmd('tripLoaded', { trip: trip.id });
  assert.equal(tripOf(f, r).state, 'LOADED');
  assert.equal(f.sim.tripView(tripOf(f, r)).arrival.words, 'Arrived at Bondi');
  assert.equal(f.sim.dispatchView({ day: D0 }).lanes[0].trips[0].dot, 'LOADED');
  // 4. arrived at Bondi: the office records it for him (ON_BEHALF); the lanes' dot says At site
  f.clock(D0, '10:05');
  const a2 = f.cmd('tripArrived', { trip: trip.id });
  assert.equal(a2.message, 'Arrived at Bondi 10:05.');
  rows = arrivals(f);
  assert.equal(rows[1].step, 'ARRIVED_DROP');
  assert.equal(rows[1].actor_kind, 'ON_BEHALF');
  assert.equal(rows[1].on_behalf_of, 'driver:' + f.team.Dave.id);
  assert.equal(rows[1].site_id, f.site.id);
  assert.equal(f.sim.dispatchView({ day: D0 }).lanes[0].trips[0].dot, 'AT_SITE');
  assert.equal(f.sim.dispatchView({ day: D0 }).dots.find((d) => d.code === 'AT_SITE').words, 'At site');
  // 5. landed: the movement step; then the trip is finished and nothing more arrives
  f.clock(D0, '10:20');
  dave.cmd('tripDelivered', { trip: trip.id, receivedBy: 'Ana' });
  const v = f.sim.planItemView(f.item(r.item.id));
  assert.equal(v.status, 'DONE');
  assert.deepEqual(
    v.chain.map((c) => c.done),
    [true, true, true, true, true],
  );
  assert.equal(v.chain[3].kind, 'ON_BEHALF');
  assert.equal(v.chain[4].byName, 'Dave');
  assert.throws(() => f.cmd('tripArrived', { trip: trip.id }), /finished/);
  assert.equal(arrivals(f).length, 2, 'one row per arrival');
  const log = f.item(r.item.truckPlan).log.map((l) => l.text);
  assert.ok(log.some((x) => /Arrived at yard 09:10 \(Dave\)/.test(x)));
  assert.ok(log.some((x) => /Arrived at Bondi 10:05 \(recorded by Tee\)/.test(x)));
});

test('the arrival is an optional gate: Loaded without Arrived is fine, and the arrival cannot be recorded after the load left; another driver never sees it', (t) => {
  const f = liveFixture(t);
  const r = list(f, { day: D0, time: '10:00' });
  const trip = tripOf(f, r);
  f.clock(D0, '09:30');
  f.cmd('tripLoaded', { trip: trip.id });
  // the yard arrival was skipped: its dot stays empty, and the next arrival is the site's
  assert.equal(f.sim.planItemView(f.item(r.item.id)).chain[0].done, false, 'the dot stays empty');
  assert.equal(f.sim.tripView(tripOf(f, r)).arrival.words, 'Arrived at Bondi');
  const bill = f.cmd('teamAdd', { name: 'Bill', role: 'DRIVER' }).person;
  assert.throws(
    () => phone(f, bill).cmd('tripArrived', { trip: trip.id }),
    (e) => e.status === 404,
  );
  const kev = phone(f, f.team.Kev);
  assert.throws(
    () => kev.cmd('tripArrived', { trip: trip.id }),
    (e) => e.status === 404,
    'a yard hand has no trips of his own',
  );
  // arrived at Bondi: a time before the load left is refused; then the office records it (ON_BEHALF)
  f.clock(D0, '10:00');
  assert.throws(
    () => f.cmd('tripArrived', { trip: trip.id, at: new Date(f.at(D0, '09:00')).toISOString(), reason: 'x' }),
    /before it was loaded & left/,
  );
  f.cmd('tripArrived', { trip: trip.id });
  assert.equal(tripOf(f, r).steps.ARRIVED_DROP.kind, 'ON_BEHALF');
  assert.throws(
    () => f.cmd('tripArrived', { trip: trip.id }),
    (e) => e.code === 'ALREADY_CONFIRMED',
  );
  // landed: the movement step closes the chain; an arrival after it is refused
  f.cmd('tripDelivered', { trip: trip.id, receivedBy: 'Ana' });
  assert.throws(() => f.cmd('tripArrived', { trip: trip.id }), /finished/);
  // a bring-back whose collection went first: the site arrival cannot be recorded any more, the yard one can
  const back = f.cmd('bringBackCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 2 }] }).order;
  const run = f.cmd('tripBook', { orders: [back.id], truck: f.truck.id }).trip;
  f.clock(D0, '11:00');
  f.cmd('tripCollected', { trip: run.id });
  const rv = f.sim.tripView(f.sim.repo.get(run.id, 'trip'));
  assert.equal(rv.chain[0].done, false);
  assert.equal(rv.arrival.words, 'Arrived at yard');
  f.cmd('tripReturned', { trip: run.id });
  assert.throws(() => f.cmd('tripArrived', { trip: run.id }), /finished/);
});

test('site -> yard: a bring-back gear list books the truck to the site and brings it home; move the day, cancel', (t) => {
  const f = liveFixture(t);
  // something at Bondi first: an earlier delivery
  const out = list(f, { day: D0, time: '10:00', lines: [{ product: f.product.id, quantity: 10 }] });
  const trip = tripOf(f, out);
  f.clock(D0, '10:30');
  f.cmd('tripLoaded', { trip: trip.id });
  f.cmd('tripDelivered', { trip: trip.id, receivedBy: 'Ana' });
  f.cmd('tripReturned', { trip: trip.id });
  const back = list(f, {
    from: { kind: 'site', id: f.site.id },
    to: { kind: 'yard' },
    lines: [{ product: f.product.id, quantity: 4 }],
    day: D1,
    time: '09:00',
  });
  assert.equal(back.item.direction, 'BACK');
  assert.equal(back.item.name, 'Yard gear');
  assert.equal(back.item.order, 'B-1');
  const bt = tripOf(f, back);
  assert.equal(bt.direction, 'BACK');
  assert.equal(bt.site, f.site.id);
  assert.deepEqual(
    f.sim.tripView(bt).chain.map((c) => c.words),
    ['Arrived at Bondi', 'Loaded', 'Arrived at yard', 'Back at yard'],
  );
  assert.equal(f.sim.orderHeld(bt.orders[0]).get(f.product.id), 4, 'held at Bondi');
  // moved to another day: the order follows, the trip is booked again on the new day's booking when the truck is given again
  f.cmd('gearListUpdate', { id: back.item.id, day: D2, truck: f.truck.id, driver: f.team.Dave.id });
  const moved = f.item(back.item.id);
  assert.equal(moved.day, D2);
  assert.equal(f.item(moved.truckPlan).day, D2);
  assert.equal(f.sim.repo.get(moved.order, 'order').neededOn, D2);
  assert.equal(tripOf(f, back).state, 'BOOKED');
  // cancelled: the order and the trip go too
  f.cmd('planCancel', { id: back.item.id });
  assert.equal(f.item(back.item.id).status, 'CANCELLED');
  assert.equal(f.sim.repo.get(moved.order, 'order').status, 'CANCELLED');
  assert.equal(f.sim.orderHolds(moved.order).length, 0);
});
