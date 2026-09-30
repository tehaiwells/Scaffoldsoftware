process.env.TZ = 'Australia/Sydney';
// The LIVE Today suite (ADR 0010, audit #33 and §7.3): a booking is an instruction that waits for people. Nothing here ticks; every
// state change comes from a person's own tap (their phone) or the office's entry for them, and the clock only asks and flags. The last
// test is the probe: a full booked day under 3 days of clock passes shows no simulated answer, no auto-pack, no driverless trip and no
// teleport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { atomic } from '../src/database.js';
import { Simulation } from '../src/simulation.js';
import { LIVE_OPS } from '../src/domain/mode.js';
import { addDays } from '../src/domain/schedule.js';
import { CREW_PHONE_OPS } from '../src/domain/dispatch.js';
import { crewLink, crewClaim, crewAuthenticate } from '../src/crew-auth.js';
import { liveFixture, records, D0 } from './helpers/live-fixture.js';
const D1 = addDays(D0, 1),
  D2 = addDays(D0, 2),
  D3 = addDays(D0, 3);
// A person's phone: a link made by the office, claimed on the phone; a Simulation as that device sign-in.
function phone(f, person) {
  const made = crewLink(f.auth, f.user, { person: person.id });
  const claimed = crewClaim(f.auth, { token: made.token, label: 'Test phone' });
  const user = crewAuthenticate(f.db, claimed.token);
  const sim = new Simulation(f.db, user);
  return { user, sim, cmd: (a, i = {}, key = randomUUID()) => sim.execute(a, i, key), me: () => sim.crewMe() };
}
const ledger = (f) => f.db.prepare('SELECT * FROM ledger WHERE company_id=? ORDER BY sequence').all(f.company);
const lee = (f) => f.cmd('teamAdd', { name: 'Lee', role: 'LEADING_HAND' }).person;

test('the dispatch commands are on the LIVE allow-list and refused in the Practice yard; drafts too', (t) => {
  const f = liveFixture(t);
  for (const a of [
    'planRestack',
    'planSend',
    'planDone',
    'planMoveDay',
    'planCopyCrews',
    'crewSignOn',
    'needsYouDismiss',
  ])
    assert.ok(LIVE_OPS.has(a), a);
  const demo = new Simulation(f.db, f.owner),
    dcmd = (a, i) => demo.execute(a, i, randomUUID());
  for (const a of ['planSend', 'planDone', 'planMoveDay', 'planCopyCrews', 'crewSignOn'])
    assert.throws(
      () => dcmd(a, { id: 'x', from: D1, to: D2, item: 'x' }),
      (e) => e.status === 409 && /real yard/.test(e.message),
      a,
    );
  const { yard } = dcmd('gameStart', { size: 'S' });
  const dt = dcmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: yard.id });
  assert.throws(
    () => dcmd('planTruck', { day: D1, time: '07:00', truck: dt.id, draft: true }),
    /Drafts are for your real yard/,
  );
  assert.equal(
    dcmd('planTruck', { day: D1, time: '07:00', truck: dt.id }).item.status,
    'PLANNED',
    'the Practice yard books as before',
  );
  assert.deepEqual([...CREW_PHONE_OPS].sort(), [
    'crewSignOn',
    'messageAnswer',
    'messageSeen',
    'packConfirmed',
    'planDone',
    'returnCount',
    'taskDone',
    'taskStep',
    'tripCollected',
    'tripDelivered',
    'tripLoaded',
    'tripReturned',
  ]);
});

