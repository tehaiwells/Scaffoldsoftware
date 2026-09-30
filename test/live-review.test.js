process.env.TZ = 'Australia/Sydney';
// Part 2's review (ADR 0009): the holes an adversarial pass and an owner-and-driver walk-through found, each closed and kept closed. A real yard
// only, driven by commands and the business clock (never a tick): backdating cannot skip its reason, a lost phone stays signed out, exact holds
// follow the stock, a load that could not be delivered comes back, a paper-docket collection is dated honestly, the board's usual minutes learn
// only from real drives, a truck booked today leaves yesterday's site, the office and a phone that disagree are both told.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Simulation } from '../src/simulation.js';
import { addDays } from '../src/domain/schedule.js';
import { crewLink, crewClaim, crewAuthenticate } from '../src/crew-auth.js';
import { liveFixture, D0 } from './helpers/live-fixture.js';
const D1 = addDays(D0, 1),
  D2 = addDays(D0, 2),
  D3 = addDays(D0, 3);
const iso = (f, d, hm) => new Date(f.at(d, hm)).toISOString();
function booked(f, quantity, extra = {}) {
  const o = f.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity }], ...extra }).order;
  const trip = f.cmd('tripBook', { orders: [o.id], truck: f.truck.id, driver: f.team.Dave.id }).trip;
  return { o, trip };
}
function phone(f, driver = f.team.Dave) {
  const made = crewLink(f.auth, f.user, { driver: driver.id });
  const claimed = crewClaim(f.auth, { token: made.token, label: 'Test phone' });
  const user = crewAuthenticate(f.db, claimed.token);
  const sim = new Simulation(f.db, user);
  return { user, sim, cmd: (a, i = {}, key = randomUUID()) => sim.execute(a, i, key), token: claimed.token };
}
const audits = (f) => f.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='trip.backdated'").get().n;
const pieces = (f, kind) => {
  let n = 0;
  for (const c of f.sim.containers())
    if (f.sim.repo.get(c.location).kind === kind) n += f.sim.repo.quantity(c.id, f.product.id);
  return n;
};

test("the office cannot skip a backdate's reason by calling its time a phone tap; an old tap from the phone is kept with its own reason", (t) => {
  const f = liveFixture(t);
  const { trip } = booked(f, 5);
  f.clock(D0, '15:00');
  assert.throws(
    () => f.cmd('tripLoaded', { trip: trip.id, at: iso(f, D0, '09:05'), atSource: 'tap' }),
    /Say why the time is earlier/,
    'an office sign-in is never a phone: its earlier time needs a reason',
  );
  assert.equal(audits(f), 0);
  // two days late, keyed in by the office from the phone's "tap" time: refused too, so hire cannot start two days early without a reason
  f.clock(D2, '16:00');
  assert.throws(() => f.cmd('tripLoaded', { trip: trip.id, at: iso(f, D0, '09:01'), atSource: 'tap' }), /Say why/);
  // the driver's own phone, whose tap waited offline since 09:05: kept, with the reason written for it, and audited
  const dave = phone(f);
  f.clock(D0, '15:00');
  const r = dave.cmd('tripLoaded', { trip: trip.id, at: iso(f, D0, '09:05'), atSource: 'tap' });
  assert.equal(r.confirmation.at, iso(f, D0, '09:05'));
  const c = f.db.prepare("SELECT backdate_reason,actor_kind FROM trip_confirmation WHERE step='LOADED'").get();
  assert.equal(c.backdate_reason, 'Tapped on the phone at 09:05, sent 15:00');
  assert.equal(c.actor_kind, 'PERSON');
  assert.equal(audits(f), 1, 'audited like any earlier time');
  // a tap sent within 15 minutes needs nothing
  f.clock(D0, '15:10');
  dave.cmd('tripDelivered', { trip: trip.id, at: iso(f, D0, '15:02'), atSource: 'tap', receivedBy: 'Jo' });
  assert.equal(
    f.db.prepare("SELECT backdate_reason FROM trip_confirmation WHERE step='DELIVERED'").get().backdate_reason,
    null,
  );
  assert.equal(audits(f), 1);
});

