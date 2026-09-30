process.env.TZ = 'Australia/Sydney';
// The part-3 review's findings (ADR 0010, the records review and the first-timer walkthrough), each pinned by a test:
//   hire: a partial loss keeps the top-up for what came back; lost then still-on-site in separate commands continues; lost never tops up
//   the site account: write-off with an unresolved trip lands at 0; a send resolved still-on-site counts as sent
//   quarantine: never flipped, scrapped or retired like a stillage, never picked; a charge goes to the lot's own site
//   Needs you: a count that comes up short is a new item (a dismissal before it lapses); one item per booking; an hour's grace after 5 pm
//   money: typed values are the owner's, recorded as approved
//   dispatch: a packed truck booking still moves with the day; packed counts are what everyone downstream starts from; a "can't make it"
//   lane is first; the office's Packed is ON_BEHALF; a fully held list is never "short"; the register's available is the yard's; intake on
//   the ledger row. Nothing here ticks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Simulation } from '../src/simulation.js';
import { addDays } from '../src/domain/schedule.js';
import { crewLink, crewClaim, crewAuthenticate } from '../src/crew-auth.js';
import { liveFixture, D0 } from './helpers/live-fixture.js';
const D1 = addDays(D0, 1),
  D2 = addDays(D0, 2),
  D3 = addDays(D0, 3),
  D4 = addDays(D0, 4),
  D6 = addDays(D0, 6);
function phone(f, person) {
  const made = crewLink(f.auth, f.user, { person: person.id });
  const claimed = crewClaim(f.auth, { token: made.token, label: 'Test phone' });
  const sim = new Simulation(f.db, crewAuthenticate(f.db, claimed.token));
  return { sim, cmd: (a, i = {}, key = randomUUID()) => sim.execute(a, i, key), me: () => sim.crewMe() };
}
function manager(f) {
  const made = f.auth.invite(f.user, { email: randomUUID() + '@example.com', roles: ['GENERAL_MANAGER'] });
  const token = f.auth.acceptInvitation({ token: made.token, name: 'GM', password: 'demonstration-password' });
  const sim = new Simulation(f.db, f.auth.authenticate(token));
  return { sim, cmd: (a, i = {}, key = randomUUID()) => sim.execute(a, i, key) };
}
const charges = (f) => f.db.prepare('SELECT * FROM charge_lines WHERE company_id=? ORDER BY sequence').all(f.company);
// deliver n on D0, collect `back` of them on collectDay (the collection trip is not yet Back at yard)
function outAndBack(f, n, back = n, collectDay = D0) {
  const o = f.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: n }] }).order;
  const out = f.cmd('tripBook', { orders: [o.id], truck: f.truck.id, driver: f.team.Dave.id }).trip;
  f.clock(D0, '09:30');
  f.cmd('tripLoaded', { trip: out.id });
  f.clock(D0, '10:00');
  f.cmd('tripDelivered', { trip: out.id, receivedBy: 'J. Smith' });
  f.cmd('tripReturned', { trip: out.id });
  const b = f.cmd('bringBackCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: back }] }).order;
  const coll = f.cmd('tripBook', {
    orders: [b.id],
    truck: f.truck.id,
    driver: f.team.Dave.id,
    time: '13:00',
    ...(collectDay !== D0 ? { day: collectDay } : {}),
  }).trip;
  f.clock(collectDay, '13:30');
  f.cmd('tripCollected', { trip: coll.id });
  return { out, coll, o, b };
}
const hireRow = (f) => {
  const h = f.sim.hire({ site: f.site.id, from: D0, to: D6 });
  const row = h.sites.find((s) => s.id === f.site.id) ?? null,
    l = h.statement?.lines?.[0] ?? null;
  return {
    pieces: row?.pieces ?? 0,
    since: row?.since ?? null,
    pieceDays: l?.pieceDays ?? 0,
    topUp: l?.topUp?.pieceDays ?? 0,
  };
};

