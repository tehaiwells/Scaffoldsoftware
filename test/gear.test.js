process.env.TZ = 'Australia/Sydney';
// Gear lists in the Practice yard (ADR 0012, the DEMO suite: it ticks). A list is a named MATERIALS booking with from -> to, exact lines,
// a day and a time, and the truck and driver booked in the same tap; it is on the calendar at once; the day before at 3 pm the driver is
// asked to be ready (and answers by himself, as every simulated person does); on the day the simulated crew packs and the truck autopilot
// drives, writing the chain's marks (kind ENGINE) on the item. An old-style Materials list is untouched by all of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planFixture, D0 } from './helpers/plan-fixture.js';
import { addDays } from '../src/domain/schedule.js';
import { chipOf } from '../public/plan-cal.js';
import { chainOf, nextArrival, chainWords } from '../src/domain/gear-chain.js';
import { LIVE_OPS } from '../src/domain/mode.js';
const D1 = addDays(D0, 1),
  D2 = addDays(D0, 2);
// a yard with stock, a site, a truck and Dave
function ready(t, opts = {}) {
  const f = planFixture(t, opts);
  const { p, per } = f.stock(3);
  const site = f.site('Bondi');
  const truck = f.trucks()[0];
  const dave = f.cmd('teamAdd', { name: 'Dave', role: 'DRIVER' }).person;
  return Object.assign(f, { p, per, bondi: site, truck1: truck, dave });
}
// the office says yes for everyone asked (the engine tests: simulated replies are off, so nothing depends on who a person happens to be)
const yesAll = (f) => {
  for (const m of f.sim.repo.all('message'))
    if (m.status === 'SENT' && m.needsAnswer) f.cmd('messageAnswer', { id: m.id, yes: true, via: 'OFFICE' });
};
const list = (f, extra = {}) =>
  f.cmd('gearListCreate', {
    from: { kind: 'yard' },
    to: { kind: 'site', id: f.bondi.id },
    lines: [{ product: f.p.id, quantity: f.per }],
    day: D1,
    time: '07:00',
    truck: f.truck1.id,
    driver: f.dave.id,
    ...extra,
  });

test("the chain (pure): the steps of each direction in order, the owner's words, the next arrival", () => {
  assert.deepEqual(
    chainOf('OUT', {}, { from: 'the yard', to: 'Bondi' }).map((c) => c.words),
    ['Arrived at yard', 'Packed', 'Loaded', 'Arrived at Bondi', 'Landed'],
  );
  assert.deepEqual(
    chainOf('MOVE', {}, { from: 'Bondi', to: 'Manly' }).map((c) => c.words),
    ['Arrived at Bondi', 'Loaded', 'Arrived at Manly', 'Landed'],
  );
  assert.deepEqual(
    chainOf('BACK', {}, { from: 'Bondi', to: 'the yard' }).map((c) => c.words),
    ['Arrived at Bondi', 'Loaded', 'Arrived at yard', 'Back at yard'],
  );
  const m = { at: '2026-10-14T07:00:00Z', byName: 'Dave', kind: 'PERSON' };
  assert.equal(chainOf('OUT', { LOADED: m }, {})[2].done, true);
  assert.equal(chainOf('OUT', { LOADED: m }, {})[2].byName, 'Dave');
  assert.equal(nextArrival('OUT', {}), 'ARRIVED_PICKUP', 'before it leaves: arrive at the yard');
  assert.equal(nextArrival('OUT', { ARRIVED_PICKUP: m }), null, 'arrived, not left: nothing more to arrive at');
  assert.equal(nextArrival('OUT', { LOADED: m }), 'ARRIVED_DROP', 'loaded: the next arrival is the site');
  assert.equal(nextArrival('OUT', { LOADED: m, DELIVERED: m }), null);
  assert.equal(nextArrival('BACK', { COLLECTED: m }), 'ARRIVED_DROP');
  assert.equal(chainWords('BACK', 'ARRIVED_DROP', { from: 'Bondi', to: 'the yard' }), 'Arrived at yard');
  assert.equal(chainWords('MOVE', 'ARRIVED_PICKUP', { from: 'Bondi', to: 'Manly' }), 'Arrived at Bondi');
  for (const a of ['gearListCreate', 'gearListUpdate', 'tripArrived'])
    assert.ok(LIVE_OPS.has(a), a + ' is on the LIVE allow-list');
});