test('DRAFT: planned and sent to nobody (no ask, no order, nothing held) until Send; then the asks go out and the order holds', (t) => {
  const f = liveFixture(t);
  const truck = f.cmd('planTruck', { day: D1, time: '07:00', truck: f.truck.id, driver: f.team.Dave.id, draft: true });
  assert.equal(truck.item.status, 'DRAFT');
  assert.match(truck.message, /drafted .* Nobody is asked/);
  assert.equal(f.msgs(truck.item.id).length, 0, 'no ask for a draft');
  const list = f.cmd('planMaterials', {
    day: D1,
    time: '08:00',
    site: f.site.id,
    lines: [{ product: f.product.id, quantity: 12 }],
    truckPlan: truck.item.id,
    draft: true,
  });
  assert.equal(list.item.status, 'DRAFT');
  assert.equal(f.sim.repo.all('order').length, 0, 'no order for a draft');
  assert.equal(f.sim.repo.all('reservation').length, 0, 'nothing held for a draft');
  const crew = f.cmd('planWorkers', {
    day: D1,
    time: '07:00',
    site: f.site.id,
    count: 2,
    people: [f.team.Jo.id, f.team.Sam.id],
    draft: true,
  });
  const task = f.cmd('planRestack', { day: D1, time: '09:00', draft: true });
  // the clock passes 3 pm the day before and the whole of the day: a draft is never asked, never flagged
  for (const [d, hm] of [
    [D0, '15:05'],
    [D1, '06:30'],
    [D1, '12:00'],
    [D1, '17:30'],
  ]) {
    f.clock(d, hm);
    f.pass();
  }
  for (const it of [truck, list, crew, task]) {
    const x = f.item(it.item.id);
    assert.equal(x.status, 'DRAFT', it.item.type + ' stays a draft');
    assert.equal(f.msgs(x.id).length, 0, it.item.type + ': nobody was asked');
  }
  // a draft truck carries no trip and its list cannot be sent before it
  const o = f.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 1 }] }).order;
  assert.throws(() => f.cmd('tripBook', { orders: [o.id], truckPlan: truck.item.id }), /still a draft/);
  f.cmd('orderCancel', { id: o.id });
  f.clock(D0, '10:00');
  f.cmd('planMove', { id: truck.item.id, day: D2 });
  assert.equal(f.item(truck.item.id).status, 'DRAFT', 'a moved draft is still a draft');
  f.cmd('planMove', { id: truck.item.id, day: D1 });
  assert.throws(() => f.cmd('planSend', { id: list.item.id }), /still a draft. Send it first/);
  // Send: the truck's driver is asked now; the list makes its order on that truck's trip; the workers get their 3 pm message; the task waits
  const sent = f.cmd('planSend', { id: truck.item.id });
  assert.equal(sent.item.status, 'PLANNED');
  assert.match(sent.message, /Dave has been asked/);
  assert.equal(f.msgs(truck.item.id)[0].status, 'SENT');
  const sl = f.cmd('planSend', { id: list.item.id });
  assert.equal(sl.item.status, 'PLANNED');
  const order = f.sim.repo.all('order').find((o) => o.planItem === list.item.id);
  assert.ok(order && order.status === 'BOOKED', 'its order, on the truck');
  assert.equal(f.sim.repo.all('reservation').filter((r) => r.active && r.order === order.id).length, 1, 'held now');
  assert.equal(f.sim.repo.all('trip')[0].truckPlan, truck.item.id);
  f.cmd('planSend', { id: crew.item.id });
  assert.equal(f.item(crew.item.id).stage, 'BOOKED');
  f.cmd('planSend', { id: task.item.id });
  assert.equal(f.item(task.item.id).status, 'PLANNED');
  assert.throws(() => f.cmd('planSend', { id: task.item.id }), /already sent/);
  // a draft can be cancelled
  const d2 = f.cmd('planRestack', { day: D2, time: '09:00', draft: true });
  f.cmd('planCancel', { id: d2.item.id });
  assert.equal(f.item(d2.item.id).status, 'CANCELLED');
  // the Today view says so
  const v = f.sim.planMonth(D1.slice(0, 7)).items.find((i) => i.id === truck.item.id);
  assert.equal(v.flags.draft, false);
  assert.equal(v.canSend, false);
});