test('hire: a partial loss keeps the minimum-hire top-up for what came back; lost never tops up; lost then still-on-site continues', (t) => {
  const run = (variant) => {
    const f = liveFixture(t);
    f.cmd('hireRate', { product: f.product.id, week: 7000, minDays: 7 });
    f.cmd('productValue', { values: [{ product: f.product.id, replacementValue: 1000 }] });
    const { coll } = outAndBack(f, 10, 10, D3);
    f.clock(D3, '14:00');
    if (variant === 'all-back') {
      f.cmd('tripReturned', { trip: coll.id });
      return hireRow(f);
    }
    f.cmd('tripReturned', { trip: coll.id, lines: [{ product: f.product.id, quantity: 8 }] });
    if (variant === 'lost-only') {
      f.cmd('returnResolve', { trip: coll.id, lines: [{ product: f.product.id, quantity: 2, outcome: 'LOST' }] });
      return hireRow(f);
    }
    if (variant === 'one-command') {
      f.cmd('returnResolve', {
        trip: coll.id,
        lines: [
          { product: f.product.id, quantity: 1, outcome: 'LOST' },
          { product: f.product.id, quantity: 1, outcome: 'STILL_ON_SITE' },
        ],
      });
      return hireRow(f);
    }
    f.cmd('returnResolve', { trip: coll.id, lines: [{ product: f.product.id, quantity: 1, outcome: 'LOST' }] });
    f.clock(D4, '09:00');
    f.cmd('returnResolve', {
      trip: coll.id,
      lines: [{ product: f.product.id, quantity: 1, outcome: 'STILL_ON_SITE' }],
    });
    return hireRow(f);
  };
  // 10 pieces out D0, back D3: 30 piece-days, and 10 × 4 days of top-up to the 7-day minimum
  assert.deepEqual(run('all-back'), { pieces: 0, since: null, pieceDays: 30, topUp: 40 });
  // 8 back, 2 lost: the 8 keep their top-up (32), the lost 2 get none
  assert.deepEqual(run('lost-only'), { pieces: 0, since: null, pieceDays: 30, topUp: 32 });
  // 1 lost, 1 still on site (one command, lost first): the piece on site continues from D0, no top-up for the lost one
  assert.deepEqual(run('one-command'), { pieces: 1, since: D0, pieceDays: 31, topUp: 32 });
  // the same in two commands a day apart (what the office does when the foreman rings the next morning)
  assert.deepEqual(run('two-commands'), { pieces: 1, since: D0, pieceDays: 32, topUp: 32 });
});

test('the site account: write off with an unresolved trip shortfall lands at 0 unaccounted; a send resolved still-on-site counts as sent', (t) => {
  const f = liveFixture(t);
  const { coll } = outAndBack(f, 10, 6);
  f.clock(D0, '14:00');
  f.cmd('tripReturned', { trip: coll.id, lines: [{ product: f.product.id, quantity: 5 }] });
  const before = f.sim.siteAccount(f.site.id);
  assert.deepEqual(
    [before.sent, before.back, before.onSite, before.unresolved, before.missing, before.unaccounted],
    [10, 5, 4, 1, 5, 1],
  );
  assert.equal(before.summary, 'sent 10 · back 5 · 4 on site (hire running) · 1 not back, not sorted');
  f.cmd('siteFinish', { site: f.site.id, outcome: 'WRITE_OFF', reason: 'Builder went bust' });
  const after = f.sim.siteAccount(f.site.id);
  assert.deepEqual([after.writtenOff, after.onSite, after.unresolved, after.unaccounted], [5, 0, 0, 0]);
  assert.equal(f.sim.repo.get(f.site.id, 'site').finish.writtenOffSite, 4);
  assert.equal(after.summary, 'sent 10 · back 5 · 5 written off');

  // a send delivered short, the rest brought back and then resolved "still on site": delivered after all, from the delivery day
  const g = liveFixture(t);
  g.cmd('hireRate', { product: g.product.id, day: 100 });
  const o = g.cmd('orderCreate', { site: g.site.id, lines: [{ product: g.product.id, quantity: 12 }] }).order;
  const out = g.cmd('tripBook', { orders: [o.id], truck: g.truck.id, driver: g.team.Dave.id }).trip;
  g.clock(D0, '09:30');
  g.cmd('tripLoaded', { trip: out.id });
  g.clock(D0, '10:00');
  g.cmd('tripDelivered', { trip: out.id, receivedBy: 'J. Smith', lines: [{ product: g.product.id, quantity: 10 }] });
  g.clock(D0, '11:00');
  g.cmd('tripReturned', { trip: out.id, lines: [{ product: g.product.id, quantity: 1 }] });
  g.clock(D2, '09:00');
  g.cmd('returnResolve', { trip: out.id, lines: [{ product: g.product.id, quantity: 1, outcome: 'STILL_ON_SITE' }] });
  const a = g.sim.siteAccount(g.site.id);
  assert.deepEqual([a.sent, a.back, a.onSite, a.unaccounted, a.missing], [11, 0, 11, 0, 11]);
  assert.equal(g.sim.repo.get(o.id, 'order').lines[0].delivered, 11, "the order's delivered line says so too");
  const h = g.sim.hire({ site: g.site.id, from: D0, to: D6 });
  assert.equal(h.sites.find((s) => s.id === g.site.id).pieces, 11);
  assert.equal(h.statement.lines[0].pieceDays, 11 * 3, 'all 11 on hire from the delivery day (D0 to today, D2)');
});