test('from and to: yard -> site, site -> site, site -> yard; yard -> yard and the same site twice are refused; the default name', (t) => {
  const f = ready(t);
  const manly = f.site('Manly');
  const out = list(f);
  assert.equal(out.item.direction, 'OUT');
  assert.equal(out.item.name, 'Bondi gear', 'named after where it goes');
  assert.equal(out.item.from.name, 'the yard');
  assert.equal(out.item.to.name, 'Bondi');
  assert.match(out.message, /^Bondi gear on Wed 14 Oct at 7:00 am\. T-01 with Dave booked\.$/);
  const truck2 = f.cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: f.yard.id });
  const move = list(f, {
    from: { kind: 'site', id: f.bondi.id },
    to: { kind: 'site', id: manly.id },
    truck: truck2.id,
    driver: null,
    name: ' Manly  move ',
  });
  assert.equal(move.item.direction, 'MOVE');
  assert.equal(move.item.name, 'Manly move', 'as typed, tidied');
  assert.equal(move.item.from.name, 'Bondi');
  assert.equal(move.item.to.name, 'Manly');
  assert.equal(move.item.site, manly.id, "the item's site is where it goes");
  const back = list(f, {
    from: { kind: 'site', id: f.bondi.id },
    to: { kind: 'yard' },
    truck: null,
    driver: null,
    day: D2,
  });
  assert.equal(back.item.direction, 'BACK');
  assert.equal(back.item.name, 'Yard gear');
  assert.equal(back.item.site, f.bondi.id, "a bring-back's site is where it comes from (as before)");
  assert.throws(() => list(f, { from: { kind: 'yard' }, to: { kind: 'yard' }, day: D2 }), /Choose a site/);
  assert.throws(
    () => list(f, { from: { kind: 'site', id: f.bondi.id }, to: { kind: 'site', id: f.bondi.id }, day: D2 }),
    /two different sites/,
  );
  assert.throws(() => list(f, { lines: [], day: D2 }), /material/i);
  assert.throws(() => list(f, { name: 'x'.repeat(61), day: D2, truck: null }), /60 characters/);
  // the calendar chip: the name, the time and an arrow by direction
  assert.equal(chipOf(out.item).label, 'Bondi gear · 7:00 am → Bondi');
  assert.equal(chipOf(move.item).label, 'Manly move · 7:00 am Bondi → Manly');
  assert.equal(chipOf(back.item).label, 'Yard gear · 7:00 am ← Bondi');
  assert.equal(
    chipOf({ type: 'MATERIALS', siteName: 'Bondi' }).label,
    'List → Bondi',
    "an old list's chip is as it was",
  );
  // on the calendar the moment it is confirmed (both modes read planMonth)
  const month = f.sim.planMonth(D1.slice(0, 7));
  const mine = month.items.filter((i) => i.gear);
  assert.equal(mine.length, 3);
  assert.equal(mine.find((i) => i.id === out.item.id).chain.length, 5);
  assert.ok(mine.every((i) => i.day >= D1 && i.time === '07:00'));
});

test('the truck and driver: an existing booking is linked (never booked twice), another driver named on it is refused, hire is DEMO only, no truck says so', (t) => {
  const f = ready(t);
  const bill = f.cmd('teamAdd', { name: 'Bill', role: 'DRIVER' }).person;
  const tp = f.cmd('planTruck', { day: D1, time: '07:00', truck: f.truck1.id, driver: f.dave.id }).item;
  const a = list(f);
  assert.equal(a.item.truckPlan, tp.id, 'linked to the booking that day');
  assert.equal(f.sim.planDayItems(D1, 'TRUCK').length, 1, 'still one truck booking');
  assert.throws(() => list(f, { driver: bill.id }), /T-01 is booked with Dave that day\. Change the driver on Today\./);
  // a booking with no driver named: the list's driver is asked on it
  const truck2 = f.cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: f.yard.id });
  const tp2 = f.cmd('planTruck', { day: D1, time: '08:00', truck: truck2.id }).item;
  const b = list(f, { truck: truck2.id, driver: bill.id, time: '08:00' });
  assert.equal(b.item.truckPlan, tp2.id);
  assert.equal(f.item(tp2.id).driver, bill.id, 'Bill was named on the booking');
  assert.equal(b.item.truckItem.driverName, 'Bill');
  // a hire truck: the Practice yard only; a new booking is made for it
  const h = list(f, { truck: 'HIRE:SMALL', driver: null, day: D2 });
  assert.equal(f.item(h.item.truckPlan).hire.size, 'SMALL');
  assert.equal(h.item.truckItem.truckName, 'a small hire truck');
  // no truck: the list says so in red until one is booked
  const n = list(f, { truck: null, driver: null, day: D2 });
  assert.equal(n.item.truckItem, null);
  assert.equal(n.item.words, 'Needs a truck');
  assert.equal(n.item.flags.red, true);
  assert.match(n.message, /No truck yet\./);
  // a list for the half hour that has begun: it is due now, and its truck is booked at the next time still ahead
  f.clock(D2, '07:10');
  const truck4 = f.cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: f.yard.id });
  const nowish = list(f, { truck: truck4.id, driver: null, day: D2, time: '07:00' });
  assert.equal(nowish.item.time, '07:00');
  assert.equal(f.item(nowish.item.truckPlan).time, '07:30');
  f.clock(D0, '09:00');
  // a truck can be given later (gearListUpdate), and the name changed
  const truck3 = f.cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: f.yard.id });
  const u = f.cmd('gearListUpdate', { id: n.item.id, truck: truck3.id, driver: f.dave.id, name: 'Bondi extras' });
  assert.equal(u.item.name, 'Bondi extras');
  assert.equal(u.item.truckItem.driverName, 'Dave');
  assert.equal(u.item.words !== 'Needs a truck', true);
  assert.equal(f.cmd('gearListUpdate', { id: n.item.id, name: 'Bondi extras' }).message, 'Nothing changed.');
});