test("the driver's own yes from their phone (via PHONE, the person's own); never another driver's ask; the office's stays ON_BEHALF", (t) => {
  const f = liveFixture(t);
  const mick = f.cmd('teamAdd', { name: 'Mick', role: 'DRIVER' }).person;
  const b = f.cmd('planTruck', { day: D1, time: '07:00', truck: f.truck.id, driver: f.team.Dave.id }).item;
  const ask = f.msgs(b.id)[0];
  assert.equal(ask.status, 'SENT');
  const dave = phone(f, f.team.Dave),
    other = phone(f, mick);
  const me = dave.me();
  assert.equal(me.person.kind, 'driver');
  assert.deepEqual(me.can, { trips: true, asks: true, packs: false, signOn: false, done: false, tasks: false });
  const shown = me.asks.find((a) => a.id === ask.id);
  assert.ok(
    shown && shown.canAnswer && shown.subject === 'DRIVE',
    "the phone shows the ask with I'll be there / Can't make it",
  );
  assert.throws(
    () => other.cmd('messageAnswer', { id: ask.id, yes: true }),
    (e) => e.status === 404,
    "another driver's phone: not found",
  );
  assert.throws(
    () => other.cmd('messageSeen', { id: ask.id }),
    (e) => e.status === 404,
  );
  const r = dave.cmd('messageAnswer', { id: ask.id, yes: true });
  assert.equal(r.message, 'Thanks. See you there.');
  const m = f.sim.repo.get(ask.id, 'message');
  assert.equal(m.status, 'YES');
  assert.equal(m.answer.via, 'PHONE', "the person's own answer");
  assert.equal(m.answer.by, dave.user.id);
  assert.equal(f.item(b.id).stage, 'READY');
  assert.ok(f.item(b.id).log.some((l) => l.text === 'Dave said yes.'));
  assert.equal(dave.me().asks.find((a) => a.id === ask.id)?.answer, 'YES');
  // the office answering for someone: recorded as before (via OFFICE, on behalf)
  const b2 = f.cmd('planTruck', { day: D2, time: '07:00', truck: f.truck.id, driver: mick.id }).item;
  const r2 = f.cmd('messageAnswer', { id: f.msgs(b2.id)[0].id, yes: false, reason: 'Crook' });
  assert.match(r2.message, /Got it/);
  assert.equal(f.sim.repo.get(f.msgs(b2.id)[0].id, 'message').answer.via, 'OFFICE');
  // a phone answers only what a phone may: the office's commands are refused
  assert.throws(
    () => dave.cmd('planTruck', { day: D3, time: '07:00', truck: f.truck.id }),
    (e) => e.status === 403,
  );
  assert.throws(
    () => dave.cmd('planMoveDay', { from: D1, to: D2 }),
    (e) => e.status === 403,
  );
  // too late to answer from a phone once the time has come
  const b3 = f.cmd('planTruck', { day: D3, time: '07:00', truck: f.truck.id, driver: f.team.Dave.id }).item;
  f.clock(D3, '07:01');
  assert.throws(() => dave.cmd('messageAnswer', { id: f.msgs(b3.id)[0].id, yes: true }), /Too late to answer/);
});

test('no trip leaves without a named driver; "next free truck" is a suggestion only', (t) => {
  const f = liveFixture(t);
  const b = f.cmd('planTruck', { day: D1, time: '07:00', truck: f.truck.id }).item;
  assert.equal(b.driver, null);
  const o = f.cmd('orderCreate', {
    site: f.site.id,
    lines: [{ product: f.product.id, quantity: 5 }],
    neededOn: D1,
  }).order;
  // an order waiting: the dispatch view suggests a truck, and books nothing
  const dv = f.sim.dispatchView({ day: D1 });
  assert.equal(dv.waiting.length, 1);
  assert.equal(dv.waiting[0].suggestedTruck.truck, f.truck.id);
  assert.equal(dv.waiting[0].suggestedTruck.why, 'booked, no driver yet');
  assert.equal(f.sim.repo.get(o.id, 'order').status, 'OPEN', 'suggested, not booked');
  const trip = f.cmd('tripBook', { orders: [o.id], truckPlan: b.id }).trip;
  f.clock(D1, '07:10');
  assert.throws(() => f.cmd('tripLoaded', { trip: trip.id }), /No driver is named on this truck booking/);
  assert.equal(f.sim.repo.get(trip.id, 'trip').state, 'BOOKED', 'nothing left');
  f.cmd('planAsk', { item: b.id, person: f.team.Dave.id });
  const loaded = f.cmd('tripLoaded', { trip: trip.id });
  assert.equal(loaded.trip.state, 'LOADED');
  assert.equal(
    f.sim.repo.get(f.msgs(b.id)[0].id, 'message').status,
    'YES',
    'a trip that left answers the ask yes (the driver drove it)',
  );
  // nothing to suggest once every truck is booked and no order waits
  assert.equal(f.sim.dispatchView({ day: D1 }).waiting.length, 0);
});