test('quarantine: never flipped, scrapped or retired like a stillage, never picked; a charge goes to the site the lot came from', (t) => {
  const f = liveFixture(t);
  f.cmd('productValue', { values: [{ product: f.product.id, replacementValue: 1000 }] });
  const { coll } = outAndBack(f, 10, 10);
  f.clock(D0, '14:00');
  f.cmd('tripReturned', { trip: coll.id, lines: [{ product: f.product.id, quantity: 8 }] });
  f.cmd('returnResolve', { trip: coll.id, lines: [{ product: f.product.id, quantity: 2, outcome: 'DAMAGED' }] });
  const q = f.sim.containers().find((c) => c.quarantine);
  assert.ok(q);
  const freeBefore = f.sim.orderItems(f.yard.id).items.find((i) => i.product === f.product.id).free;
  for (const [a, input] of [
    ['condition', { id: q.id, condition: 'SERVICEABLE', reason: 'looks fine' }],
    ['scrapContainer', { id: q.id, reason: 'Gone' }],
    ['retire', { id: q.id }],
  ])
    assert.throws(() => f.cmd(a, input), /That is the quarantine. Use Quarantine/, a);
  assert.equal(f.sim.repo.get(q.id, 'container').condition, 'QUARANTINED');
  // even a serviceable-looking quarantine is never picked from
  const flip = f.sim.repo.get(q.id, 'container');
  flip.condition = 'SERVICEABLE';
  f.sim.repo.save(flip);
  assert.equal(f.sim.orderItems(f.yard.id).items.find((i) => i.product === f.product.id).free, freeBefore);
  const big = f.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: freeBefore }] });
  assert.ok(!f.sim.repo.all('reservation').some((r) => r.container === q.id && r.active), 'no hold on quarantine');
  f.cmd('orderCancel', { id: big.order.id });
  // a charge goes to the lot's own site, never one named on the tap
  const manly = f.cmd('gameSite', { name: 'Manly' }).site;
  assert.throws(
    () => f.cmd('quarantineResolve', { product: f.product.id, quantity: 1, outcome: 'CHARGED', site: manly.id }),
    /did not come from Manly/,
  );
  const r = f.cmd('quarantineResolve', { product: f.product.id, quantity: 1, outcome: 'CHARGED' });
  assert.equal(r.charges.length, 1);
  assert.equal(r.charges[0].site, f.site.id);
  assert.deepEqual(
    charges(f).map((c) => [c.site_id, c.reason, c.unit_value, c.approved_by]),
    [[f.site.id, 'DAMAGED', 1000, null]],
  );
});