test('a lost phone stays signed out: taking the sign-in off the company, then a new link for the driver, never revives it', (t) => {
  const f = liveFixture(t);
  const lost = phone(f);
  f.auth.removeMember(f.user, { userId: lost.user.id });
  assert.throws(
    () => crewAuthenticate(f.db, lost.token),
    (e) => e.status === 401,
  );
  const fresh = crewLink(f.auth, f.user, { driver: f.team.Dave.id });
  assert.throws(
    () => crewAuthenticate(f.db, lost.token),
    (e) => e.status === 401,
    'the old phone stays out',
  );
  const claimed = crewClaim(f.auth, { token: fresh.token });
  assert.equal(crewAuthenticate(f.db, claimed.token).crew.driver, f.team.Dave.id, 'only the new phone signs in');
  // a driver who leaves the team: every phone signed out and open links cancelled at once
  const open = crewLink(f.auth, f.user, { driver: f.team.Dave.id });
  f.cmd('teamRemove', { id: f.team.Dave.id });
  assert.equal(
    f.db.prepare('SELECT COUNT(*) n FROM crew_devices WHERE driver_id=? AND revoked_at IS NULL').get(f.team.Dave.id).n,
    0,
  );
  assert.throws(
    () => crewClaim(f.auth, { token: open.token }),
    (e) => e.status === 404,
  );
});

test('exact holds follow the stock: a held stillage cannot be scrapped; a count that finds fewer moves the hold; one tap still loads', (t) => {
  const f = liveFixture(t);
  const want = f.per * 2 + 3;
  const { o, trip } = booked(f, want);
  const holds = () => f.sim.repo.all('reservation').filter((r) => r.order === o.id && r.active);
  const tops = f.sim
    .containers()
    .filter((x) => x.location === f.yard.id && !f.sim.containers().some((y) => y.support === x.id));
  const top = tops.find((x) => holds().some((h) => h.container === x.id));
  assert.ok(top, 'a held stillage on top of its stack');
  assert.throws(
    () => f.cmd('scrapContainer', { id: top.id, reason: 'Broken frame' }),
    /Held for O-1 for Bondi\. Cancel or change that first\./,
  );
  // a stocktake of that stillage finds 1 (fewer than held): the hold is cut back to what is there and topped up from other free stock
  const cnt = f.cmd('count', { scope: top.id });
  f.cmd('observe', { id: cnt.id, observed: cnt.lines.map(() => 1), reason: 'Short' });
  f.cmd('approveCount', { id: cnt.id });
  for (const h of holds())
    assert.ok(h.quantity <= f.sim.repo.quantity(h.container, h.product), 'never more than is there');
  const view = f.sim.orderView(f.sim.repo.get(o.id, 'order'));
  const free = f.per * 3 - (f.sim.repo.quantity(top.id, f.product.id) === 1 ? f.per - 1 : 0);
  assert.equal(view.lines[0].held, Math.min(want, free), 'held what really exists');
  // the driver's one tap loads it (all that is in the yard, since one stillage came up short)
  const r = f.cmd('tripLoaded', { trip: trip.id, lines: [{ product: f.product.id, quantity: view.lines[0].held }] });
  assert.equal(r.trip.state, 'LOADED');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM contents WHERE quantity<0').get().n, 0);
});

