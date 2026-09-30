process.env.TZ = 'UTC';
// Hire and Reports count a real yard's days in the company's own time zone (ADR 0002, 0009), on a server that runs in another one (hosting
// in UTC): an 08:00 Sydney delivery is on hire from that Sydney day, never the day before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays } from '../src/domain/schedule.js';
import { liveFixture, D0 } from './helpers/live-fixture.js';

test('hire starts and ends on the company day of the confirmed times, whatever zone the server is in', (t) => {
  const f = liveFixture(t, { zone: 'Australia/Sydney' });
  const D1 = addDays(D0, 1),
    D3 = addDays(D0, 3);
  const o = f.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 10 }] }).order;
  const trip = f.cmd('tripBook', { orders: [o.id], truck: f.truck.id, driver: f.team.Dave.id }).trip;
  f.clock(D1, '07:30');
  f.cmd('tripLoaded', { trip: trip.id });
  f.clock(D1, '08:00'); // 21:00 UTC the day before
  f.cmd('tripDelivered', { trip: trip.id, receivedBy: 'Jo' });
  assert.equal(
    f.sim.hire({ site: f.site.id, from: D0, to: D0 }).statement.pieceDays,
    0,
    'nothing on hire the day before',
  );
  assert.equal(f.sim.hire({ site: f.site.id, from: D1, to: D1 }).statement.pieceDays, 10);
  const back = f.cmd('bringBackCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 10 }] }).order;
  const run = f.cmd('tripBook', { orders: [back.id], truck: f.truck.id, driver: f.team.Dave.id, day: D3 }).trip;
  f.clock(D3, '07:00'); // 20:00 UTC on D2
  f.cmd('tripCollected', { trip: run.id });
  f.cmd('tripReturned', { trip: run.id });
  // on hire D1 and D2 (it left on D3, Sydney time)
  assert.equal(f.sim.hire({ site: f.site.id, from: D0, to: D3 }).statement.pieceDays, 20);
  assert.equal(f.sim.hire({ site: f.site.id }).statement.today, D3, "today is the company's day");
});