test('Needs you: a count that comes up short is a new item (a dismissal before it lapses); one item per booking; an hour after 5 pm', (t) => {
  const f = liveFixture(t);
  const { coll } = outAndBack(f, 10);
  f.clock(D0, '14:00');
  f.cmd('tripReturned', { trip: coll.id, countLater: true });
  f.clock(D0, '17:01');
  f.pass();
  const n1 = f.sim.needsYou(),
    item = n1.items.find((i) => i.kind === 'RETURN_SHORT');
  assert.match(item.words, /Not counted yet/);
  assert.equal(item.action.label, 'Count');
  f.cmd('needsYouDismiss', { id: item.id, reason: 'Kev counts it in the morning' });
  assert.equal(f.sim.needsYou().items.filter((i) => i.kind === 'RETURN_SHORT').length, 0);
  f.clock(D1, '08:00');
  f.cmd('returnCount', { trip: coll.id, lines: [{ product: f.product.id, quantity: 8 }] });
  const tr = f.sim.repo.get(coll.id, 'trip');
  assert.equal(tr.flag.code, 'RETURN_SHORT');
  assert.match(tr.flag.words, /^2 pieces not back from Bondi: say what happened to them$/);
  const n2 = f.sim.needsYou().items.filter((i) => i.kind === 'RETURN_SHORT');
  assert.equal(n2.length, 1, 'the shortfall is a new item, not hidden by the old dismissal');
  assert.notEqual(n2[0].id, item.id);
  assert.equal(n2[0].action.label, 'Sort it out');
  assert.equal(f.sim.tripView(tr).stateWords, 'Back at yard, 2 pieces not counted back');
  f.cmd('returnResolve', {
    trip: coll.id,
    lines: [{ product: f.product.id, quantity: 1, outcome: 'LOST', unitValue: 500 }],
  });
  const n3 = f.sim.needsYou().items.filter((i) => i.kind === 'RETURN_SHORT');
  assert.equal(n3.length, 1);
  assert.notEqual(n3[0].id, n2[0].id, 'one piece sorted: the fact changed again');
  assert.match(f.sim.repo.get(coll.id, 'trip').flag.words, /^1 piece not back/);
  f.cmd('returnResolve', { trip: coll.id, lines: [{ product: f.product.id, quantity: 1, outcome: 'DAMAGED' }] });
  assert.equal(f.sim.needsYou().items.filter((i) => i.kind === 'RETURN_SHORT').length, 0);

  // one item per booking: the clock's own "can't make it" wins over NO_DRIVER_YES
  const g = liveFixture(t);
  const bo = g.cmd('teamAdd', { name: 'Bo', role: 'DRIVER' }).person;
  const t2 = g.cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: g.yard.id, payload: 12500000 });
  const a = g.cmd('planTruck', { day: D1, time: '07:00', truck: g.truck.id, driver: g.team.Dave.id }).item;
  g.cmd('planTruck', { day: D1, time: '07:00', truck: t2.id, driver: bo.id });
  g.clock(D0, '09:05');
  g.pass();
  g.cmd('messageAnswer', { id: g.msgs(a.id)[0].id, yes: false, reason: 'Crook' });
  g.clock(D0, '17:05');
  g.pass();
  const n = g.sim.needsYou();
  assert.equal(n.count, 2, 'two bookings, two items');
  assert.deepEqual(n.items.map((i) => i.kind).sort(), ['CANT_MAKE_IT', 'NO_DRIVER_YES']);
  assert.equal(n.items.filter((i) => i.item === a.id).length, 1);
  // a truck booked after 5 pm for tomorrow: the ask gets an hour before "no yes" is a call to make
  const h = liveFixture(t);
  h.clock(D0, '21:10');
  h.cmd('planTruck', { day: D1, time: '07:00', truck: h.truck.id, driver: h.team.Dave.id });
  h.pass();
  assert.equal(h.sim.needsYou().count, 0, 'not the moment the ask goes out');
  h.clock(D0, '22:15');
  h.pass();
  assert.deepEqual(
    h.sim.needsYou().items.map((i) => i.kind),
    ['NO_DRIVER_YES'],
  );
});