test("workers answer themselves; arrival is a leading hand's or the office's On site tap, never the clock; Done closes the day", (t) => {
  const f = liveFixture(t);
  const l = lee(f);
  const it = f.cmd('planWorkers', {
    day: D1,
    time: '07:00',
    site: f.site.id,
    count: 2,
    people: [f.team.Jo.id, l.id],
  }).item;
  f.clock(D0, '15:02');
  f.pass();
  const asks = f.msgs(it.id);
  assert.equal(asks.length, 2);
  const jo = phone(f, f.team.Jo),
    leeP = phone(f, l);
  assert.equal(jo.me().person.role, 'SCAFFOLDER');
  assert.equal(leeP.me().can.signOn, true);
  assert.equal(jo.me().can.signOn, false);
  jo.cmd('messageAnswer', { id: asks.find((m) => m.person === f.team.Jo.id).id, yes: true });
  leeP.cmd('messageAnswer', { id: asks.find((m) => m.person === l.id).id, yes: true });
  assert.ok(asks.every((m) => f.sim.repo.get(m.id, 'message').answer?.via === 'PHONE'));
  // the day begins and the start time passes: nobody is moved by the clock
  for (const hm of ['06:00', '07:00', '07:30', '09:00']) {
    f.clock(D1, hm);
    f.pass();
  }
  let x = f.item(it.id);
  assert.ok(
    x.people.every((p) => !p.moved),
    'nobody teleported',
  );
  assert.ok(!x.log.some((r) => / is at /.test(r.text)));
  assert.equal(x.status, 'ACTIVE');
  assert.ok(!f.sim.repo.all('resource').some((r) => r.away), 'no worker record was moved');
  // Jo cannot sign the gang on; Lee (the leading hand on it) can, from their phone: the person's own tap
  assert.throws(() => jo.cmd('crewSignOn', { item: it.id }), /Only the leading hand/);
  const gang = leeP.me().gang;
  assert.equal(gang.length, 1);
  assert.equal(gang[0].item, it.id);
  assert.ok(gang[0].canSignOn);
  const on = leeP.cmd('crewSignOn', { item: it.id });
  assert.match(on.message, /Jo, Lee signed on at Bondi|Lee, Jo signed on at Bondi/);
  x = f.item(it.id);
  assert.ok(x.people.every((p) => p.moved && p.signOn.kind === 'PERSON' && p.signOn.byName === 'Lee'));
  assert.equal(x.stage, 'ON_SITE');
  assert.ok(f.sim.repo.all('notification').some((n) => n.title === 'On site'));
  assert.throws(() => leeP.cmd('crewSignOn', { item: it.id }), /already on site/);
  // the day ends with nobody tapping Done: flagged, never done
  f.clock(D1, '17:01');
  f.pass();
  x = f.item(it.id);
  assert.equal(x.status, 'ACTIVE');
  assert.equal(x.stage, 'UNCONFIRMED');
  assert.match(x.problem, /the day was not marked done \(2 people signed on at Bondi\)/);
  // ... then the leading hand marks it done from the phone (the office could too, recorded for them)
  const done = leeP.cmd('planDone', { id: it.id });
  assert.equal(done.item.status, 'DONE');
  assert.equal(f.item(it.id).done.kind, 'PERSON');
  // the office signing on for another booking: ON_BEHALF, and only on its day
  const it2 = f.cmd('planWorkers', { day: D2, time: '07:00', site: f.site.id, count: 1, people: [f.team.Sam.id] }).item;
  assert.throws(() => f.cmd('crewSignOn', { item: it2.id, people: [f.team.Sam.id] }), /has not come yet/);
  f.clock(D2, '07:05');
  f.cmd('crewSignOn', { item: it2.id, people: [f.team.Sam.id] });
  const y = f.item(it2.id);
  assert.equal(y.people[0].signOn.kind, 'ON_BEHALF');
  assert.match(y.log.at(-1).text, /recorded by Tee/);
  const d2 = f.cmd('planDone', { id: it2.id, note: 'Knocked off early' });
  assert.equal(f.item(it2.id).done.kind, 'ON_BEHALF');
  assert.match(d2.message, /is done/);
  const v = f.sim.planMonth(D2.slice(0, 7)).items.find((i) => i.id === it2.id);
  assert.match(v.words, /Done \(recorded by Tee\)/);
  assert.equal(v.people[0].signOn.kind, 'ON_BEHALF');
});

test('RESTACK in a real yard is a dated task: begun on its day, done only by a Done tap (a yard hand or the office), flagged otherwise', (t) => {
  const f = liveFixture(t);
  const a = f.cmd('planRestack', { day: D1, time: '07:00' }).item,
    b = f.cmd('planRestack', { day: D2, time: '07:00' }).item;
  assert.equal(a.status, 'PLANNED');
  f.clock(D1, '07:30');
  f.pass();
  assert.equal(f.item(a.id).stage, 'TODO');
  assert.equal(f.item(a.id).status, 'ACTIVE');
  const kev = phone(f, f.team.Kev),
    jo = phone(f, f.team.Jo);
  assert.equal(kev.me().person.role, 'YARDSMAN');
  assert.equal(kev.me().can.packs, true);
  // today's task with its Done, and tomorrow's to see it coming (read-only until the day)
  assert.deepEqual(
    kev.me().tasks.map((x) => [x.id, x.dayWords, x.canDone]),
    [
      [a.id, 'Today', true],
      [b.id, 'Tomorrow', false],
    ],
  );
  assert.throws(() => jo.cmd('planDone', { id: a.id }), /Only a yard hand/);
  const done = kev.cmd('planDone', { id: a.id });
  assert.equal(done.item.status, 'DONE');
  assert.equal(f.item(a.id).done.kind, 'PERSON');
  assert.equal(ledger(f).filter((r) => r.event === 'CONSOLIDATED').length, 0, 'the app moved no stock for it');
  // the second one: the day ends with no tap
  f.clock(D2, '17:30');
  f.pass();
  assert.equal(f.item(b.id).status, 'ACTIVE');
  assert.equal(f.item(b.id).stage, 'UNCONFIRMED');
  assert.match(f.item(b.id).problem, /nobody tapped Done/);
  // still not done by itself; the office can mark it done or move it
  f.cmd('planDone', { id: b.id });
  assert.equal(f.item(b.id).status, 'DONE');
});

