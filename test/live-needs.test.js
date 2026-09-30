process.env.TZ = 'Australia/Sydney';
// "Needs you" v1 (ADR 0010, audit H5/#17): deterministic rules over LIVE records only, one action each, at most 5 shown, dismissed with
// a reason; the board's one chip and Today's card read the same list. Nothing here ticks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Simulation } from '../src/simulation.js';
import { addDays } from '../src/domain/schedule.js';
import { NEEDS_CAP } from '../src/domain/needs.js';
import { liveFixture, D0 } from './helpers/live-fixture.js';
const D1 = addDays(D0, 1);
const kinds = (f) => f.sim.needsYou().items.map((i) => i.kind);

test('empty at the start; each rule fires from its record and clears when the fact changes; the clock only flags', (t) => {
  const f = liveFixture(t);
  assert.deepEqual(f.sim.needsYou(), { count: 0, items: [], more: 0, cap: NEEDS_CAP, dismissed: 0 });
  assert.equal(f.sim.snapshot().needsYou.count, 0, 'the board chip reads the same list');
  // NO_DRIVER_YES: a truck booked tomorrow, no yes by 5 pm today
  const b = f.cmd('planTruck', { day: D1, time: '07:00', truck: f.truck.id, driver: f.team.Dave.id }).item;
  f.clock(D0, '16:59');
  assert.deepEqual(kinds(f), []);
  f.clock(D0, '17:00');
  let n = f.sim.needsYou();
  assert.deepEqual(
    n.items.map((i) => [i.kind, i.action.label]),
    [['NO_DRIVER_YES', 'Call Dave']],
  );
  assert.match(n.items[0].words, /tomorrow 7:00 am: Dave has not said yes/);
  f.cmd('messageAnswer', { id: f.msgs(b.id)[0].id, yes: true });
  assert.deepEqual(kinds(f), [], 'cleared by the answer');
  // UNCONFIRMED_TRIP: the clock flags a trip whose day ended with nothing recorded; first in the list
  const o = f.cmd('orderCreate', {
    site: f.site.id,
    lines: [{ product: f.product.id, quantity: 3 }],
    neededOn: D1,
  }).order;
  const trip = f.cmd('tripBook', { orders: [o.id], truckPlan: b.id }).trip;
  f.clock(D1, '17:05');
  f.pass();
  n = f.sim.needsYou();
  assert.equal(n.items[0].kind, 'UNCONFIRMED_TRIP');
  assert.deepEqual(n.items[0].action, { label: 'Confirm', view: 'TRIPS', trip: trip.id });
  assert.ok(
    n.items.some((i) => i.kind === 'NOT_CONFIRMED'),
    "the booking's own clock flag too",
  );
  // a confirmation clears the trip's flag; the booking's day is done with it
  f.cmd('tripLoaded', { trip: trip.id, at: new Date(f.at(D1, '08:00')).toISOString(), reason: 'Paper docket' });
  f.cmd('tripDelivered', {
    trip: trip.id,
    receivedBy: 'J',
    at: new Date(f.at(D1, '09:00')).toISOString(),
    reason: 'Paper docket',
  });
  // UNPRICED_ON_HIRE: the delivered pieces are on hire with no rate; PAPERWORK expired ranks above it
  assert.deepEqual(kinds(f), ['UNPRICED_ON_HIRE']);
  f.cmd('paperworkAdd', { type: 'PERMIT', title: 'Council permit', site: f.site.id, expiresOn: D0 });
  n = f.sim.needsYou();
  assert.deepEqual(
    n.items.map((i) => i.kind),
    ['PAPERWORK', 'UNPRICED_ON_HIRE'],
  );
  assert.equal(n.items[0].action.label, 'Renew');
  assert.equal(n.items[1].action.view, 'HIRE');
  f.cmd('hireRate', { product: f.product.id, week: 100 });
  assert.deepEqual(kinds(f), ['PAPERWORK']);
  // CLASH: a person on two bookings one day (a record from before the rules, saved by hand: the commands refuse it)
  const w = f.cmd('planWorkers', {
    day: addDays(D0, 3),
    time: '07:00',
    site: f.site.id,
    count: 1,
    people: [f.team.Jo.id],
  }).item;
  const copy = f.sim.repo.get(w.id, 'planItem');
  delete copy.id;
  delete copy.version;
  const dup = f.sim.repo.add('planItem', { ...copy, kind: undefined, time: '13:00' });
  n = f.sim.needsYou();
  const clash = n.items.find((i) => i.kind === 'CLASH');
  assert.ok(clash, 'a clash is found');
  assert.match(clash.words, /Jo is booked 2 times on/);
  assert.equal(clash.action.label, 'Move one');
  f.cmd('planCancel', { id: dup.id });
  assert.ok(!f.sim.needsYou().items.some((i) => i.kind === 'CLASH'));
  // the Practice yard has no list; a supervisor sees none
  assert.equal(new Simulation(f.db, f.owner).needsYou().count, 0);
  assert.equal('needsYou' in new Simulation(f.db, f.owner).snapshot(), false, 'no chip in the Practice yard');
});