test('a load the site would not take comes back: Back at yard straight from Loaded & left, pieces to the yard, Send again', (t) => {
  const f = liveFixture(t);
  const { o, trip } = booked(f, 5);
  f.cmd('tripLoaded', { trip: trip.id });
  assert.deepEqual(f.sim.tripView(f.sim.repo.get(trip.id, 'trip')).next, [
    'tripDelivered',
    'tripReturned',
    'tripArrived',
  ]);
  const back = f.cmd('tripReturned', { trip: trip.id });
  assert.equal(back.trip.state, 'RETURNED');
  assert.equal(back.trip.stateWords, 'Came back, not delivered');
  assert.match(back.message, /^Back at yard \d\d:\d\d, not delivered/);
  assert.equal(f.sim.repo.get(o.id, 'order').status, 'NOT_DELIVERED');
  assert.equal(pieces(f, 'yard'), f.per * 3, 'every piece back in the yard');
  assert.equal(pieces(f, 'site'), 0);
  assert.equal(f.sim.repo.get(f.truck.id, 'truck').status, 'AT_YARD');
  // nothing was on hire; the truck is free; Send again is a new order of the same pieces
  assert.equal(f.sim.hire({ site: f.site.id }).statement.pieceDays, 0);
  const again = booked(f, 5);
  assert.equal(f.cmd('tripLoaded', { trip: again.trip.id }).trip.state, 'LOADED');
});

test('a collection keyed in from a paper docket may be dated before an unrelated later delivery, never before the site had the pieces', (t) => {
  const f = liveFixture(t);
  const a = booked(f, 10).trip;
  f.cmd('tripLoaded', { trip: a.id });
  f.clock(D0, '10:00');
  f.cmd('tripDelivered', { trip: a.id, receivedBy: 'Jo' });
  const bo = f.cmd('bringBackCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 10 }] }).order;
  const truck2 = f.cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: f.yard.id });
  const bill = f.cmd('teamAdd', { name: 'Bill', role: 'DRIVER' }).person;
  const run = f.cmd('tripBook', { orders: [bo.id], truck: truck2.id, driver: bill.id }).trip;
  f.clock(D2, '09:00');
  const b = booked(f, 3).trip;
  f.cmd('tripLoaded', { trip: b.id });
  f.clock(D2, '09:30');
  f.cmd('tripDelivered', { trip: b.id, receivedBy: 'Jo' });
  f.clock(D3, '08:00');
  // before the site had anything: refused, in plain words
  assert.throws(
    () => f.cmd('tripCollected', { trip: run.id, at: iso(f, D0, '09:30'), reason: 'Paper docket' }),
    /Bondi had only 0 × .* on record at Tue 13 Oct 09:30\. Check the time\./,
  );
  f.cmd('tripCollected', { trip: run.id, at: iso(f, D1, '08:00'), reason: 'Paper docket' });
  f.cmd('tripReturned', { trip: run.id, at: iso(f, D1, '09:00'), reason: 'Paper docket' });
  // hire: 10 on D0 only (they left D1), 3 from D2
  const s = f.sim.hire({ site: f.site.id, from: D0, to: D3 }).statement;
  assert.equal(s.pieceDays, 10 + 3 + 3);
});

test('a truck on a trip cannot be removed, nor a site with an order waiting for it', (t) => {
  const f = liveFixture(t);
  const x = f.cmd('gameSite', { name: 'Manly' }).site;
  const o = f.cmd('orderCreate', { site: x.id, lines: [{ product: f.product.id, quantity: 5 }] }).order;
  assert.throws(
    () => f.cmd('gameRemoveSite', { site: x.id }),
    /O-1 for Manly is waiting for a truck\. Cancel it first\./,
  );
  const trip = f.cmd('tripBook', { orders: [o.id], truck: f.truck.id, driver: f.team.Dave.id }).trip;
  assert.throws(() => f.cmd('retire', { id: f.truck.id }), /T-01 has Trip 1 \(booked\)\. Finish or cancel it first\./);
  assert.throws(() => f.cmd('gameRemoveSite', { site: x.id }), /O-1 for Manly is on a truck booking/);
  f.cmd('tripCancel', { id: trip.id });
  f.cmd('orderCancel', { id: o.id });
  assert.equal(f.sim.orderItems(f.yard.id).items[0].free, f.per * 3, 'nothing held any more');
  assert.ok(f.cmd('gameRemoveSite', { site: x.id }));
});