test('the day before at 3 pm the driver is asked to be ready and answers by himself; the day-of notice at 6 am; a no flags the list and the truck', (t) => {
  const f = ready(t);
  const r = list(f);
  const it = () => f.item(r.item.id);
  f.clock(D0, '14:59');
  f.pass();
  assert.equal(it().driverAsk, null, 'not before 3 pm');
  f.clock(D0, '15:00');
  f.pass();
  const ask = f.sim.repo.get(it().driverAsk, 'message');
  assert.equal(ask.subject, 'READY');
  assert.equal(ask.status, 'SENT');
  assert.equal(ask.needsAnswer, true);
  assert.match(
    ask.text,
    /^Hi Dave, T-01 for Bondi gear tomorrow at 7:00 am \(the yard → Bondi\)\. Confirm you'll be ready\? – /,
  );
  assert.equal(f.sim.planItemView(it()).readyAsk.answer, 'WAITING');
  assert.equal(f.sim.planItemView(it()).flags.needsAnswer, true);
  // the simulated answer, after its fixed delay (the same person, day and subject always answer the same way)
  f.clock(D0, '15:02');
  f.pass();
  const answered = f.sim.repo.get(ask.id, 'message');
  assert.ok(['YES', 'NO'].includes(answered.status), 'Dave answered by himself');
  assert.equal(answered.answer.via, 'SIMULATED');
  // the day of: the notice at 6 am (Got it, never an answer)
  f.clock(D1, '05:59');
  f.pass();
  assert.equal(it().dayNotice, null);
  f.clock(D1, '06:00');
  f.pass();
  const notice = f.sim.repo.get(it().dayNotice, 'message');
  assert.equal(notice.subject, 'DAY');
  assert.equal(notice.needsAnswer, false);
  assert.match(notice.text, /^Today: Bondi gear at 7:00 am, the yard → Bondi\. Tap each step on your phone\./);
  f.clock(D1, '06:02');
  f.pass();
  assert.ok(f.sim.repo.get(notice.id, 'message').seenAt, 'the simulated driver saw it');
  assert.throws(() => f.cmd('messageAnswer', { id: notice.id, yes: true, via: 'OFFICE' }), /Tap Got it/);
});