test('money: a typed value is the owner’s call (company.manage), recorded as approved; anyone else gets the replacement value or a refusal', (t) => {
  const f = liveFixture(t);
  const { coll } = outAndBack(f, 10, 10);
  f.clock(D0, '14:00');
  f.cmd('tripReturned', { trip: coll.id, lines: [{ product: f.product.id, quantity: 6 }] });
  const gm = manager(f);
  assert.throws(
    () =>
      gm.cmd('returnResolve', {
        trip: coll.id,
        lines: [{ product: f.product.id, quantity: 1, outcome: 'LOST', unitValue: 0 }],
      }),
    /Only the owner can type a value/,
  );
  assert.throws(
    () => gm.cmd('returnResolve', { trip: coll.id, lines: [{ product: f.product.id, quantity: 1, outcome: 'LOST' }] }),
    /no replacement value yet/,
  );
  assert.throws(
    () => gm.cmd('productValue', { product: f.product.id, replacementValue: 1 }),
    (e) => e.status === 403,
  );
  const typed = f.cmd('returnResolve', {
    trip: coll.id,
    lines: [{ product: f.product.id, quantity: 1, outcome: 'LOST', unitValue: 4250 }],
  });
  assert.match(typed.message, /charged at \$42\.50/);
  f.cmd('productValue', { product: f.product.id, replacementValue: 1000 });
  const std = gm.cmd('returnResolve', {
    trip: coll.id,
    lines: [{ product: f.product.id, quantity: 1, outcome: 'LOST' }],
  });
  assert.match(std.message, /charged at \$10\.00/);
  assert.deepEqual(
    charges(f).map((c) => [c.unit_value, c.approved_by === f.user.id ? 'owner' : c.approved_by]),
    [
      [4250, 'owner'],
      [1000, null],
    ],
  );
  // the site-finish charge with a typed value: the owner only, recorded as approved
  const g = liveFixture(t);
  const { coll: c2 } = outAndBack(g, 10, 8);
  g.clock(D0, '14:00');
  g.cmd('tripReturned', { trip: c2.id });
  const gm2 = manager(g);
  assert.throws(
    () => gm2.cmd('siteFinish', { site: g.site.id, outcome: 'CHARGE', unitValues: { [g.product.id]: 100 } }),
    /Only the owner can type a value/,
  );
  g.cmd('siteFinish', { site: g.site.id, outcome: 'CHARGE', unitValues: { [g.product.id]: 100 } });
  assert.deepEqual(
    charges(g).map((c) => [c.reason, c.quantity, c.unit_value, c.approved_by === g.user.id]),
    [['SITE_FINISH', 2, 100, true]],
  );
  assert.equal(g.sim.siteAccount(g.site.id).unaccounted, 0);
});