test("the usual minutes learn only from real drives on the driver's phone, and only once there are three", (t) => {
  const f = liveFixture(t);
  const dave = phone(f);
  const run = (hm, mins, gap = true) => {
    const { trip } = booked(f, 1);
    f.clock(D0, hm);
    dave.cmd('tripLoaded', { trip: trip.id });
    const [h, m] = hm.split(':').map(Number),
      end = String(h + Math.floor((m + mins) / 60)).padStart(2, '0') + ':' + String((m + mins) % 60).padStart(2, '0');
    if (gap) f.clock(D0, end);
    dave.cmd('tripDelivered', {
      trip: trip.id,
      receivedBy: 'Jo',
      ...(gap ? {} : { at: iso(f, D0, end), atSource: 'tap' }),
    });
  };
  run('09:10', 1); // both taps a minute apart: too quick to be a drive
  assert.equal(f.sim.tripMinutes(f.site.id), 30);
  run('10:00', 40);
  run('11:00', 44);
  assert.equal(f.sim.tripMinutes(f.site.id), 30, 'two drives: not enough yet');
  run('12:00', 36);
  assert.equal(f.sim.tripMinutes(f.site.id), 40, 'the median of the real drives');
  assert.match(f.sim.snapshot(0, { lean: true }).liveBoard.trucks[0].words, /Delivered/);
});

test("the board: yesterday's delivery gives way to today's booking; the words say the day when it was not today", (t) => {
  const f = liveFixture(t);
  const { trip } = booked(f, 4);
  f.cmd('tripLoaded', { trip: trip.id });
  f.cmd('tripDelivered', { trip: trip.id, receivedBy: 'Jo' });
  f.clock(D1, '06:00');
  let row = f.sim.snapshot(0, { lean: true }).liveBoard.trucks[0];
  assert.equal(row.state, 'AT_SITE');
  assert.equal(row.words, 'Delivered Tue 13 Oct 09:00 · received by Jo');
  booked(f, 2);
  row = f.sim.snapshot(0, { lean: true }).liveBoard.trucks[0];
  assert.equal(row.state, 'BOOKED', "today's booking, at the yard");
});

test('the office and the phone disagree about a step: the phone learns what the office recorded, the office is told once', (t) => {
  const f = liveFixture(t);
  const { trip } = booked(f, 5);
  f.cmd('tripLoaded', { trip: trip.id });
  f.cmd('tripDelivered', { trip: trip.id, receivedBy: 'Site foreman' });
  const dave = phone(f);
  // the same as recorded: a quiet "already done"
  let e = null;
  try {
    dave.cmd('tripDelivered', { trip: trip.id, receivedBy: 'site Foreman' });
  } catch (x) {
    e = x;
  }
  assert.equal(e.code, 'ALREADY_CONFIRMED');
  assert.equal(e.detail.same, true);
  // different: 4, Mo Ali
  const input = { trip: trip.id, receivedBy: 'Mo Ali', lines: [{ product: f.product.id, quantity: 4 }] };
  try {
    dave.cmd('tripDelivered', input);
  } catch (x) {
    e = x;
  }
  assert.equal(e.detail.same, false);
  assert.equal(e.detail.recorded.receivedBy, 'Site foreman');
  assert.deepEqual(
    e.detail.recorded.lines.map((l) => l.quantity),
    [5],
  );
  assert.deepEqual(
    e.detail.said.lines.map((l) => l.quantity),
    [4],
  );
  for (let i = 0; i < 2; i++) dave.sim.crewConflict('tripDelivered', input, 'tap-1', e.detail);
  const notes = f.sim.repo.all('notification').filter((n) => n.title === 'Driver says different');
  assert.equal(notes.length, 1, 'told once for that tap');
  assert.match(
    notes[0].body,
    /Dave's phone said 4 × .*, received by Mo Ali\. The office recorded 5 × .*, received by Site foreman\./,
  );
});