test('READY = no: the list and the truck booking say so; a new driver is asked again; a list made after 3 pm is asked at once, after 6 am never', (t) => {
  const f = ready(t);
  f.cmd('planReplies', { on: false }); // the answers here are the office's (a simulated no to the truck's own ask would say other words)
  const r = list(f);
  f.clock(D0, '15:00');
  f.pass();
  const ask = f.sim.repo.get(f.item(r.item.id).driverAsk, 'message');
  f.cmd('messageAnswer', { id: ask.id, yes: false, reason: 'Ute is in for a service', via: 'OFFICE' });
  f.pass();
  assert.equal(f.item(r.item.id).problem, "Dave can't make it: Ute is in for a service. Pick another driver.");
  assert.equal(f.item(r.item.truckPlan).problem, "Dave can't make it: Ute is in for a service. Pick another driver.");
  assert.equal(f.sim.planItemView(f.item(r.item.id)).flags.red, true);
  // another driver on the booking: the old ask is called off, the new driver gets READY (still before 6 am)
  const bill = f.cmd('teamAdd', { name: 'Bill', role: 'DRIVER' }).person;
  f.cmd('planAsk', { item: r.item.truckPlan, person: bill.id });
  f.clock(D0, '15:10');
  f.pass();
  assert.equal(f.sim.repo.get(ask.id, 'message').status, 'CALLED_OFF');
  const again = f.sim.repo.get(f.item(r.item.id).driverAsk, 'message');
  assert.equal(again.person, bill.id);
  assert.equal(again.subject, 'READY');
  assert.equal(f.item(r.item.id).problem, null, 'the no went with the driver');
  assert.equal(f.item(r.item.truckPlan).readyNo, null);
  // a list confirmed after 3 pm the day before: asked at once
  const truck2 = f.cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: f.yard.id });
  const late = list(f, { truck: truck2.id, driver: f.dave.id, time: '09:00' });
  f.pass();
  assert.equal(f.sim.repo.get(f.item(late.item.id).driverAsk, 'message').status, 'SENT');
  // one confirmed after 6 am on its day: never asked late, "not asked in time" instead
  f.clock(D1, '06:30');
  const truck3 = f.cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: f.yard.id }),
    cal = f.cmd('teamAdd', { name: 'Cal', role: 'DRIVER' }).person;
  const tooLate = list(f, { truck: truck3.id, driver: cal.id, time: '10:00', day: D1 });
  f.pass();
  assert.equal(f.item(tooLate.item.id).driverAsk, null);
  assert.ok(f.item(tooLate.item.id).readyNotAsked);
  // made this morning: no day-before ask could ever have gone, so nothing is flagged or said (the day notice goes as usual)
  assert.ok(!f.item(tooLate.item.id).log.some((l) => /Not asked in time/.test(l.text)));
  assert.ok(!f.sim.repo.all('notification').some((n) => n.body === "Cal wasn't asked about Bondi gear. Call them."));
  assert.ok(f.item(tooLate.item.id).dayNotice, "today's run is still sent");
});

test('on the day the simulated crew packs and the truck drives: the chain fills, one ENGINE mark per dot, the task is told each step', (t) => {
  const f = ready(t);
  f.cmd('planReplies', { on: false });
  const calls = [];
  f.sim.taskListSync = (id, step, now, mark) => calls.push([id, step, mark?.kind ?? null]); // CREW's hook, recorded
  const r = list(f);
  f.clock(D0, '15:00');
  f.pass();
  yesAll(f);
  f.clock(D1, '06:01');
  f.pass();
  const packing = f.item(r.item.id);
  assert.ok(
    ['PACKING', 'PACKED'].includes(packing.stage),
    'the day has begun: the office packs it (yard jobs are off in this fixture)',
  );
  assert.deepEqual(calls.at(0), [r.item.id, 'RECEIVED', 'ENGINE'], 'the crew has the list');
  f.clock(D1, '07:01');
  assert.ok(
    f.until(() => f.item(r.item.id).status === 'DONE', 3000),
    'delivered by the engine',
  );
  const done = f.item(r.item.id);
  assert.deepEqual(Object.keys(done.chain).sort(), ['ARRIVED_DROP', 'ARRIVED_PICKUP', 'DELIVERED', 'LOADED', 'PACKED']);
  assert.ok(Object.values(done.chain).every((m) => m.kind === 'ENGINE' && m.at));
  assert.deepEqual(
    calls.map((c) => c[1]),
    ['RECEIVED', 'PACKED', 'LOADED'],
    'the task hears received, packed and loaded, in that order, once each',
  );
  const v = f.sim.planItemView(done);
  assert.equal(v.chain.filter((c) => c.done).length, 5);
  assert.equal(
    v.chain.map((c) => c.words).join(' · '),
    'Arrived at yard · Packed · Loaded · Arrived at Bondi · Landed',
  );
  assert.equal(f.piecesAt(f.bondi.id, f.p.id), f.per, 'the stock is at Bondi: it drove there');
});