test('dispatch: a packed booking still moves with the day (packed lists pack again); packed counts flow downstream; a "can’t make it" lane is first', (t) => {
  const f = liveFixture(t);
  const kev = phone(f, f.team.Kev),
    dave = phone(f, f.team.Dave);
  const tp = f.cmd('planTruck', { day: D1, time: '07:00', truck: f.truck.id, driver: f.team.Dave.id }).item;
  const list = f.cmd('planMaterials', {
    day: D1,
    time: '08:00',
    site: f.site.id,
    truckPlan: tp.id,
    lines: [{ product: f.product.id, quantity: 20 }],
    packer: f.team.Kev.id,
  }).item;
  // a fully held list is never "short"
  const v = f.sim.planItemView(f.item(list.id));
  assert.equal(v.lowWords, null);
  assert.equal(v.flags?.warn ?? false, false);
  const trip = f.sim.repo.all('trip')[0];
  // the yard packs 18 of the 20 the evening before
  f.clock(D0, '21:15');
  kev.cmd('packConfirmed', { trip: trip.id, lines: [{ product: f.product.id, quantity: 18 }] });
  const tv = f.sim.tripView(f.sim.repo.get(trip.id, 'trip'));
  assert.deepEqual([tv.lines[0].asked, tv.lines[0].packed], [20, 18], 'the packed count is on the line');
  assert.equal(f.item(tp.id).status, 'PLANNED', 'packed is still in the yard: the booking is not under way');
  assert.equal(f.sim.repo.get(trip.id, 'trip').steps.PACKED.kind, 'PERSON', "the yard hand's own tap");
  const lanes = f.sim.dispatchView({ day: D1 });
  assert.deepEqual(
    [lanes.lanes[0].trips[0].pieces, lanes.lanes[0].trips[0].asked, lanes.lanes[0].trips[0].packed],
    [18, 20, 18],
  );
  const sheet = f.sim.runSheet({ day: D1 });
  assert.deepEqual(
    [
      sheet.sheets[0].trips[0].lines[0].quantity,
      sheet.sheets[0].trips[0].lines[0].asked,
      sheet.sheets[0].trips[0].pieces,
    ],
    [18, 20, 18],
  );
  // the driver's phone starts Loaded from the packed count
  assert.equal(dave.me().trips.find((x) => x.id === trip.id).lines[0].packed, 18);
  // it pours at 6 am: the whole day moves, the packed list packs again
  f.clock(D1, '06:00');
  const moved = f.cmd('planMoveDay', { from: D1, to: D2 });
  assert.equal(moved.moved, 2);
  assert.match(moved.message, /Packed lists need packing again/);
  assert.equal(f.item(tp.id).day, D2);
  assert.equal(f.item(list.id).day, D2);
  assert.equal(f.item(list.id).truckPlan, tp.id, 'the list stays on its truck');
  const trips = f.sim.repo.all('trip').filter((x) => x.state !== 'CANCELLED');
  assert.equal(trips.length, 1);
  assert.equal(trips[0].state, 'BOOKED');
  // the office's Packed is recorded on behalf of the packer; Loaded & left with no numbers takes the packed count
  f.clock(D1, '16:00');
  f.cmd('packConfirmed', { trip: trips[0].id, lines: [{ product: f.product.id, quantity: 19 }] });
  const st = f.sim.repo.get(trips[0].id, 'trip').steps.PACKED;
  assert.deepEqual([st.kind, st.onBehalfOf], ['ON_BEHALF', f.team.Kev.id]);
  f.clock(D2, '07:05');
  f.cmd('tripLoaded', { trip: trips[0].id });
  assert.equal(f.sim.tripView(f.sim.repo.get(trips[0].id, 'trip')).lines[0].loaded, 19);
  assert.equal(f.item(tp.id).status, 'ACTIVE', 'a load leaving makes the booking under way');

  // a driver's "can't make it" puts the lane first before the day starts
  const g = liveFixture(t);
  const bo = g.cmd('teamAdd', { name: 'Bo', role: 'DRIVER' }).person;
  const t2 = g.cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: g.yard.id, payload: 12500000 });
  const a = g.cmd('planTruck', { day: D1, time: '07:00', truck: g.truck.id, driver: g.team.Dave.id }).item;
  const b = g.cmd('planTruck', { day: D1, time: '09:00', truck: t2.id, driver: bo.id }).item;
  for (const it of [a, b])
    g.cmd('planMaterials', {
      day: D1,
      time: it.time,
      site: g.site.id,
      truckPlan: it.id,
      lines: [{ product: g.product.id, quantity: 2 }],
    });
  g.clock(D0, '09:05');
  g.pass();
  g.cmd('messageAnswer', { id: g.msgs(b.id)[0].id, yes: false, reason: 'Crook' });
  const d = g.sim.dispatchView({ day: D1 });
  assert.equal(d.lanes[0].booking, b.id, 'the lane with the problem comes first');
  assert.deepEqual(
    [d.lanes[0].unconfirmed, d.lanes[0].trips[0].unconfirmed, d.lanes[0].trips[0].dotWords],
    [true, true, "Asked · can't make it"],
  );
  assert.deepEqual([d.lanes[1].unconfirmed, d.lanes[1].trips[0].dotWords], [false, 'Asked']);
});

test("the register's available is what the yard can send; intake details sit on the ledger row, with a cost per line", (t) => {
  const f = liveFixture(t);
  const o = f.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 10 }] }).order;
  const out = f.cmd('tripBook', { orders: [o.id], truck: f.truck.id, driver: f.team.Dave.id }).trip;
  f.clock(D0, '09:30');
  f.cmd('tripLoaded', { trip: out.id });
  f.clock(D0, '10:00');
  f.cmd('tripDelivered', { trip: out.id, receivedBy: 'J. Smith' });
  f.cmd('tripReturned', { trip: out.id });
  const reg = f.sim.snapshot().register.find((r) => r.product === f.product.id);
  assert.deepEqual([reg.quantity, reg.yard, reg.site, reg.available], [f.per * 3, f.per * 3 - 10, 10, f.per * 3 - 10]);
  assert.equal(reg.available, f.sim.orderItems(f.yard.id).items.find((i) => i.product === f.product.id).free);
  f.cmd('gameAddStock', {
    lines: [{ product: f.product.id, quantity: 5, unitCost: 4250 }],
    supplier: 'Acme Scaffold Supplies',
    reference: 'INV-2041',
    unitCost: 100,
  });
  const row = f.db
    .prepare("SELECT reason FROM ledger WHERE company_id=? AND event='PURCHASE' ORDER BY sequence DESC LIMIT 1")
    .get(f.company);
  assert.equal(row.reason, 'Stock added to the yard · Acme Scaffold Supplies · INV-2041 · $42.50 each');
  const intake = f.sim.repo.all('intake').at(-1);
  assert.deepEqual([intake.unitCost, intake.supplier, intake.reference], [4250, 'Acme Scaffold Supplies', 'INV-2041']);
});

