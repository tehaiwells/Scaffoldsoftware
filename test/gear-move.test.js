process.env.TZ = 'Australia/Sydney';
// Site -> site (MOVE, ADR 0012) in a real yard: the order holds at A, Collected moves A -> truck (A's hire ends that day), Delivered moves
// truck -> B (B's hire starts), with hire.js untouched; each site's account balances; A cannot be finished while the move is open; a short
// delivery leaves the rest on the truck until Back at yard. Never ticks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays } from '../src/domain/schedule.js';
import { liveFixture, D0 } from './helpers/live-fixture.js';
const D1 = addDays(D0, 1),
  D3 = addDays(D0, 3);
const at = (f, d, hm) => new Date(f.at(d, hm)).toISOString();
// 10 pieces at Bondi (delivered D0 08:00) and a second site, Manly
function twoSites(t) {
  const f = liveFixture(t);
  const manly = f.cmd('gameSite', { name: 'Manly', address: '2 The Corso, Manly' }).site;
  const out = f.cmd('gearListCreate', {
    from: { kind: 'yard' },
    to: { kind: 'site', id: f.site.id },
    lines: [{ product: f.product.id, quantity: 10 }],
    day: D0,
    time: '10:00',
    truck: f.truck.id,
    driver: f.team.Dave.id,
  });
  const trip = f.sim.repo.get(f.sim.repo.get(f.item(out.item.id).order, 'order').trip, 'trip');
  f.clock(D0, '10:30');
  f.cmd('tripLoaded', { trip: trip.id, at: at(f, D0, '10:05'), reason: 'Paper docket' });
  f.cmd('tripDelivered', { trip: trip.id, at: at(f, D0, '10:25'), reason: 'Paper docket', receivedBy: 'Ana' });
  f.cmd('tripReturned', { trip: trip.id });
  return Object.assign(f, { manly });
}
const where = (f) => {
  const out = {};
  for (const c of f.sim.containers()) {
    const q = f.sim.repo.quantity(c.id, f.product.id);
    if (!q) continue;
    const k =
      c.location === f.yard.id
        ? 'yard'
        : c.location === f.site.id
          ? 'bondi'
          : c.location === f.manly.id
            ? 'manly'
            : 'truck';
    out[k] = (out[k] ?? 0) + q;
  }
  return out;
};