test('site -> yard and site -> site in the Practice yard: the truck fetches it (stock never teleports), the chain fills, the ledger has the lifts', (t) => {
  const f = ready(t);
  f.cmd('planReplies', { on: false });
  const manly = f.site('Manly');
  f.cmd('gameSend', { site: f.bondi.id, lines: [{ product: f.p.id, quantity: f.per * 2 }] });
  assert.ok(f.until(() => f.piecesAt(f.bondi.id, f.p.id) >= f.per * 2 && f.trucks().every((x) => !x.game), 6000));
  const move = list(f, { from: { kind: 'site', id: f.bondi.id }, to: { kind: 'site', id: manly.id }, time: '07:00' });
  const truck2 = f.cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: f.yard.id });
  const back = list(f, {
    from: { kind: 'site', id: f.bondi.id },
    to: { kind: 'yard' },
    truck: truck2.id,
    driver: null,
    time: '07:00',
  });
  f.clock(D0, '15:00');
  f.pass();
  yesAll(f);
  const ledgerBefore = f.db.prepare('SELECT COUNT(*) n FROM ledger WHERE company_id=?').get(f.user.company_id).n;
  f.clock(D1, '07:01');
  assert.ok(f.until(() => f.item(move.item.id).status === 'DONE' && f.item(back.item.id).status === 'DONE', 8000));
  const m = f.item(move.item.id),
    b = f.item(back.item.id);
  assert.deepEqual(Object.keys(m.chain).sort(), ['ARRIVED_DROP', 'ARRIVED_PICKUP', 'COLLECTED', 'DELIVERED']);
  assert.deepEqual(Object.keys(b.chain).sort(), ['ARRIVED_DROP', 'ARRIVED_PICKUP', 'COLLECTED', 'RETURNED']);
  assert.equal(m.stage, 'DELIVERED');
  assert.equal(b.stage, 'RETURNED');
  assert.equal(f.piecesAt(manly.id, f.p.id), f.per, 'one stillage moved Bondi -> Manly');
  assert.equal(f.piecesAt(f.bondi.id, f.p.id), 0, 'and one came back to the yard');
  assert.equal(f.piecesAt(f.yard.id, f.p.id), f.per * 2);
  assert.ok(
    f.db.prepare('SELECT COUNT(*) n FROM ledger WHERE company_id=?').get(f.user.company_id).n > ledgerBefore,
    'the moves are ledger rows',
  );
  assert.equal(f.sim.planItemView(b).words, 'Back at yard');
  assert.ok(
    f.trucks().every((x) => !x.game && x.status === 'AT_YARD'),
    'the trucks are home',
  );
});

test('an old-style Materials list is untouched: no name, no chain, no READY ask; a gear list moved to another day is asked again for that day', (t) => {
  const f = ready(t);
  const old = f.cmd('planMaterials', {
    day: D1,
    time: '07:00',
    site: f.bondi.id,
    lines: [{ product: f.p.id, quantity: f.per }],
  });
  assert.equal(old.item.gear, undefined);
  assert.equal(old.item.chain, undefined);
  assert.equal(chipOf(old.item).label, 'List → Bondi');
  const r = list(f, { time: '08:00' });
  f.clock(D0, '15:00');
  f.pass();
  assert.equal(f.item(old.item.id).driverAsk, undefined, 'never asked to be ready');
  const ask = f.sim.repo.get(f.item(r.item.id).driverAsk, 'message');
  assert.equal(ask.status, 'SENT');
  f.cmd('gearListUpdate', { id: r.item.id, day: D2 });
  assert.equal(f.sim.repo.get(ask.id, 'message').status, 'CALLED_OFF', "the old day's ask is off");
  assert.equal(f.item(r.item.id).driverAsk, null);
  assert.equal(f.item(r.item.id).truckPlan, null, 'the truck booking stayed on its day');
  f.clock(D1, '15:00');
  f.pass();
  assert.equal(f.item(r.item.id).driverAsk, null, 'no truck on the new day: nobody to ask');
  const truck2 = f.cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: f.yard.id });
  f.cmd('gearListUpdate', { id: r.item.id, truck: truck2.id, driver: f.dave.id });
  f.pass();
  assert.equal(f.sim.repo.get(f.item(r.item.id).driverAsk, 'message').day, D2, 'asked for the new day');
  // cancelling calls the ask off and tells the task
  const calls = [];
  f.sim.taskListSync = (id, step) => calls.push(step);
  f.cmd('planCancel', { id: r.item.id });
  assert.deepEqual(calls, ['CANCELLED']);
  assert.equal(f.sim.repo.get(f.item(r.item.id).driverAsk, 'message').status, 'CALLED_OFF');
});
