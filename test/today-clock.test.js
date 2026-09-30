process.env.TZ = 'Australia/Sydney';
import test from 'node:test';
import assert from 'node:assert/strict';
import { planFixture, D0 } from './helpers/plan-fixture.js';
// The Today page takes the time of day from the company's clock (the server's hm in planMonth, else the plan's `now` in the company's
// time zone), never from the browser's own clock: CI runs on UTC and a phone can be abroad, while the yard's day is the yard's. Before
// this, a real yard's "+ Truck" for today vanished on the UTC runners after 17:30 UTC (3:30 am Sydney), because the browser's date said
// the slots were past.
const OWNER = [
  'company.manage',
  'users.manage',
  'operations.manage',
  'sites.assigned',
  'requests.create',
  'finance.view',
  'stock.adjust',
];
const load = async () => {
  const m = await import('../public/operations.js');
  return { T: m.__test, td: m.tdTest };
};
test("today's booking buttons follow the company clock: a London yard at 9 am books today while Sydney's clock says 7 pm", async (t) => {
  const f = planFixture(t);
  f.cmd('teamStart');
  f.site('Bondi');
  const { T, td } = await load();
  td.reset();
  T.setState(f.sim.snapshot(), {
    permissions: OWNER,
    systems: [],
    users: [],
    company: { id: 'c', name: 'Tee Scaffolding' },
    user: { id: f.user.id, name: 'Owner' },
  });
  T.setView('TODAY');
  const plan = f.sim.planMonth(D0.slice(0, 7)),
    today = f.sim.todayView(),
    at = '2026-10-13T08:00:00.000Z'; // 9:00 am in London; 7:00 pm in Sydney (AEDT), where this process's clock sits
  // the server's hm is the clock when it is there (planMonth sends it), whatever the browser or the zone name says
  assert.equal(typeof plan.hm, 'string', 'planMonth sends the company hm');
  td.setData({ ...plan, hm: '13:15', now: at, timeZone: 'Europe/London' }, today);
  td.select(D0);
  assert.equal(td.clockMinutes(), 13 * 60 + 15, "the server's hm");
  t.mock.timers.tick(90 * 1000);
  assert.equal(td.clockMinutes(), 13 * 60 + 16.5, "the server's hm, moved on by the time since the read");
  // without it (an older server), the plan's now in the company's zone
  td.setData({ ...plan, hm: undefined, now: at, timeZone: 'Europe/London' }, today);
  assert.equal(td.clockMinutes(), 9 * 60, 'London, 9 am');
  assert.match(td.view(), /data-tdh-add="TRUCK"/, 'a London yard can still book a truck for today at 9 am');
  td.setData({ ...plan, hm: undefined, now: at, timeZone: 'Australia/Sydney' }, today);
  assert.equal(td.clockMinutes(), 19 * 60, 'Sydney, 7 pm');
  assert.doesNotMatch(td.view(), /data-tdh-add="TRUCK"/, "a Sydney yard's day is over at 7 pm");
  td.setData({ ...plan, hm: undefined, now: at, timeZone: 'Not/AZone' }, today);
  assert.equal(td.clockMinutes(), 19 * 60, "an unknown zone name falls back to the browser's clock");
  // the clock keeps moving between fetches: 20 minutes on, London reads 9:20
  td.setData({ ...plan, hm: undefined, now: at, timeZone: 'Europe/London' }, today);
  t.mock.timers.tick(20 * 60 * 1000);
  assert.equal(td.clockMinutes(), 9 * 60 + 20, 'London, 9:20 am');
});