test('Move the day: 10 items of one day to another in one go, lists staying on their trucks; a clash anywhere moves nothing', (t) => {
  const f = liveFixture(t);
  const mick = f.cmd('teamAdd', { name: 'Mick', role: 'DRIVER' }).person;
  const t2 = f.cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: f.yard.id, payload: 2000000 });
  const s2 = f.cmd('gameSite', { name: 'Manly', address: '2 The Corso' }).site,
    s3 = f.cmd('gameSite', { name: 'Coogee', address: '3 Arden St' }).site;
  const ids = [];
  const tr1 = f.cmd('planTruck', { day: D1, time: '07:00', truck: f.truck.id, driver: f.team.Dave.id }).item,
    tr2 = f.cmd('planTruck', { day: D1, time: '07:00', truck: t2.id, driver: mick.id }).item;
  ids.push(tr1.id, tr2.id);
  const lists = [
    [f.site.id, '08:00', tr1.id],
    [s2.id, '10:00', tr1.id],
    [s3.id, '09:00', tr2.id],
  ].map(
    ([site, time, truckPlan]) =>
      f.cmd('planMaterials', { day: D1, time, site, lines: [{ product: f.product.id, quantity: 3 }], truckPlan }).item,
  );
  ids.push(...lists.map((x) => x.id));
  const crews = [
    [f.site.id, [f.team.Jo.id]],
    [s2.id, [f.team.Sam.id]],
    [s3.id, []],
  ].map(([site, people]) => f.cmd('planWorkers', { day: D1, time: '07:00', site, count: 1, people }).item);
  ids.push(...crews.map((x) => x.id));
  ids.push(f.cmd('planRestack', { day: D1, time: '11:00' }).item.id);
  ids.push(
    f.cmd('planMaterials', {
      day: D1,
      time: '13:00',
      site: f.site.id,
      lines: [{ product: f.product.id, quantity: 2 }],
      draft: true,
    }).item.id,
  );
  assert.equal(ids.length, 10);
  const tripsBefore = f.sim.repo.all('trip').filter((x) => x.state !== 'CANCELLED');
  assert.equal(tripsBefore.length, 3);
  const r = f.cmd('planMoveDay', { from: D1, to: D2 });
  assert.equal(r.moved, 10);
  assert.match(r.message, /10 things moved/);
  for (const id of ids) assert.equal(f.item(id).day, D2, id);
  assert.equal(f.sim.planDayItems(D1).filter((i) => i.status !== 'CANCELLED').length, 0, 'nothing left on the day');
  // the lists are still on their trucks: each order booked again on the moved booking's new trip
  for (const l of lists) {
    const it = f.item(l.id);
    assert.equal(it.status, 'PLANNED');
    const o = f.sim.repo.get(it.order, 'order');
    assert.equal(o.status, 'BOOKED', 'booked on a trip again');
    assert.equal(o.neededOn, D2);
    const trip = f.sim.repo.get(o.trip, 'trip');
    assert.equal(f.item(trip.truckPlan).day, D2);
    assert.equal(it.truckPlan, trip.truckPlan);
  }
  assert.equal(f.sim.repo.all('trip').filter((x) => x.state === 'BOOKED').length, 3);
  assert.equal(f.sim.repo.all('reservation').filter((x) => x.active).length, 3, 'still held, exactly');
  assert.equal(f.item(ids[9]).status, 'DRAFT', 'the draft moved as a draft');
  // the drivers are asked again for the new day
  assert.ok(f.msgs(tr1.id).some((m) => m.status === 'SENT' && m.day === D2));
  // a clash: T-01 is already booked on D3 with Mick; moving D2 is refused as a whole
  f.cmd('planTruck', { day: D3, time: '07:00', truck: f.truck.id, driver: mick.id });
  assert.throws(() => f.cmd('planMoveDay', { from: D2, to: D3 }), /already booked on/);
  for (const id of ids) assert.equal(f.item(id).day, D2, 'nothing moved: ' + id);
  assert.equal(f.sim.repo.all('trip').filter((x) => x.state === 'BOOKED').length, 3, 'no trip lost');
  assert.equal(f.sim.repo.all('reservation').filter((x) => x.active).length, 3);
  assert.throws(() => f.cmd('planMoveDay', { from: D1, to: D2 }), /Nothing to move/);
  assert.throws(() => f.cmd('planMoveDay', { from: D2, to: D2 }), /same day/);
});