test('the pages: packed counts on the docket, the run sheet and the phones; tomorrow’s gang and re-stack read-only; the phone groups by the day it left', async (t) => {
  const { loDocket, loExpected } = await import('../public/live-office.js');
  const { ltSheetHTML } = await import('../public/live-today.js');
  const { packCard, gangCard, taskCard, crewDay } = await import('../public/crew.js');
  const f = liveFixture(t);
  const kev = phone(f, f.team.Kev);
  f.cmd('teamUpdate', { id: f.team.Jo.id, role: 'LEADING_HAND' });
  const lee = phone(f, f.team.Jo);
  const tp = f.cmd('planTruck', { day: D1, time: '07:00', truck: f.truck.id, driver: f.team.Dave.id }).item;
  f.cmd('planMaterials', {
    day: D1,
    time: '08:00',
    site: f.site.id,
    truckPlan: tp.id,
    lines: [{ product: f.product.id, quantity: 20 }],
    packer: f.team.Kev.id,
  });
  f.cmd('planWorkers', { day: D1, time: '07:00', site: f.site.id, count: 2, people: [f.team.Jo.id, f.team.Sam.id] });
  f.cmd('planRestack', { day: D1, time: '10:00' });
  const trip = f.sim.repo.all('trip')[0];
  f.clock(D0, '21:15');
  kev.cmd('packConfirmed', { trip: trip.id, lines: [{ product: f.product.id, quantity: 18 }] });
  const tv = f.sim.tripView(f.sim.repo.get(trip.id, 'trip'));
  // the office docket: Sent shows the packed count (marked: not what was asked) until the truck leaves
  const docket = loDocket(tv);
  assert.match(docket, /<div class="lo-docket-wrap">/);
  assert.match(docket, /<td class="off">18<small>packed<\/small><\/td>/);
  assert.equal(loExpected(tv, 'tripLoaded').get(f.product.id), 18, 'Loaded & left starts from the packed count');
  assert.equal(loExpected(tv, 'packConfirmed').get(f.product.id), 20);
  // the printed run sheet: the packed count with asked beside it, the driver's mobile as people write it
  f.cmd('teamUpdate', { id: f.team.Dave.id, mobile: '0412 345 678' });
  const sheet = ltSheetHTML(f.sim.runSheet({ day: D1 }));
  assert.match(sheet, /18 × [^<]+ <small>\(asked 20\)<\/small>/);
  assert.match(sheet, /18 pieces · packed/);
  assert.match(sheet, /0412 345 678/);
  assert.doesNotMatch(sheet, /\+61/);
  // the yard hand's card after the tap: the packed count, with what was asked beside it
  const km = kev.me(),
    pc = packCard(
      km.packs.find((x) => x.id === trip.id),
      { me: km, pending: [] },
    );
  assert.match(pc, /<b class="cr-n">18<\/b>/);
  assert.match(pc, /Asked 20/);
  // the driver's phone keeps a packed trip under tomorrow
  const dave = phone(f, f.team.Dave);
  assert.equal(crewDay(dave.me().trips.find((x) => x.id === trip.id)), D1);
  // the leading hand and the yard hand see tomorrow the evening before, with no taps until the day
  const lm = lee.me();
  assert.deepEqual([lm.gang[0].dayWords, lm.gang[0].canSignOn], ['Tomorrow', false]);
  const gc = gangCard(lm.gang[0], { pending: [] });
  assert.match(gc, /Tomorrow · 0 of 2 said yes/);
  assert.match(gc, /On site is a tap on the day/);
  assert.doesNotMatch(gc, /data-cr-on=/);
  const tc = taskCard(km.tasks[0], { pending: [] });
  assert.match(tc, /Tomorrow · Top up/);
  assert.match(tc, /Done is a tap on the day/);
  assert.doesNotMatch(tc, /data-cr-done=/);
  // the Today list card in a real yard says who packed it and the count
  const list = f.sim.planDayItems(D1, 'MATERIALS')[0];
  assert.equal(f.sim.planItemView(list).words, 'Packed by Kev, 21:15 · 18 pieces');
});