test('booking: the time is kept, a second trip on the same truck goes an hour later, bring-backs say "from"', (t) => {
  const f = liveFixture(t);
  const a = f.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 2 }] }).order;
  const r1 = f.cmd('tripBook', { orders: [a.id], truck: f.truck.id, driver: f.team.Dave.id, day: D1, time: '08:30' });
  assert.equal(r1.trip.time, '08:30');
  assert.match(r1.message, /^Trip 1: T-01 with Dave to Bondi on Wed 14 Oct at 8:30 am\.$/);
  const b = f.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 1 }] }).order;
  const r2 = f.cmd('tripBook', { orders: [b.id], truck: f.truck.id, driver: f.team.Dave.id, day: D1 });
  assert.equal(r2.trip.time, '09:30', 'the next trip on that truck: an hour after the last');
  const c = f.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 1 }] }).order;
  assert.equal(
    f.cmd('tripBook', { orders: [c.id], truck: f.truck.id, driver: f.team.Dave.id, day: D1, time: '13:00' }).trip.time,
    '13:00',
  );
  // a bring-back: B-1, "from Bondi"
  const t1 = f.sim.repo.get(r1.trip.id, 'trip');
  f.clock(D1, '08:30');
  f.cmd('tripLoaded', { trip: t1.id });
  f.cmd('tripDelivered', { trip: t1.id, receivedBy: 'Jo' });
  const bb = f.cmd('bringBackCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 2 }] }).order;
  assert.equal(bb.label, 'B-1');
  const truck2 = f.cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: f.yard.id });
  const bill = f.cmd('teamAdd', { name: 'Bill', role: 'DRIVER' }).person;
  assert.match(f.cmd('tripBook', { orders: [bb.id], truck: truck2.id, driver: bill.id }).message, / from Bondi on /);
});

test('the office keys a time when that truck was, on record, out on another trip: it asks why', (t) => {
  const f = liveFixture(t);
  const one = booked(f, 2).trip;
  f.clock(D0, '10:00');
  f.cmd('tripLoaded', { trip: one.id });
  f.clock(D0, '10:40');
  f.cmd('tripDelivered', { trip: one.id, receivedBy: 'Jo' });
  const two = booked(f, 2).trip;
  f.clock(D0, '10:45');
  assert.throws(
    () => f.cmd('tripLoaded', { trip: two.id, at: iso(f, D0, '10:35') }),
    /T-01 was on Trip 1 then \(left 10:00, delivered 10:40\)\. Check the time, or say why\./,
  );
  assert.equal(
    f.cmd('tripLoaded', { trip: two.id, at: iso(f, D0, '10:35'), reason: 'Two runs at once, second truck borrowed' })
      .trip.state,
    'LOADED',
  );
});

test("a trip that left answers the driver's ask; the office's day lists a trip booked for tomorrow but done today", (t) => {
  const f = liveFixture(t);
  const o = f.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 2 }] }).order;
  const trip = f.cmd('tripBook', { orders: [o.id], truck: f.truck.id, driver: f.team.Dave.id, day: D1 }).trip;
  const tp = f.sim.repo.get(trip.truckPlan, 'planItem');
  f.pass(); // the clock sends the ask
  const dave = phone(f);
  dave.cmd('tripLoaded', { trip: trip.id });
  const m = f.sim.repo.get(f.sim.repo.get(tp.id, 'planItem').message, 'message');
  assert.equal(m.status, 'YES', 'driving it is a yes');
  dave.cmd('tripDelivered', { trip: trip.id, receivedBy: 'Jo' });
  const day = f.sim.tripsView({ day: D0 });
  assert.deepEqual(
    day.trips.map((x) => x.id),
    [trip.id],
    'done today, booked for tomorrow',
  );
  assert.equal(day.openFrom, new Date(f.at(D0, '09:00')).toISOString(), 'no earlier than the real yard started');
});