test("RETURN_SHORT and the booking flags: count later, no answer, can't make it, not asked in time; each with one action", (t) => {
  const f = liveFixture(t);
  const o = f.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 6 }] }).order;
  const out = f.cmd('tripBook', { orders: [o.id], truck: f.truck.id, driver: f.team.Dave.id }).trip;
  f.clock(D0, '09:30');
  f.cmd('tripLoaded', { trip: out.id });
  f.cmd('tripDelivered', { trip: out.id, receivedBy: 'J' });
  f.cmd('tripReturned', { trip: out.id });
  const b = f.cmd('bringBackCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 6 }] }).order;
  const coll = f.cmd('tripBook', { orders: [b.id], truck: f.truck.id, driver: f.team.Dave.id, time: '13:00' }).trip;
  f.clock(D0, '13:30');
  f.cmd('tripCollected', { trip: coll.id });
  f.cmd('tripReturned', { trip: coll.id, countLater: true });
  f.clock(D0, '17:10');
  f.pass();
  let n = f.sim.needsYou();
  assert.deepEqual(
    n.items.map((i) => [i.kind, i.action.label]),
    [['RETURN_SHORT', 'Count']],
  );
  f.cmd('returnCount', { trip: coll.id, lines: [{ product: f.product.id, quantity: 5 }] });
  n = f.sim.needsYou();
  assert.deepEqual(
    n.items.map((i) => [i.kind, i.action.label]),
    [['RETURN_SHORT', 'Sort it out']],
  );
  f.cmd('productValue', { product: f.product.id, replacementValue: 500 });
  f.cmd('returnResolve', { trip: coll.id, lines: [{ product: f.product.id, quantity: 1, outcome: 'LOST' }] });
  assert.deepEqual(kinds(f), []);
  // the clock's booking flags: a truck today whose driver never answered by its time; workers not asked in time
  f.clock(D1, '06:00');
  const tr = f.cmd('planTruck', { day: D1, time: '09:00', truck: f.truck.id, driver: f.team.Dave.id }).item;
  const w = f.cmd('planWorkers', { day: D1, time: '10:00', site: f.site.id, count: 1, people: [f.team.Jo.id] }).item;
  f.clock(D1, '09:01');
  f.pass();
  n = f.sim.needsYou();
  assert.deepEqual(
    n.items.map((i) => [i.kind, i.action.label, i.item]),
    [['NO_ANSWER', 'Call them', tr.id]],
  );
  f.cmd('messageAnswer', { id: f.msgs(tr.id)[0].id, yes: false, reason: 'Crook' });
  assert.deepEqual(kinds(f), ['CANT_MAKE_IT']);
  assert.equal(f.sim.needsYou().items[0].action.label, 'Ask someone else');
  // booked after 3 pm the day before: asked at once. Booked for the day after, with the computer off from before 3 pm until past the
  // start time: never asked, and Needs you says so
  assert.equal(f.msgs(w.id).length, 1, 'booked after 3 pm: asked at once');
  const D2 = addDays(D0, 2);
  const w2 = f.cmd('planWorkers', { day: D2, time: '09:30', site: f.site.id, count: 1, people: [f.team.Sam.id] }).item;
  assert.equal(f.msgs(w2.id).length, 0, 'asked at 3 pm the day before, when the clock gets there');
  f.clock(D2, '09:31');
  f.pass();
  assert.equal(f.msgs(w2.id).length, 0, 'never sent late, once the work has started');
  assert.ok(
    f.sim.needsYou().items.some((i) => i.kind === 'NOT_ASKED' && i.item === w2.id && i.action.label === 'Call them'),
  );
});

test('the cap: at most 5 shown, the count says how many; dismiss with a reason hides one until its fact changes', (t) => {
  const f = liveFixture(t);
  for (let i = 1; i <= 7; i++)
    f.cmd('paperworkAdd', { type: 'PERMIT', title: 'Permit ' + i, expiresOn: addDays(D0, -i) });
  let n = f.sim.needsYou();
  assert.equal(n.count, 7);
  assert.equal(n.items.length, 5);
  assert.equal(n.more, 2);
  assert.equal(f.sim.snapshot().needsYou.count, 7);
  const first = n.items[0];
  assert.throws(() => f.cmd('needsYouDismiss', { id: first.id }), /Say why/);
  const d = f.cmd('needsYouDismiss', { id: first.id, reason: 'Renewed on paper, filing it Friday' });
  assert.equal(d.needsYou.count, 6);
  assert.ok(!d.needsYou.items.some((i) => i.id === first.id));
  assert.equal(f.sim.repo.all('needsDismissal').length, 1);
  assert.equal(f.sim.repo.all('needsDismissal')[0].reason, 'Renewed on paper, filing it Friday');
  // the same fact stays dismissed across reads; a changed fact (a new expiry) is a new item
  assert.equal(f.sim.needsYou().count, 6);
  const p = f.sim.repo.all('paperwork').find((x) => 'PAPERWORK:' + x.id + ':EXPIRED:' + x.expiresOn === first.id);
  f.cmd('paperworkUpdate', { id: p.id, expiresOn: addDays(D0, -30) });
  assert.equal(f.sim.needsYou().count, 7, 'back with its new date');
  // dismissing is the office's, in a real yard only
  const demo = new Simulation(f.db, f.owner);
  assert.throws(() => demo.execute('needsYouDismiss', { id: 'x', reason: 'why' }, randomUUID()), /real yard/);
  // rank order holds: an unconfirmed trip goes above every permit
  const o = f.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 1 }] }).order;
  f.cmd('tripBook', { orders: [o.id], truck: f.truck.id, driver: f.team.Dave.id });
  f.clock(D0, '17:30');
  f.pass();
  assert.equal(f.sim.needsYou().items[0].kind, 'UNCONFIRMED_TRIP');
});