test('a move holds at A; Collected A -> truck, Delivered truck -> B; hire moves from Bondi to Manly by the piece; both accounts balance', (t) => {
  const f = twoSites(t);
  f.clock(D0, '17:30');
  const mv = f.cmd('gearListCreate', {
    from: { kind: 'site', id: f.site.id },
    to: { kind: 'site', id: f.manly.id },
    lines: [{ product: f.product.id, quantity: 6 }],
    day: D1,
    time: '08:00',
    truck: f.truck.id,
    driver: f.team.Dave.id,
  });
  assert.equal(mv.item.direction, 'MOVE');
  assert.equal(mv.item.name, 'Manly gear');
  assert.equal(mv.item.order, 'M-1', 'moves are numbered on their own');
  assert.match(mv.message, /Manly gear on Wed 14 Oct at 8:00 am\. T-01 with Dave booked\. M-1: Held exactly\./);
  const it = f.item(mv.item.id);
  assert.equal(it.fromSite, f.site.id);
  assert.equal(it.site, f.manly.id);
  const o = f.sim.repo.get(it.order, 'order');
  assert.equal(o.fromSite, f.site.id);
  const holds = f.sim.orderHolds(o.id);
  assert.equal(
    holds.reduce((n, h) => n + h.quantity, 0),
    6,
  );
  assert.ok(
    holds.every((h) => f.sim.repo.get(h.container, 'container').location === f.site.id),
    'held at Bondi',
  );
  const trip = f.sim.repo.get(o.trip, 'trip');
  assert.equal(trip.direction, 'MOVE');
  assert.equal(trip.fromSite, f.site.id);
  assert.equal(trip.site, f.manly.id);
  const tv = f.sim.tripView(trip);
  assert.equal(tv.fromSiteName, 'Bondi');
  assert.deepEqual(
    tv.chain.map((c) => c.words),
    ['Arrived at Bondi', 'Loaded', 'Arrived at Manly', 'Landed'],
  );
  assert.deepEqual(tv.next, ['tripCollected', 'tripArrived']);
  assert.equal(tv.arrival.words, 'Arrived at Bondi');
  // Bondi cannot be finished or removed while the move is open; nor Manly
  assert.match(f.sim.tripSiteBusy(f.site.id), /M-1 from Bondi to Manly is on a truck booking\. Cancel it first\./);
  assert.match(f.sim.tripSiteBusy(f.manly.id), /M-1/);
  assert.throws(() => f.cmd('gameRemoveSite', { site: f.site.id }), /M-1|Cancel it first|Confirm/);
  // the day: arrived at Bondi, collected (Bondi -> truck), arrived at Manly, landed (truck -> Manly), stock never elsewhere
  f.clock(D1, '08:05');
  assert.equal(f.cmd('tripArrived', { trip: trip.id }).message, 'Arrived at Bondi 08:05.');
  f.clock(D1, '08:30');
  f.cmd('tripCollected', { trip: trip.id, at: at(f, D1, '08:30') });
  assert.deepEqual(where(f), { yard: f.per * 3 - 10, bondi: 4, truck: 6 });
  let tr = f.sim.repo.get(trip.id, 'trip');
  assert.equal(tr.state, 'COLLECTED');
  assert.equal(f.sim.repo.get(f.truck.id, 'truck').destination, f.manly.id, 'heading for Manly, not the yard');
  assert.equal(f.sim.liveBoard().trucks[0].state, 'TO_SITE');
  assert.equal(f.sim.liveBoard().trucks[0].to, f.manly.id);
  assert.equal(f.sim.tripView(tr).arrival.words, 'Arrived at Manly');
  assert.equal(f.item(mv.item.id).stage, 'ON_THE_WAY');
  assert.equal(f.sim.planItemView(f.item(mv.item.id)).words, 'Loaded 08:30');
  f.clock(D1, '09:10');
  f.cmd('tripArrived', { trip: trip.id });
  f.clock(D1, '09:20');
  f.cmd('tripDelivered', { trip: trip.id, at: at(f, D1, '09:15'), receivedBy: 'Bo' });
  assert.deepEqual(where(f), { yard: f.per * 3 - 10, bondi: 4, manly: 6 });
  tr = f.sim.repo.get(trip.id, 'trip');
  assert.equal(tr.state, 'DELIVERED');
  assert.equal(f.sim.repo.get(o.id, 'order').status, 'DELIVERED');
  assert.equal(f.sim.repo.get(o.id, 'order').lines[0].collected, 6);
  assert.equal(f.sim.repo.get(o.id, 'order').lines[0].delivered, 6);
  assert.equal(f.item(mv.item.id).status, 'DONE');
  assert.deepEqual(
    f.sim.planItemView(f.item(mv.item.id)).chain.map((c) => c.done),
    [true, true, true, true],
  );
  // the ledger: COLLECTED rows Bondi -> truck, DELIVERED rows truck -> Manly (hire.js reads them as the end of Bondi's hire and the start of Manly's)
  const rows = f.db
    .prepare(
      "SELECT event,source,destination,quantity FROM ledger WHERE company_id=? AND event IN ('COLLECTED','DELIVERED') ORDER BY sequence",
    )
    .all(f.company);
  assert.deepEqual(
    rows
      .slice(-2)
      .map((r) => [
        r.event,
        r.source === f.site.id ? 'Bondi' : r.source === f.truck.id ? 'truck' : '?',
        r.destination === f.manly.id ? 'Manly' : r.destination === f.truck.id ? 'truck' : '?',
        r.quantity,
      ]),
    [
      ['COLLECTED', 'Bondi', 'truck', 6],
      ['DELIVERED', 'truck', 'Manly', 6],
    ],
  );
  // hire (untouched hire.js): Bondi D0 (10) and D1 (4 stay: the 6 left on D1 are not on hire that day); Manly from D1 (6)
  f.clock(D3, '12:00');
  const bondi = f.sim.hire({ site: f.site.id, from: D0, to: D3 }).statement,
    manly = f.sim.hire({ site: f.manly.id, from: D0, to: D3 }).statement;
  assert.equal(bondi.onHireNow, 4);
  assert.equal(manly.onHireNow, 6);
  assert.equal(bondi.pieceDays, 10 + 4 * 3, 'Bondi: 10 on D0, then 4 a day');
  assert.equal(manly.pieceDays, 6 * 3, 'Manly: 6 a day from the day they landed');
  // each site's account balances: Bondi sent 10, 6 left for Manly (on record as collected), 4 on site; Manly has 6 on site
  const a = f.sim.siteAccount(f.site.id),
    b = f.sim.siteAccount(f.manly.id);
  assert.equal(a.onSite, 4);
  assert.equal(b.onSite, 6);
  // the move's Collected is Bondi's row (where it happened) and what landed at Manly has moved on: both accounts stay whole
  assert.equal(a.collected, 6);
  assert.equal(a.moved, 6);
  assert.equal(a.unaccounted, 0);
  assert.match(a.summary, /6 moved to Manly/);
  assert.equal(b.collected, 0, 'nothing was collected from Manly');
  assert.equal(b.unaccounted, 0);
  assert.equal(f.sim.tripSiteBusy(f.site.id), null, 'Bondi is free again');
});