test("Copy yesterday's crews: the same people, sites, times and counts on another day; a clash copies nothing", (t) => {
  const f = liveFixture(t);
  const s2 = f.cmd('gameSite', { name: 'Manly', address: '2 The Corso' }).site;
  f.cmd('planWorkers', { day: D0, time: '10:00', site: f.site.id, count: 2, people: [f.team.Jo.id, f.team.Sam.id] });
  f.cmd('planWorkers', { day: D0, time: '13:00', site: s2.id, count: 1, people: [f.team.Kev.id] });
  const r = f.cmd('planCopyCrews', { from: D0, to: D1 });
  assert.equal(r.copied, 2);
  const made = f.sim.planDayItems(D1, 'WORKERS');
  assert.equal(made.length, 2);
  const bondi = made.find((x) => x.site === f.site.id);
  assert.deepEqual(bondi.people.map((p) => p.person).sort(), [f.team.Jo.id, f.team.Sam.id].sort());
  assert.equal(bondi.time, '10:00');
  assert.equal(bondi.count, 2);
  assert.equal(bondi.status, 'PLANNED');
  assert.equal(f.msgs(bondi.id).length, 0, 'asked at 3 pm the day before, as any booking');
  // Jo is already at Manly on D2: copying D0 to D2 clashes and makes nothing
  f.cmd('planWorkers', { day: D2, time: '07:00', site: s2.id, count: 1, people: [f.team.Jo.id] });
  assert.throws(() => f.cmd('planCopyCrews', { from: D0, to: D2 }), /Jo is already at Manly/);
  assert.equal(f.sim.planDayItems(D2, 'WORKERS').length, 1, 'nothing copied');
  assert.throws(() => f.cmd('planCopyCrews', { from: D3, to: D2 }), /No crews on/);
});

test("the run sheet: a driver's trips in order with site, address, loads and receivers; the phone shows the same", (t) => {
  const f = liveFixture(t);
  const s2 = f.cmd('gameSite', { name: 'Manly', address: '2 The Corso, Manly' }).site;
  f.cmd('siteDetails', { id: s2.id, contact: 'Pat', phone: '0400 000 000' });
  const b = f.cmd('planTruck', {
    day: D1,
    time: '07:00',
    truck: f.truck.id,
    driver: f.team.Dave.id,
    note: 'Fuel up first',
  }).item;
  const o1 = f.cmd('orderCreate', {
    site: s2.id,
    lines: [{ product: f.product.id, quantity: 4 }],
    neededOn: D1,
    time: '09:00',
    note: 'Gate code 1234',
  }).order;
  const o2 = f.cmd('orderCreate', {
    site: f.site.id,
    lines: [{ product: f.product.id, quantity: 6 }],
    neededOn: D1,
    time: '07:30',
  }).order;
  f.cmd('tripBook', { orders: [o1.id], truckPlan: b.id });
  f.cmd('tripBook', { orders: [o2.id], truckPlan: b.id });
  const sheet = f.sim.runSheet({ day: D1 });
  assert.equal(sheet.sheets.length, 1);
  const s = sheet.sheets[0];
  assert.equal(s.driver.name, 'Dave');
  assert.equal(s.truck.id, f.truck.id);
  assert.equal(s.note, 'Fuel up first');
  assert.deepEqual(
    s.trips.map((x) => [x.time, x.siteName, x.words, x.pieces]),
    [
      ['07:30', 'Bondi', 'Deliver to Bondi', 6],
      ['09:00', 'Manly', 'Bring back from Manly'.replace('Bring back from', 'Deliver to'), 4],
    ],
  );
  assert.equal(s.trips[1].address, '2 The Corso, Manly');
  assert.equal(s.trips[1].contact, 'Pat');
  assert.deepEqual(s.trips[1].notes, ['Gate code 1234']);
  assert.equal(s.trips[0].lines[0].quantity, 6);
  assert.equal(s.trips[0].receivedBy, null);
  // by driver, and none for a day with nothing
  assert.equal(f.sim.runSheet({ day: D1, driver: f.team.Dave.id }).sheets.length, 1);
  assert.equal(f.sim.runSheet({ day: D2 }).sheets.length, 0);
  // delivered: the receiver's name goes on the sheet
  f.clock(D1, '07:40');
  const trip = f.sim.repo.all('trip').find((x) => x.site === f.site.id);
  f.cmd('tripLoaded', { trip: trip.id });
  f.cmd('tripDelivered', { trip: trip.id, receivedBy: 'J. Smith' });
  assert.equal(f.sim.runSheet({ day: D1 }).sheets[0].trips[0].receivedBy, 'J. Smith');
  // the driver's phone: the same trips, in order
  const dave = phone(f, f.team.Dave);
  const me = dave.me();
  assert.deepEqual(
    me.trips.map((x) => x.siteName),
    ['Bondi', 'Manly'],
  );
  assert.equal(me.trips[1].address, '2 The Corso, Manly');
  // a real yard's calm words: no simulation in the sheet
  assert.ok(!JSON.stringify(sheet).includes('DEMO'));
});

test('the Dispatch lanes view of Today: one lane per truck, a state dot per trip from the records only, unconfirmed things first', (t) => {
  const f = liveFixture(t);
  const mick = f.cmd('teamAdd', { name: 'Mick', role: 'DRIVER' }).person;
  const t2 = f.cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: f.yard.id, payload: 2000000 });
  const b1 = f.cmd('planTruck', { day: D1, time: '07:00', truck: f.truck.id, driver: f.team.Dave.id }).item,
    b2 = f.cmd('planTruck', { day: D1, time: '08:00', truck: t2.id, driver: mick.id }).item;
  const o1 = f.cmd('orderCreate', {
      site: f.site.id,
      lines: [{ product: f.product.id, quantity: 4 }],
      neededOn: D1,
    }).order,
    o2 = f.cmd('orderCreate', {
      site: f.site.id,
      lines: [{ product: f.product.id, quantity: 3 }],
      neededOn: D1,
      time: '08:00',
    }).order;
  const tr1 = f.cmd('tripBook', { orders: [o1.id], truckPlan: b1.id }).trip,
    tr2 = f.cmd('tripBook', { orders: [o2.id], truckPlan: b2.id }).trip;
  f.cmd('planWorkers', { day: D1, time: '07:00', site: f.site.id, count: 1, people: [f.team.Jo.id] });
  f.cmd('planRestack', { day: D1, time: '12:00' });
  let v = f.sim.dispatchView({ day: D1 });
  assert.equal(v.lanes.length, 2);
  assert.deepEqual(
    v.dots.map((d) => d.code),
    ['DRAFT', 'BOOKED', 'ASKED', 'YES', 'PACKED', 'LOADED', 'DELIVERED', 'BACK'],
  );
  const lane = (truck) => v.lanes.find((l) => l.truck === truck);
  assert.equal(lane(f.truck.id).trips[0].dot, 'ASKED', 'the ask went out at booking');
  assert.equal(lane(f.truck.id).answer, 'WAITING');
  assert.equal(v.people.yard.toPack, 2);
  assert.equal(v.people.workers[0].yes, 0);
  assert.equal(v.people.yard.restack.stage, 'WAITING');
  assert.ok(
    v.lanes.every((l) => !l.unconfirmed),
    'nothing is late yet',
  );
  // Dave says yes (the office records it), the yard packs, Dave loads and delivers: the dot follows each confirmation
  f.cmd('messageAnswer', { id: f.msgs(b1.id)[0].id, yes: true });
  assert.equal(f.sim.dispatchView({ day: D1 }).lanes.find((l) => l.truck === f.truck.id).trips[0].dot, 'YES');
  f.cmd('packConfirmed', { trip: tr1.id });
  assert.equal(f.sim.dispatchView({ day: D1 }).lanes.find((l) => l.truck === f.truck.id).trips[0].dot, 'PACKED');
  assert.equal(f.sim.dispatchView({ day: D1 }).people.yard.packed, 1);
  f.clock(D1, '07:15');
  f.cmd('tripLoaded', { trip: tr1.id });
  assert.equal(f.sim.dispatchView({ day: D1 }).lanes.find((l) => l.truck === f.truck.id).trips[0].dot, 'LOADED');
  f.cmd('tripDelivered', { trip: tr1.id, receivedBy: 'J' });
  assert.equal(f.sim.dispatchView({ day: D1 }).lanes.find((l) => l.truck === f.truck.id).trips[0].dot, 'DELIVERED');
  f.cmd('tripReturned', { trip: tr1.id });
  v = f.sim.dispatchView({ day: D1 });
  assert.equal(lane(f.truck.id).trips[0].dot, 'BACK');
  // 8:30 and Mick's trip has neither a yes nor a load: that lane is unconfirmed and comes first
  f.clock(D1, '08:30');
  v = f.sim.dispatchView({ day: D1 });
  assert.equal(v.lanes[0].truck, t2.id, 'the unconfirmed lane first');
  assert.equal(v.lanes[0].unconfirmed, true);
  assert.equal(v.lanes[0].trips[0].dot, 'ASKED');
  assert.equal(v.lanes[1].unconfirmed, false);
  // the day ends: the clock flags Mick's trip, the lane shows the flag; the view never moved the dot
  f.clock(D1, '17:05');
  f.pass();
  v = f.sim.dispatchView({ day: D1 });
  assert.equal(v.lanes[0].trips[0].flag.code, 'UNCONFIRMED_TRIP');
  assert.equal(v.lanes[0].trips[0].dot, 'ASKED');
  assert.equal(f.sim.repo.get(tr2.id, 'trip').state, 'BOOKED');
  // the view is the office's, in a real yard only; unbooked trucks are listed for the next booking
  assert.throws(() => new Simulation(f.db, f.owner).dispatchView(), /real yard only/);
  assert.equal(f.sim.dispatchView({ day: D2 }).unbooked.length, 2);
  assert.ok(v.needsYou && Array.isArray(v.needsYou.items));
});