test('a move landed short leaves the rest on the truck until Back at yard; the clock flags a move like a bring-back until collected, like a send after', (t) => {
  const f = twoSites(t);
  f.clock(D0, '17:30');
  const mv = f.cmd('gearListCreate', {
    from: { kind: 'site', id: f.site.id },
    to: { kind: 'site', id: f.manly.id },
    lines: [{ product: f.product.id, quantity: 6 }],
    day: D1,
    time: '08:00',
    truck: f.truck.id,
    driver: f.team.Dave.id,
  });
  const trip = f.sim.repo.get(f.sim.repo.get(f.item(mv.item.id).order, 'order').trip, 'trip');
  // the day ends with nothing collected: "nobody recorded the collection"
  f.clock(D1, '17:30');
  f.pass();
  assert.equal(f.sim.repo.get(trip.id, 'trip').flag.words, 'Not confirmed: nobody recorded the collection');
  assert.equal(f.sim.repo.get(trip.id, 'trip').state, 'BOOKED', 'flagged, never moved on');
  // collected next morning (the office keys it in), then late on the road: "Delivered?" (a move heads for a site)
  f.clock(addDays(D1, 1), '08:00');
  f.cmd('tripCollected', { trip: trip.id });
  f.clock(addDays(D1, 1), '09:05');
  f.pass();
  assert.match(
    f.sim.repo.get(trip.id, 'trip').flag.words,
    /^Not confirmed: left Bondi 08:00, usually ~30 min\. Delivered\?$/,
  );
  f.cmd('tripArrived', { trip: trip.id });
  f.cmd('tripDelivered', { trip: trip.id, lines: [{ product: f.product.id, quantity: 4 }], receivedBy: 'Bo' });
  let tr = f.sim.repo.get(trip.id, 'trip');
  assert.equal(tr.state, 'DELIVERED_SHORT');
  assert.equal(tr.flag, null, 'a confirmation clears the flag');
  assert.deepEqual(where(f), { yard: f.per * 3 - 10, bondi: 4, manly: 4, truck: 2 });
  assert.deepEqual(f.sim.tripView(tr).next, ['tripReturned']);
  f.cmd('tripReturned', { trip: trip.id });
  tr = f.sim.repo.get(trip.id, 'trip');
  assert.equal(tr.state, 'RETURNED');
  assert.deepEqual(where(f), { yard: f.per * 3 - 8, bondi: 4, manly: 4 });
  assert.equal(f.sim.repo.get(tr.orders[0], 'order').status, 'SHORT');
});