test('the probe: a full booked day under three days of clock passes: no simulated answer, no auto-pack, no driverless trip, no teleport', (t) => {
  const f = liveFixture(t);
  const l = lee(f);
  const b = f.cmd('planTruck', { day: D1, time: '07:00', truck: f.truck.id, driver: f.team.Dave.id }).item;
  f.cmd('planMaterials', {
    day: D1,
    time: '08:00',
    site: f.site.id,
    lines: [{ product: f.product.id, quantity: 10 }],
    truckPlan: b.id,
  });
  const w = f.cmd('planWorkers', {
    day: D1,
    time: '07:00',
    site: f.site.id,
    count: 2,
    people: [f.team.Jo.id, l.id],
  }).item;
  f.cmd('planRestack', { day: D1, time: '09:00' });
  // the records, apart from the clock's own flag on a trip (never its state, steps or pieces)
  const probeRecords = () => {
    const r = records(f.db, f.company);
    r.objects = JSON.stringify(
      JSON.parse(r.objects).map((o) => {
        if (o.kind !== 'trip') return o;
        const d = JSON.parse(o.data);
        delete d.flag;
        return { ...o, data: JSON.stringify(d), version: 0 };
      }),
    );
    return r;
  };
  const before = probeRecords(),
    tripsBefore = f.sim.repo.all('trip').map((x) => [x.id, x.state]);
  const start = f.at(D0, '09:01');
  for (let i = 0; i < 3 * 24 * 6; i++) {
    f.setTime(start + i * 600000);
    f.pass();
  }
  assert.deepEqual(probeRecords(), before, 'the clock moved, packed, loaded and completed nothing');
  const msgs = f.sim.repo.all('message');
  assert.ok(msgs.length >= 4, 'the asks went out');
  assert.ok(!msgs.some((m) => m.answer), 'nobody answered by themselves (no SIMULATED reply)');
  assert.equal(
    f.sim.repo.all('reservation').filter((r) => r.plan).length,
    0,
    'no auto-pack: no list held whole stillages',
  );
  assert.equal(
    f.db.prepare('SELECT COUNT(*) n FROM trip_confirmation WHERE company_id=?').get(f.company).n,
    0,
    'no confirmation was invented',
  );
  assert.deepEqual(
    f.sim.repo.all('trip').map((x) => [x.id, x.state]),
    tripsBefore,
    'no trip changed state (no driverless trip)',
  );
  assert.ok(
    f.item(w.id).people.every((p) => !p.moved),
    'nobody teleported to the site',
  );
  assert.ok(!f.sim.repo.all('resource').some((r) => r.away));
  assert.ok(
    f.sim.repo.all('planItem').every((i) => i.status !== 'DONE'),
    'nothing was marked done',
  );
  assert.ok(
    f.sim.repo.all('planItem').every((i) => i.stage === 'UNCONFIRMED'),
    'every item ended flagged, not done',
  );
  assert.equal(f.sim.repo.all('trip')[0].flag?.code, 'UNCONFIRMED_TRIP');
  // the engine, if anyone called it, does nothing either
  atomic(f.db, () => f.sim.tick(1000));
  assert.deepEqual(probeRecords(), before);
});
