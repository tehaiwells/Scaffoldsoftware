process.env.TZ = 'Australia/Sydney'; // each test file runs in its own process; the planner's days and times are Sydney's
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { atomic } from '../src/database.js';
import { Simulation } from '../src/simulation.js';
import { planSimAnswer } from '../src/domain/plantime.js';
import { addDays, dayLabel } from '../src/domain/schedule.js';
import { gpChoose } from '../public/game-pick.js';
import { planFixture, D0, L } from './helpers/plan-fixture.js';

const D1 = addDays(D0, 1),
  D2 = addDays(D0, 2);
const answerYes = (f, id) => f.cmd('messageAnswer', { id, yes: true });
const events = (f, since) =>
  f.db
    .prepare('SELECT event,COUNT(*) n FROM ledger WHERE company_id=? AND quantity>0 AND created_at>=? GROUP BY event')
    .all(f.user.company_id, new Date(since).toISOString())
    .map((r) => r.event)
    .sort();

test('TRUCK: the driver is asked at once, answers by himself after a short fixed delay, and double bookings are refused', (t) => {
  const f = planFixture(t);
  f.cmd('teamStart');
  const dave = f.driver('Dave'),
    sam = f.driver('Sam'),
    t1 = f.truck('T-01'),
    t2 = f.truck('T-02');
  const day = f.dayWhere(dave.id, 'DRIVE', true);
  const r = f.cmd('planTruck', { day, truck: t1.id, driver: dave.id });
  assert.equal(r.message, 'T-01 booked for ' + dayLabel(day) + '. Dave has been asked.');
  assert.equal(r.item.type, 'TRUCK');
  assert.equal(r.item.stage, 'ASKING');
  assert.equal(r.item.words, 'Waiting for Dave to answer');
  assert.equal(r.item.flags.needsAnswer, true);
  const [m] = f.msgs(r.item.id);
  assert.equal(m.status, 'SENT');
  assert.equal(m.subject, 'DRIVE');
  assert.equal(m.channel, 'IN_APP');
  assert.deepEqual(m.outbound, { provider: null, ref: null });
  assert.equal(m.attempt, 1);
  assert.equal(
    m.text,
    'Hi Dave, can you drive T-01 (big truck) on ' +
      dayLabel(day) +
      ' from 7:00 am? Yard runs. Please reply yes or no. – Tee Scaffolding',
  );
  assert.ok(
    f.sim.repo
      .all('notification')
      .some((n) => n.title === 'Message sent' && n.body === 'Asked Dave to drive T-01 on ' + dayLabel(day) + '.'),
  );
  const a = planSimAnswer(m),
    sent = Date.parse(m.sentAt);
  f.at(sent + (a.delaySec - 1) * 1000);
  f.pass();
  assert.equal(f.sim.repo.get(m.id, 'message').status, 'SENT', 'not before its delay');
  f.at(sent + a.delaySec * 1000);
  f.pass();
  const yes = f.sim.repo.get(m.id, 'message');
  assert.equal(yes.status, 'YES');
  assert.equal(yes.answer.via, 'SIMULATED');
  assert.equal(yes.answer.by, null);
  assert.equal(f.item(r.item.id).stage, 'READY');
  assert.equal(f.view(r.item.id).words, 'Dave said yes');
  assert.ok(f.item(r.item.id).log.some((l) => l.text === 'Dave said yes.'));
  assert.throws(() => f.cmd('planTruck', { day, truck: t1.id, driver: sam.id }), /T-01 is already booked on /);
  assert.throws(
    () => f.cmd('planTruck', { day, truck: t2.id, driver: dave.id }),
    /Dave is already driving T-01 that day/,
  );
  assert.throws(
    () => f.cmd('planTruck', { day, truck: t2.id, hire: { size: 'BIG' } }),
    /Choose one of your trucks, or hire one in/,
  );
  assert.throws(() => f.cmd('planTruck', { day: addDays(D0, -1), truck: t2.id }), /That day has passed/);
  // with simulated answers off the message waits; the office confirms on his behalf; the phone view cannot answer after the time
  f.cmd('planReplies', { on: false });
  const r2 = f.cmd('planTruck', { day, truck: t2.id, driver: sam.id });
  const [m2] = f.msgs(r2.item.id);
  f.at(Date.parse(m2.sentAt) + 100000);
  f.pass();
  assert.equal(f.sim.repo.get(m2.id, 'message').status, 'SENT');
  assert.equal(f.view(r2.item.id).people, undefined);
  assert.equal(f.view(r2.item.id).driverRow.answer, 'WAITING');
  f.clock(day, '07:01');
  assert.equal(f.view(r2.item.id).driverRow.answer, 'NO_ANSWER');
  assert.equal(f.view(r2.item.id).flags.red, true);
  assert.throws(
    () => f.cmd('messageAnswer', { id: m2.id, yes: true, via: 'PHONE_VIEW' }),
    /Too late to answer, call the office/,
  );
  const ok = f.cmd('messageAnswer', { id: m2.id, yes: true });
  assert.equal(ok.message, 'Marked as yes for Sam.');
  assert.equal(f.sim.repo.get(m2.id, 'message').answer.via, 'OFFICE');
  assert.equal(f.item(r2.item.id).stage, 'ON', 'the day has started');
  assert.equal(f.view(r2.item.id).words, 'Sam said yes');
});

test('TRUCK: a declined driver is a problem to fix; asking another driver calls the first ask off; asking the same one again is attempt 2', (t) => {
  const f = planFixture(t);
  f.cmd('teamStart');
  const dave = f.driver('Dave'),
    sam = f.driver('Sam');
  f.cmd('planReplies', { on: false });
  const r = f.cmd('planTruck', { day: D2, truck: f.truck('T-01').id, driver: dave.id });
  const [m] = f.msgs(r.item.id);
  const no = f.cmd('messageAnswer', { id: m.id, yes: false, reason: "Ute's in for a service", via: 'PHONE_VIEW' });
  assert.equal(no.message, 'Got it. The office will sort it.');
  const it = f.item(r.item.id);
  assert.equal(it.problem, "Dave can't make it: Ute's in for a service. Pick another driver.");
  assert.equal(f.view(it.id).words, "Dave can't make it: Ute's in for a service");
  assert.ok(
    f.sim.repo.all('notification').some((n) => n.title === "Can't make it" && /Dave can't make it/.test(n.body)),
  );
  const again = f.cmd('planAsk', { item: it.id, person: dave.id });
  assert.equal(again.message, 'Dave has been asked.');
  const ms = f.msgs(it.id);
  assert.equal(ms.length, 2);
  assert.equal(ms[0].status, 'CALLED_OFF');
  assert.equal(ms[1].attempt, 2);
  f.cmd('planAsk', { item: it.id, person: sam.id });
  const all = f.msgs(it.id);
  assert.equal(all.filter((x) => x.status !== 'CALLED_OFF').length, 1);
  assert.equal(f.item(it.id).driver, sam.id);
  assert.equal(f.item(it.id).problem, null);
  assert.throws(() => f.cmd('messageAnswer', { id: ms[0].id, yes: true }), /This was called off/);
});

test('hire truck: it arrives at 6:00 on its day and goes back at 5:00 pm when it is home and empty', (t) => {
  const f = planFixture(t);
  const site = f.site();
  const r = f.cmd('planTruck', { day: D2, hire: { size: 'BIG' } });
  assert.equal(r.message, 'A big hire truck booked for ' + dayLabel(D2) + '. No driver named.');
  assert.equal(r.item.words, 'No driver named');
  f.clock(D2, '05:59');
  f.pass();
  assert.equal(f.trucks().length, 2, 'not yet');
  f.clock(D2, '06:00');
  f.pass();
  const h = f.truck('Hire truck 1');
  assert.ok(h);
  assert.deepEqual(h.hired, { item: r.item.id, day: D2 });
  assert.equal(h.payload, 12500000);
  assert.equal(f.item(r.item.id).status, 'ACTIVE');
  assert.equal(f.item(r.item.id).hire.truck, h.id);
  assert.ok(
    f.sim.gameFreeTrucks(f.yard).some((x) => x.id === h.id),
    'on the day it is available for runs',
  );
  assert.ok(f.sim.repo.all('notification').some((n) => n.title === 'Hire truck'));
  f.pass();
  assert.equal(f.trucks().length, 3, 'a second pass makes no second truck');
  f.clock(D2, '17:00');
  f.pass();
  assert.equal(f.truck('Hire truck 1').retired, true);
  const done = f.item(r.item.id);
  assert.equal(done.status, 'DONE');
  assert.ok(done.hire.goneAt);
  // still out at 5 pm: it waits, and goes back once it is home
  const r2 = f.cmd('planTruck', { day: addDays(D2, 1), hire: { size: 'SMALL' } });
  f.clock(addDays(D2, 1), '06:00');
  f.pass();
  const s = f.truck('Hire truck 1') && f.trucks().find((x) => x.hired?.item === r2.item.id);
  assert.equal(s.payload, 2000000);
  f.cmd('dispatch', { id: s.id, destination: site.id });
  f.clock(addDays(D2, 1), '17:00');
  f.pass();
  assert.equal(f.sim.repo.get(s.id, 'truck').retired, undefined);
  assert.match(f.item(r2.item.id).problem, /Hire truck is still out/);
  assert.equal(f.item(r2.item.id).status, 'ACTIVE');
  assert.ok(f.until(() => f.sim.repo.get(s.id, 'truck').status === 'AT_SITE'));
  f.cmd('dispatch', { id: s.id, destination: f.yard.id });
  assert.ok(f.until(() => f.sim.repo.get(s.id, 'truck').status === 'AT_YARD' || f.sim.repo.get(s.id, 'truck').retired));
  f.pass();
  assert.equal(f.sim.repo.get(s.id, 'truck').retired, true, 'gone back as soon as it was home');
  assert.equal(f.item(r2.item.id).status, 'DONE');
});

test('MATERIALS end to end: packed the day before by the yard crew (whole stillages held), loaded at its time, driven, unloaded, delivered; stock never teleports', (t) => {
  const f = planFixture(t, { now: L(D0, '05:00'), jobs: true });
  const { p, per } = f.stock(3);
  const site = f.site('Bondi', '12 Smith St');
  f.cmd('teamStart');
  const dave = f.driver('Dave'),
    t1 = f.truck('T-01'),
    t2 = f.truck('T-02');
  const tr = f.cmd('planTruck', { day: D1, truck: t1.id, driver: dave.id });
  answerYes(f, f.msgs(tr.item.id)[0].id);
  const before = f.total();
  const r = f.cmd('planMaterials', {
    day: D1,
    site: site.id,
    lines: [{ product: p.id, quantity: per * 2 }],
    pack: 'DAY_BEFORE',
    truckPlan: tr.item.id,
  });
  assert.equal(r.message, 'List for Bondi on ' + dayLabel(D1) + ' planned. Worker 1 packs it the day before.');
  assert.equal(r.item.stage, 'WAITING');
  assert.equal(r.item.packDay, D0);
  assert.equal(r.item.packerName, 'Worker 1');
  assert.equal(r.item.truckPlanName, 'T-01 · Dave');
  assert.equal(f.sim.repo.all('loadList').length, 0, "no yard list: the owner's catalogue has no pack sizes");
  f.clock(D0, '06:00');
  f.pass();
  let it = f.item(r.item.id);
  assert.equal(it.stage, 'PACKING');
  const pm = f.sim.repo.get(it.packMessage, 'message');
  assert.equal(pm.subject, 'PACK');
  assert.equal(pm.needsAnswer, false);
  assert.equal(
    pm.text,
    'Hi there, please pack this list for Bondi today, for ' +
      dayLabel(D1) +
      ': ' +
      per * 2 +
      ' × ' +
      p.name +
      '. T-01 picks it up at 7:00 am.',
  );
  const job = () => f.sim.repo.all('job').find((j) => j.key === 'PLAN:PACK:' + it.id);
  assert.ok(
    f.until(() => job(), 20),
    'the pack job is on the yard board',
  );
  assert.equal(job().priority, 3);
  assert.equal(job().effect, 'PACK');
  assert.equal(job().badge, 'REAL');
  assert.equal(job().category, 'ORDERS');
  assert.ok(
    f.until(() => f.item(it.id).stage === 'PACKED', 300),
    'packed by the crew',
  );
  it = f.item(it.id);
  assert.equal(it.held.length, 2);
  assert.match(it.log.at(-1).text, /^Packed by Worker \d\.$/);
  const holds = f.sim.repo.all('reservation').filter((x) => x.active && x.plan === it.id);
  assert.deepEqual([...new Set(holds.map((x) => x.container))].sort(), [...it.held].sort());
  assert.ok(holds.every((x) => x.task === null));
  const items = f.sim.gameItems([f.yard.id]).get(f.yard.id);
  assert.ok(
    items.filter((c) => it.held.includes(c.id)).every((c) => c.busy),
    'held stillages are busy for the board',
  );
  assert.ok(gpChoose(items, [{ product: p.id, quantity: per * 3 }]).ids.every((id) => !it.held.includes(id)));
  // a board Send cannot take them (and the third stillage is under them in the pile)
  assert.throws(
    () => f.cmd('gameSend', { site: site.id, lines: [{ product: p.id, quantity: per * 3 }], truck: t2.id }),
    /None of that is free in the yard right now/,
  );
  f.clock(D1, '06:59');
  f.pass();
  assert.equal(f.item(it.id).stage, 'PACKED', 'not before its time');
  const from = L(D1, '07:00');
  f.clock(D1, '07:00');
  assert.ok(f.until(() => f.item(it.id).stage === 'LOADING', 20));
  assert.equal(f.truck('T-01').game.plan, it.id);
  assert.ok(
    f.until(() => f.item(it.id).stage === 'ON_THE_WAY', 400),
    'on the way',
  );
  assert.equal(f.view(it.id).words, 'On the way to Bondi');
  assert.ok(
    f.until(() => f.item(it.id).status === 'DONE', 600),
    'delivered',
  );
  it = f.item(it.id);
  assert.equal(it.stage, 'DELIVERED');
  assert.equal(it.trips.length, 1);
  assert.equal(it.trips[0].delivered, true);
  assert.equal(it.trips[0].pieces, per * 2);
  assert.deepEqual(
    f.sim.containers().filter((c) => c.location === site.id && it.held.includes(c.id)).length,
    2,
    'the held stillages are at the site',
  );
  assert.equal(f.total(), before, 'stock conserved');
  assert.deepEqual(
    events(f, from),
    ['PICKUP', 'PLACEMENT'],
    'every piece moved by forklift, truck and crane: no teleport',
  );
  assert.equal(f.sim.repo.all('reservation').filter((x) => x.active && x.plan === it.id).length, 0, 'no hold left');
  assert.ok(
    f.sim.repo
      .all('notification')
      .some((n) => n.title === 'Delivered' && n.body === 'Delivered to Bondi: the list for ' + dayLabel(D1) + '.'),
  );
  assert.equal(f.sim.repo.get(pm.id, 'message').closedAt !== null, true, 'the pack message is closed with the item');
});

test('MATERIALS with yard jobs off is packed by the office at 6:00 on its pack day; short stock is held as far as it goes and flagged', (t) => {
  const f = planFixture(t, { now: L(D0, '05:00') });
  const { p, per } = f.stock(2);
  const site = f.site();
  const r = f.cmd('planMaterials', { day: D1, site: site.id, lines: [{ product: p.id, quantity: per * 3 }] });
  assert.match(r.message, /Only \d+ of .* in the yard now\./, 'a soft check, never an error');
  assert.equal(r.item.packDay, D1);
  assert.equal(r.item.truckPlan, null);
  f.clock(D0, '06:00');
  f.pass();
  assert.equal(f.item(r.item.id).stage, 'WAITING', 'packed on its own day');
  f.clock(D1, '06:00');
  f.pass();
  const it = f.item(r.item.id);
  assert.equal(it.stage, 'PACKED');
  assert.ok(it.log.some((l) => l.text === 'Packed by the office (yard jobs are switched off).'));
  assert.deepEqual(it.short, [{ product: p.id, want: per * 3, got: per * 2 }]);
  assert.equal(it.problem, 'Short: ' + per + ' × ' + p.name + " weren't in the yard.");
  const v = f.view(it.id);
  assert.equal(v.flags.red, true);
  assert.equal(v.short[0].missing, per);
  f.clock(D1, '07:00');
  assert.ok(
    f.until(() => f.item(it.id).status === 'DONE', 600),
    'what there was is delivered',
  );
  assert.equal(f.piecesAt(site.id, p.id), per * 2);
  assert.equal(f.view(it.id).flags.red, true, 'still shows it came up short');
});

test('MATERIALS: a small truck takes two trips; the rest stays held for the next one', (t) => {
  const f = planFixture(t, { now: L(D1, '09:00') });
  const { p, per } = f.stock(2);
  const site = f.site();
  f.cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: f.yard.id, payload: 2000000 });
  const small = f.truck('L-01');
  const tr = f.cmd('planTruck', { day: D1, truck: small.id, time: '10:00' });
  const r = f.cmd('planMaterials', {
    day: D1,
    time: '10:00',
    site: site.id,
    lines: [{ product: p.id, quantity: per * 2 }],
    truckPlan: tr.item.id,
  });
  assert.equal(f.item(r.item.id).stage, 'PACKED', 'packed at once: its pack day has started');
  f.clock(D1, '10:00');
  f.pass();
  let it = f.item(r.item.id);
  assert.equal(it.stage, 'LOADING');
  assert.equal(it.trips.length, 1);
  assert.equal(it.trips[0].stillages, 1, 'one 1.5 t stillage fits a 2 t truck');
  assert.equal(it.left.length, 1);
  assert.ok(
    f.until(() => f.item(it.id).trips.length === 2, 800),
    'the rest goes when L-01 is back',
  );
  assert.ok(f.until(() => f.item(it.id).status === 'DONE', 800));
  it = f.item(it.id);
  assert.ok(it.trips.every((x) => x.delivered && x.truck === small.id));
  assert.equal(f.piecesAt(site.id, p.id), per * 2);
});

test('MATERIALS: it waits for its truck to come back and for its driver to say yes, then goes', (t) => {
  const f = planFixture(t, { now: L(D1, '05:00') });
  const { p, per } = f.stock(1);
  const site = f.site(),
    other = f.site('Parramatta');
  f.cmd('teamStart');
  f.cmd('planReplies', { on: false });
  const dave = f.driver('Dave'),
    t1 = f.truck('T-01');
  const tr = f.cmd('planTruck', { day: D1, truck: t1.id, driver: dave.id });
  const r = f.cmd('planMaterials', {
    day: D1,
    site: site.id,
    lines: [{ product: p.id, quantity: per }],
    truckPlan: tr.item.id,
  });
  f.cmd('dispatch', { id: t1.id, destination: other.id });
  f.clock(D1, '07:00');
  f.pass();
  assert.equal(f.item(r.item.id).problem, 'Waiting for Dave to say yes (or tap They said yes on the phone).');
  const m = f.msgs(tr.item.id)[0];
  f.cmd('messageAnswer', { id: m.id, yes: false, reason: 'Family thing on' });
  f.pass();
  assert.match(f.item(r.item.id).problem, /Waiting for Dave to say yes/);
  assert.match(f.item(tr.item.id).problem, /Dave can't make it: Family thing on/);
  f.cmd('messageAnswer', { id: m.id, yes: true });
  f.pass();
  assert.equal(f.item(r.item.id).problem, 'Waiting for T-01 to come back.');
  assert.equal(f.item(r.item.id).stage, 'PACKED');
  assert.ok(f.until(() => f.truck('T-01').status === 'AT_SITE'));
  f.cmd('dispatch', { id: t1.id, destination: f.yard.id });
  assert.ok(
    f.until(() => f.item(r.item.id).stage === 'LOADING', 400),
    'loads as soon as T-01 is home',
  );
  assert.equal(f.item(r.item.id).trips[0].truck, t1.id);
  assert.ok(f.until(() => f.item(r.item.id).status === 'DONE', 800));
});

test('MATERIALS: cancelling a packed list lets its stillages go; a list already loading cannot be cancelled; moving and editing rules', (t) => {
  const f = planFixture(t, { now: L(D1, '08:00') });
  const { p, per } = f.stock(2);
  const site = f.site();
  const a = f.cmd('planMaterials', { day: D2, site: site.id, lines: [{ product: p.id, quantity: per }] });
  const edited = f.cmd('planMove', { id: a.item.id, lines: [{ product: p.id, quantity: per * 2 }] });
  assert.equal(edited.changed, true);
  assert.equal(f.item(a.item.id).lines[0].quantity, per * 2);
  const same = f.cmd('planMove', { id: a.item.id, day: D2 });
  assert.equal(same.changed, false);
  f.cmd('planMove', { id: a.item.id, day: D1, time: '10:00' });
  const moved = f.item(a.item.id);
  assert.equal(moved.day, D1);
  assert.equal(moved.stage, 'PACKED', 'moved to today: packed at once');
  assert.equal(moved.held.length, 2);
  assert.throws(
    () => f.cmd('planMove', { id: a.item.id, lines: [{ product: p.id, quantity: 1 }] }),
    /only be changed before it's packed/,
  );
  assert.throws(() => f.cmd('retire', { id: moved.held[0] }), /Held for the list for Bondi\. Cancel that first\./);
  const c = f.cmd('planCancel', { id: a.item.id });
  assert.match(c.message, /^Cancelled: the list for Bondi on /);
  assert.equal(f.sim.repo.all('reservation').filter((x) => x.active && x.plan === a.item.id).length, 0);
  assert.equal(f.item(a.item.id).status, 'CANCELLED');
  assert.throws(() => f.cmd('planCancel', { id: a.item.id }), /already cancelled/);
  const b = f.cmd('planMaterials', {
    day: D1,
    time: '08:00',
    site: site.id,
    lines: [{ product: p.id, quantity: per }],
  });
  assert.equal(f.item(b.item.id).stage, 'LOADING', 'due now: straight onto the next free truck');
  assert.throws(
    () => f.cmd('planCancel', { id: b.item.id }),
    /The truck is already loading this list\. Bring it back from the yard board instead\./,
  );
  assert.throws(() => f.cmd('planMove', { id: b.item.id, day: D2 }), /already loading/);
});

const team = (f, names, role = 'SCAFFOLDER') => names.map((name) => f.cmd('teamAdd', { name, role }).person.id);

test('WORKERS: asked the day before at 3 pm; one says no and is swapped; on the day the yes people go to the site (a busy one when free) and come home at 5 pm', (t) => {
  const f = planFixture(t, { now: L('2026-10-12', '09:00') });
  const site = f.site('Bondi', '12 Smith St');
  const [liam, noah, ava, mia] = team(f, ['Liam', 'Noah', 'Ava', 'Mia']);
  let W = null;
  for (let i = 1; i < 400 && !W; i++) {
    const d = addDays(D0, i),
      a = (id) => planSimAnswer({ person: id, day: d, subject: 'WORK', attempt: 1 }).yes;
    if (!a(liam) && a(noah) && a(ava)) W = d;
  }
  const eve = addDays(W, -1);
  const r = f.cmd('planWorkers', { day: W, site: site.id, count: 3, people: [liam, noah, ava] });
  assert.equal(
    r.message,
    '3 workers booked for Bondi on ' +
      dayLabel(W) +
      ' at 7:00 am. They get a message ' +
      dayLabel(eve) +
      ' at 3:00 pm.',
  );
  assert.equal(r.item.stage, 'BOOKED');
  assert.equal(r.item.words, 'Messages go out ' + dayLabel(eve) + ' at 3:00 pm');
  assert.ok(
    r.item.people.every((p) => p.answer === 'NOT_SENT' && p.sendAt === new Date(L(eve, '15:00')).toISOString()),
  );
  assert.equal(r.item.pickedBy, 'OFFICE');
  f.clock(eve, '14:59');
  f.pass();
  assert.equal(f.msgs(r.item.id).length, 0, 'nothing before 3 pm the day before');
  f.clock(eve, '15:00');
  f.pass();
  const ms = f.msgs(r.item.id);
  assert.equal(ms.length, 3);
  assert.ok(ms.every((m) => m.status === 'SENT' && m.subject === 'WORK' && m.needsAnswer));
  assert.equal(f.item(r.item.id).stage, 'ASKING');
  assert.equal(
    ms.find((m) => m.person === liam).text,
    "Hi Liam, you're on Bondi (12 Smith St) on " +
      dayLabel(W) +
      ' from 7:00 am. Can you make it? Please reply yes or no.',
  );
  assert.equal(
    f.sim.repo
      .all('notification')
      .filter((n) => n.title === 'Message sent' && /Asked 3 people to work at Bondi/.test(n.body)).length,
    1,
    'one note for the three',
  );
  f.at(L(eve, '15:00') + 91000);
  f.pass();
  let v = f.view(r.item.id);
  const row = (id) => v.people.find((p) => p.person === id);
  assert.equal(row(liam).answer, 'NO');
  assert.ok(row(liam).reason);
  assert.equal(row(noah).answer, 'YES');
  assert.equal(row(ava).answer, 'YES');
  assert.equal(v.flags.red, true);
  assert.equal(v.words, '2 of 3 said yes');
  const sw = f.cmd('planAsk', { item: r.item.id, person: mia, replace: liam });
  assert.equal(sw.message, 'Mia has been asked.');
  assert.equal(f.sim.repo.get(ms.find((m) => m.person === liam).id, 'message').status, 'CALLED_OFF');
  f.cmd('planReplies', { on: false });
  const miaMsg = f.msgs(r.item.id).find((m) => m.person === mia);
  assert.equal(miaMsg.status, 'SENT');
  f.cmd('messageAnswer', { id: miaMsg.id, yes: true, via: 'PHONE_VIEW' });
  assert.throws(
    () => f.cmd('planWorkers', { day: W, site: f.site('Parramatta').id, count: 1, people: [noah] }),
    /Noah is already at Bondi that day/,
  );
  assert.throws(() => f.cmd('planWorkers', { day: W, site: site.id, count: 1 }), /Change the one already booked/);
  // Noah is on a forklift move at 7:00: he goes when he is free
  const busy = f.sim.repo.get(noah, 'resource');
  busy.task = 'a-forklift-move';
  f.sim.repo.save(busy);
  f.clock(W, '07:00');
  f.pass();
  let it = f.item(r.item.id);
  assert.equal(it.status, 'ACTIVE');
  assert.equal(it.stage, 'ON_SITE');
  for (const id of [ava, mia]) {
    const w = f.sim.repo.get(id, 'resource');
    assert.equal(w.location, site.id);
    assert.equal(w.away.item, it.id);
    assert.equal(w.away.from, f.yard.id);
  }
  assert.equal(f.sim.repo.get(noah, 'resource').location, f.yard.id);
  assert.ok(f.sim.repo.all('notification').some((n) => n.title === 'On site' && n.body === '2 workers are at Bondi.'));
  const free = f.sim.repo.get(noah, 'resource');
  free.task = null;
  f.sim.repo.save(free);
  f.clock(W, '07:30');
  f.pass();
  assert.equal(f.sim.repo.get(noah, 'resource').location, site.id);
  const snap = f.sim.snapshot();
  assert.equal(
    snap.resources.filter((x) => x.type === 'WORKER' && x.location === site.id && x.away).length,
    3,
    'the map shows them at the site',
  );
  f.tick(3);
  assert.equal(f.sim.repo.get(ava, 'resource').location, site.id, 'they stay put while the engine ticks');
  f.clock(W, '17:00');
  f.pass();
  for (const id of [noah, ava, mia]) {
    const w = f.sim.repo.get(id, 'resource');
    assert.equal(w.location, f.yard.id);
    assert.equal(w.away, null);
  }
  it = f.item(r.item.id);
  assert.equal(it.status, 'DONE');
  assert.ok(it.people.filter((p) => p.moved).every((p) => p.homeAt));
});

test('WORKERS: a late yes on the day moves at once; auto-pick takes yard scaffolders by name, then spare site crew, never the last crane hand; short is flagged', (t) => {
  const f = planFixture(t, { now: L(D0, '16:00') });
  f.cmd('planReplies', { on: false });
  const a = f.site('Bondi'),
    b = f.site('Parramatta'),
    c = f.site('Manly');
  const [zed, abe] = team(f, ['Zed', 'Abe']);
  const r = f.cmd('planWorkers', { day: D1, site: a.id, count: 2 });
  assert.deepEqual(
    f.item(r.item.id).people.map((p) => p.person),
    [abe, zed],
    'scaffolders at the yard, by name',
  );
  assert.equal(r.item.pickedBy, 'AUTO');
  assert.match(r.message, /They've been sent a message\./, 'booked after 3 pm the day before: sent now');
  f.clock(D1, '07:00');
  f.pass();
  assert.equal(f.sim.repo.get(abe, 'resource').location, f.yard.id, 'no answer, nobody moves');
  assert.equal(f.view(r.item.id).people[0].answer, 'NO_ANSWER');
  f.clock(D1, '09:00');
  const m = f.msgs(r.item.id).find((x) => x.person === abe);
  f.cmd('messageAnswer', { id: m.id, yes: true });
  assert.equal(f.sim.repo.get(abe, 'resource').location, a.id, 'a late yes moves at once');
  // site crew: Bondi has a list that day (its crane is busy), Parramatta is the target, Manly can spare one of its two
  const { p, per } = f.stock(1);
  f.cmd('planMaterials', { day: D2, site: a.id, lines: [{ product: p.id, quantity: per }] });
  // then, as a last resort, yardsmen: never the one packing Bondi's list that day, and always two left at the yard
  const r2 = f.cmd('planWorkers', { day: D2, site: b.id, count: 7 });
  const picked = f.item(r2.item.id).people.map((x) => f.sim.repo.get(x.person, 'resource'));
  assert.deepEqual(
    picked.map((w) => w.name),
    ['Abe', 'Zed', 'Worker 1', 'Worker 2', 'Worker 3'],
  );
  assert.equal(picked[2].location, c.id, "one of Manly's two, never the last one");
  assert.ok(picked.slice(3).every((w) => w.location === f.yard.id && f.sim.roleOf(w) === 'YARDSMAN'));
  assert.ok(
    !picked.some((w) => w.id === f.item(f.sim.repo.all('planItem').find((i) => i.type === 'MATERIALS').id).packer),
    'never the packer',
  );
  assert.equal(f.item(r2.item.id).problem, 'Short by 2: nobody else is free that day. Tap Ask someone.');
  assert.match(r2.message, /Short by 2: nobody else is free that day/);
  assert.equal(f.view(r2.item.id).gaps, 2);
  assert.throws(() => f.cmd('planWorkers', { day: D2, site: b.id, time: '08:00', count: 21 }), /How many/);
});

test('daylight saving: allocations for Mon 5 Oct 2026 go out Sun 4 Oct at 3 pm AEDT; a hire truck on Mon 5 Apr 2027 arrives at 6:00 AEST', (t) => {
  const f = planFixture(t, { now: L('2026-10-01', '09:00') });
  const s = f.site();
  const [liam] = team(f, ['Liam']);
  f.cmd('planReplies', { on: false });
  const r = f.cmd('planWorkers', { day: '2026-10-05', site: s.id, count: 1 });
  f.at(Date.parse('2026-10-04T03:59:00Z'));
  f.pass();
  assert.equal(f.msgs(r.item.id).length, 0);
  f.at(Date.parse('2026-10-04T04:00:00Z'));
  f.pass();
  assert.equal(f.msgs(r.item.id).length, 1);
  assert.equal(f.msgs(r.item.id)[0].person, liam);
  f.at(L('2027-04-01', '09:00'));
  const h = f.cmd('planTruck', { day: '2027-04-05', hire: { size: 'SMALL' } });
  f.at(Date.parse('2027-04-04T19:59:00Z'));
  f.pass();
  assert.ok(!f.trucks().some((x) => x.hired));
  f.at(Date.parse('2027-04-04T20:00:00Z'));
  f.pass();
  assert.ok(f.trucks().some((x) => x.hired?.item === h.item.id));
});

test('RESTACK: part-full stillages of a part with no pack size are topped up to what the forklift can lift, at P3, then it finishes when the crew is quiet', (t) => {
  const f = planFixture(t, { now: L(D0, '09:00'), jobs: true });
  const { p, per } = f.stock(0);
  const box = (name, x) =>
    f.cmd('container', {
      name,
      location: f.yard.id,
      type: 'STILLAGE',
      length: 2000,
      width: 1000,
      height: 1000,
      tare: 50000,
      x,
      y: 2000,
    });
  const big = box('R-1', 2000),
    small = box('R-2', 5000),
    q1 = Math.floor(per * 0.6),
    q2 = Math.floor(per * 0.3);
  for (const [c, q] of [
    [big, q1],
    [small, q2],
  ])
    f.cmd('purchase', { container: c.id, product: p.id, quantity: q, reason: 'Stock added to the yard' });
  assert.ok(
    !f.sim.deriveJobs(f.yard).some((j) => j.key.startsWith('P5:CONSOLIDATE:')),
    'no re-stack, no pack size: the old rule offers nothing',
  );
  const r = f.cmd('planRestack', { day: D0, time: '09:00' });
  assert.equal(r.message, 'Re-stack booked for ' + dayLabel(D0) + ' at 9:00 am.');
  assert.equal(f.item(r.item.id).stage, 'WORKING');
  assert.equal(r.item.words, 'Crew is re-stacking');
  const job = f.sim.deriveJobs(f.yard).find((j) => j.key.startsWith('P5:CONSOLIDATE:'));
  assert.ok(job);
  assert.equal(job.priority, 3);
  assert.equal(job.params.cap, per);
  assert.equal(job.params.from, small.id);
  assert.equal(job.params.to, big.id);
  assert.equal(job.params.quantity, q2);
  assert.throws(() => f.cmd('planRestack', { day: D0 }), /already booked/);
  const moved = () =>
    f.db
      .prepare("SELECT COALESCE(SUM(quantity),0) n FROM ledger WHERE company_id=? AND event='CONSOLIDATED'")
      .get(f.user.company_id).n;
  assert.ok(
    f.until(() => moved() > 0, 300),
    'the crew tops it up',
  );
  assert.equal(f.sim.repo.quantity(big.id, p.id), q1 + q2);
  assert.equal(f.sim.repo.quantity(small.id, p.id), 0);
  assert.ok(f.sim.weight(f.sim.repo.get(big.id, 'container')) <= f.sim.gameLift(f.yard), 'still liftable');
  f.tick(5);
  f.pass();
  assert.equal(f.item(r.item.id).status, 'ACTIVE', 'not before a quiet minute');
  f.at(L(D0, '09:00') + 61000);
  f.pass();
  f.at(L(D0, '09:00') + 125000);
  f.pass();
  const it = f.item(r.item.id);
  assert.equal(it.status, 'DONE');
  assert.equal(it.moved.pieces, q2);
  assert.match(it.log.at(-1).text, new RegExp('^Re-stack done: ' + q2 + ' pieces topped up into fuller stillages, '));
  assert.ok(!f.sim.deriveJobs(f.yard).some((j) => j.key.startsWith('P5:CONSOLIDATE:')), 'back to the normal rules');
  const off = f.cmd('planRestack', { day: D1, time: '07:00' });
  f.cmd('jobsMode', { jobs: false });
  f.clock(D1, '07:00');
  f.pass();
  assert.equal(f.item(off.item.id).problem, 'Turn yard jobs on in the Control room so the crew can re-stack.');
  f.clock(D2, '08:00');
  f.pass();
  assert.equal(f.item(off.item.id).status, 'MISSED', 'never written as done');
  assert.equal(f.view(off.item.id).words, "Didn't go");
  assert.equal(f.item(off.item.id).why, 'yard jobs were switched off');
});

test('catch-up after the app was closed: a whole missed day of workers is closed without moving anyone, a late list still goes, late asks say so', (t) => {
  const f = planFixture(t, { now: L(D0, '09:00') });
  const s = f.site();
  team(f, ['Liam', 'Noah']);
  const { p, per } = f.stock(1);
  f.cmd('planReplies', { on: false });
  const w = f.cmd('planWorkers', { day: D1, site: s.id, count: 1 }),
    w2 = f.cmd('planWorkers', { day: D2, site: s.id, count: 1 }),
    m = f.cmd('planMaterials', { day: D1, site: s.id, lines: [{ product: p.id, quantity: per }] });
  f.clock(D2, '10:00');
  f.pass();
  const a = f.item(w.item.id);
  assert.equal(a.status, 'MISSED', 'never written as done');
  assert.ok(a.log.some((l) => l.text === "Didn't go: the day passed while the app was closed."));
  assert.ok(
    f.sim.repo
      .all('resource')
      .filter((r) => r.type === 'WORKER')
      .every((r) => !r.away),
  );
  const b = f.item(w2.item.id);
  assert.ok(b.log.some((l) => l.text === 'Sent late: the app was closed.'));
  assert.equal(f.msgs(b.id).length, 1);
  // a list whose whole day passed while the app was closed never goes by itself days late: nobody is asked, it waits, red, for a new day
  const late = f.view(m.item.id);
  assert.equal(late.flags.late, true);
  assert.equal(late.flags.red, true);
  assert.equal(f.item(m.item.id).status, 'MISSED');
  assert.equal(late.words, "Didn't go");
  assert.equal(
    f.item(m.item.id).problem,
    "Didn't go: the day passed while the app was closed. Pick a new day or cancel it.",
  );
  assert.equal(f.msgs(m.item.id).length, 0, 'no late pack message');
  assert.equal(late.canMove, true);
  f.cmd('planMove', { id: m.item.id, day: D2, time: '11:00' });
  assert.equal(f.item(m.item.id).status, 'ACTIVE');
  f.clock(D2, '11:00');
  f.pass();
  assert.ok(
    f.until(() => f.item(m.item.id).status === 'DONE', 800),
    'on its new day it goes',
  );
});

test('removing a site calls its plans off, lets its held stillages go and sends borrowed people home first; they survive the delete of an unused site', (t) => {
  const f = planFixture(t, { now: L(D1, '05:00') });
  const { p, per } = f.stock(2);
  const s = f.site('Bondi');
  const [liam] = team(f, ['Liam']);
  f.cmd('planReplies', { on: false });
  const m = f.cmd('planMaterials', { day: D1, time: '10:00', site: s.id, lines: [{ product: p.id, quantity: per }] }),
    w = f.cmd('planWorkers', { day: D1, site: s.id, count: 1, people: [liam] });
  f.cmd('messageAnswer', { id: f.msgs(w.item.id)[0].id, yes: true });
  f.clock(D1, '07:00');
  f.pass();
  assert.equal(f.item(m.item.id).stage, 'PACKED');
  assert.equal(f.sim.repo.get(liam, 'resource').location, s.id);
  const own = f.sim.repo
    .all('resource')
    .filter((r) => r.location === s.id && !r.away)
    .map((r) => r.id);
  const r = f.cmd('gameRemoveSite', { site: s.id });
  assert.equal(r.removed, true, 'never used: it goes completely');
  for (const id of [m.item.id, w.item.id]) {
    const it = f.item(id);
    assert.equal(it.status, 'CANCELLED');
    assert.equal(it.cancelReason, 'Site removed');
  }
  assert.equal(f.sim.repo.all('reservation').filter((x) => x.active && x.plan).length, 0);
  assert.ok(f.msgs(w.item.id).every((x) => x.status === 'CALLED_OFF'));
  const back = f.sim.repo.get(liam, 'resource');
  assert.equal(back.enabled, true);
  assert.equal(back.location, f.yard.id);
  assert.equal(back.away, null);
  for (const id of own)
    assert.equal(
      f.sim.repo.all('resource').some((x) => x.id === id),
      false,
      'its own crew went with it',
    );
  const undo = f.sim.repo.get(r.undo, 'siteUndo');
  assert.ok(!undo.crew.some((c) => c.id === liam), 'the Undo copy has only its own crew');
  f.cmd('gameRestoreSite', { undo: r.undo });
  assert.ok(
    f.sim.repo
      .all('notification')
      .some((n) => n.title === 'Plans cancelled' && /when it was removed\. Plan them again if needed\./.test(n.body)),
  );
  assert.equal(f.item(m.item.id).status, 'CANCELLED', 'Undo does not bring plans back');
});

test('a removed truck and a person who leaves: bookings say what to fix; borrowed people cannot be removed while away; the Office crew reset never switches them off', (t) => {
  const f = planFixture(t, { now: L(D0, '09:00') });
  f.cmd('teamStart');
  const dave = f.driver('Dave'),
    s = f.site();
  const { p, per } = f.stock(1);
  const [liam, noah] = team(f, ['Liam', 'Noah']);
  f.cmd('planReplies', { on: false });
  f.cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: f.yard.id, payload: 2000000 });
  const small = f.truck('L-01');
  const tr = f.cmd('planTruck', { day: D2, truck: small.id, driver: dave.id }),
    mat = f.cmd('planMaterials', {
      day: D2,
      site: s.id,
      lines: [{ product: p.id, quantity: per }],
      truckPlan: tr.item.id,
    });
  f.cmd('retire', { id: small.id });
  let it = f.item(tr.item.id);
  assert.equal(it.truck, null);
  assert.equal(it.problem, 'L-01 was removed. Cancel it and book another truck.');
  assert.equal(f.item(mat.item.id).truckPlan, null, 'the list goes on the next free truck');
  f.cmd('teamRemove', { id: dave.id });
  it = f.item(tr.item.id);
  assert.equal(it.driver, null);
  assert.equal(it.needsDriver, true);
  assert.ok(f.msgs(it.id).every((m) => m.status === 'CALLED_OFF'));
  const w = f.cmd('planWorkers', { day: D1, site: s.id, count: 2, people: [liam, noah] });
  f.cmd('teamRemove', { id: noah });
  assert.equal(f.item(w.item.id).people.length, 1);
  assert.equal(f.item(w.item.id).problem, 'Short by 1: nobody else is free that day. Tap Ask someone.');
  f.clock(D0, '15:00');
  f.pass();
  f.cmd('messageAnswer', { id: f.msgs(w.item.id).find((m) => m.person === liam).id, yes: true });
  f.clock(D1, '07:00');
  f.pass();
  assert.equal(f.sim.repo.get(liam, 'resource').location, s.id);
  assert.throws(() => f.cmd('teamRemove', { id: liam }), /Liam is at .* today\. Remove them tomorrow\./);
  f.cmd('resources', { location: s.id, workers: 2, machines: 1, stepMs: 100, speed: 100000, jobs: false });
  const l = f.sim.repo.get(liam, 'resource');
  assert.equal(l.enabled, true);
  assert.equal(l.location, f.yard.id, 'sent home before the reset');
  assert.ok(f.item(w.item.id).log.some((x) => x.text === 'Sent home: site crew was reset.'));
});

test('idempotency: a repeated command key makes one item; a pass run twice at the same moment writes nothing; the engine pass is throttled to once a second', (t) => {
  const f = planFixture(t, { now: L(D0, '09:00') });
  f.cmd('teamStart');
  const s = f.site();
  team(f, ['Liam']);
  const key = randomUUID();
  const a = f.cmd('planRestack', { day: D1 }, key),
    b = f.cmd('planRestack', { day: D1 }, key);
  assert.deepEqual(a, b);
  assert.equal(f.sim.repo.all('planItem').length, 1);
  assert.throws(() => f.cmd('planRestack', { day: D2 }, key), /different action/);
  f.cmd('planTruck', { day: D1, truck: f.truck('T-01').id, driver: f.driver('Dave').id });
  f.cmd('planWorkers', { day: D1, site: s.id, count: 1 });
  f.cmd('planTruck', { day: D0, time: '10:00', hire: { size: 'BIG' } });
  f.at(L(D0, '09:10'));
  f.pass();
  const versions = () =>
    f.db
      .prepare(
        "SELECT id,version FROM objects WHERE company_id=? AND kind IN ('planItem','message','resource','truck','reservation') ORDER BY id",
      )
      .all(f.user.company_id)
      .map((r) => r.id + '@' + r.version)
      .join(',');
  const once = versions();
  f.pass();
  assert.equal(versions(), once, 'nothing changed');
  const rev = f.sim.snapshot().plan.rev;
  f.pass();
  assert.equal(f.sim.snapshot().plan.rev, rev, 'no revision bump either');
  assert.equal(
    atomic(f.db, () => f.sim.planTick(0)),
    true,
  );
  assert.equal(
    atomic(f.db, () => f.sim.planTick(0)),
    false,
    'at most once a second',
  );
  f.at(L(D0, '09:10') + 1000);
  assert.equal(
    atomic(f.db, () => f.sim.planTick(0)),
    true,
  );
  assert.equal(
    atomic(f.db, () => f.sim.planTick(1000)),
    true,
    'or once a second of engine time',
  );
});

test("permissions: supervisors plan nothing, keep their own sites' paperwork, see their own sites' items (and the truck their list goes on, without mobiles); dollars are the owner's", (t) => {
  const f = planFixture(t, { now: L(D0, '09:00') });
  f.cmd('teamStart');
  const a = f.site('Bondi'),
    b = f.site('Parramatta');
  const { p, per } = f.stock(2);
  const person = (email, role) => {
    f.auth.addUser(f.user, {
      name: role === 'SUPERVISOR' ? 'Sue' : 'Max',
      email,
      password: 'demonstration-password',
      roles: [role],
    });
    const u = f.auth.authenticate(f.auth.login({ email, password: 'demonstration-password' }));
    return new Simulation(f.db, u);
  };
  const sup = person('sue@example.com', 'SUPERVISOR'),
    gm = person('max@example.com', 'GENERAL_MANAGER');
  f.cmd('siteDetails', { id: a.id, supervisor: sup.user.id });
  const run = (sim, action, input) => sim.execute(action, input, randomUUID());
  for (const [action, input] of [
    ['planTruck', { day: D1, truck: f.truck('T-01').id }],
    ['planWorkers', { day: D1, site: a.id, count: 1 }],
    ['messageAnswer', { id: 'x', yes: true }],
    ['teamAdd', { name: 'Zed', role: 'SCAFFOLDER' }],
    ['planReplies', { on: false }],
    ['teamStart', {}],
  ])
    assert.throws(() => run(sup, action, input), /Your role does not allow this action\./, action);
  assert.match(
    run(sup, 'paperworkAdd', { type: 'SWMS', site: a.id, expiresOn: D2 }).message,
    /^SWMS for Bondi saved\./,
  );
  assert.throws(
    () => run(sup, 'paperworkAdd', { type: 'SWMS', site: b.id, expiresOn: D2 }),
    /You can only access your assigned sites\./,
  );
  assert.throws(
    () => run(sup, 'paperworkAdd', { type: 'PERMIT', title: 'Council permit', expiresOn: D2 }),
    /Your role does not allow this action\./,
  );
  f.cmd('teamUpdate', { id: f.driver('Dave').id, mobile: '0412 345 678' });
  const tr = f.cmd('planTruck', { day: D1, truck: f.truck('T-01').id, driver: f.driver('Dave').id });
  f.cmd('planMaterials', { day: D1, site: a.id, lines: [{ product: p.id, quantity: per }], truckPlan: tr.item.id });
  f.cmd('planMaterials', { day: D1, site: b.id, lines: [{ product: p.id, quantity: per }] });
  f.cmd('planRestack', { day: D1 });
  f.cmd('planWorkers', { day: D2, site: b.id, count: 1 });
  const own = f.sim.planMonth(D1.slice(0, 7));
  assert.equal(own.items.length, 5);
  assert.equal(own.canPlan, true);
  const truckRow = own.items.find((i) => i.type === 'TRUCK').driverRow;
  assert.equal(truckRow.mobile, '+61412345678');
  assert.match(truckRow.smsHref ?? '', /^sms:\+61412345678\?&body=Hi%20Dave/);
  const theirs = sup.planMonth(D1.slice(0, 7));
  assert.deepEqual(theirs.items.map((i) => i.type).sort(), ['MATERIALS', 'TRUCK']);
  assert.equal(theirs.items.find((i) => i.type === 'MATERIALS').site, a.id);
  assert.equal(theirs.items.find((i) => i.type === 'TRUCK').driverRow.mobile, null);
  assert.equal(theirs.items.find((i) => i.type === 'TRUCK').driverRow.smsHref, null);
  assert.equal(theirs.canPlan, false);
  assert.deepEqual(theirs.drivers, []);
  assert.equal(theirs.team, null);
  assert.deepEqual(
    theirs.sites.map((s) => s.id),
    [a.id],
  );
  assert.throws(() => sup.teamView(), /Your role does not allow/);
  assert.throws(() => sup.personView('driver', f.driver('Dave').id), /Your role does not allow/);
  assert.throws(() => f.sim.planMonth('2028-01'), /Choose a month within a year of today\./);
  assert.throws(() => f.sim.planMonth('2026-13'), /within a year/);
  const gmView = gm.todayView();
  assert.equal(gmView.business.money, null);
  assert.ok(gmView.business.gear);
  assert.equal(sup.todayView().business, null);
  const ownerView = f.sim.todayView();
  assert.equal(ownerView.business.money.noRates, true);
  assert.equal(ownerView.business.money.words, "Set your prices to see what you're earning");
  // a price and gear on hire: real figures, ex GST, and the built-up total with GST
  f.cmd('hireRate', { product: p.id, week: 7000 });
  f.cmd('gameSend', { site: a.id, lines: [{ product: p.id, quantity: per }] });
  assert.ok(f.until(() => f.piecesAt(a.id, p.id) === per, 600));
  const money = f.sim.todayView().business.money;
  assert.equal(money.noRates, false);
  assert.equal(money.thisWeek, per * 1000);
  assert.equal(money.thisMonth, per * 1000);
  assert.equal(money.toInvoice, per * 1000 + Math.round(per * 100));
  assert.match(money.footnote, /doesn't record payments/);
});

test('held stillages: a yard list never reserves them, new stock is never stacked on them, and a stocktake on one holds the truck up with a reason', (t) => {
  const f = planFixture(t, { now: L(D0, '09:00') });
  const demo = f.cmd('seed');
  const pack = demo.find((x) => f.sim.effective(x.id).packQuantity === 100);
  const site = f.site();
  f.cmd('gameAddStock', { lines: [{ product: pack.id, quantity: 200 }] });
  const r = f.cmd('planMaterials', {
    day: D0,
    time: '10:00',
    site: site.id,
    lines: [{ product: pack.id, quantity: 100 }],
  });
  const held = f.item(r.item.id).held;
  assert.equal(held.length, 1);
  f.cmd('gameAddStock', { lines: [{ product: pack.id, quantity: 100 }] });
  assert.ok(!f.sim.containers().some((c) => c.support === held[0]), 'nothing new on top of it');
  const list = f.cmd('createLoadList', { site: site.id, lines: [{ product: pack.id, quantity: 100 }], neededOn: D0 });
  const out = f.cmd('allocateLoadList', { id: list.id, truck: f.truck('T-02').id });
  const reserved = f.sim.repo
    .all('reservation')
    .filter((x) => x.active && x.task)
    .map((x) => x.container);
  assert.ok(reserved.length > 0);
  assert.ok(!reserved.includes(held[0]), 'the yard list took the other stillages');
  assert.ok(out);
  f.cmd('count', { scope: held[0] });
  f.clock(D0, '10:00');
  f.pass();
  assert.match(f.item(r.item.id).problem, /stocktake/i, 'loadTruck refuses a stillage under a stocktake');
  assert.equal(f.item(r.item.id).stage, 'PACKED');
});

test('once a day the planner prunes closed items and messages over 400 days old, and removed paperwork 400 days past its expiry', (t) => {
  const f = planFixture(t, { now: L(D0, '09:00') });
  const old = addDays(D0, -401),
    recent = addDays(D0, -30);
  const add = (kind, data) => f.sim.repo.add(kind, data).id;
  const gone = [
    add('planItem', { type: 'RESTACK', day: old, time: '07:00', status: 'DONE', stage: 'WAITING', log: [] }),
    add('message', { day: old, status: 'YES', person: 'x', item: 'y' }),
    add('paperwork', { type: 'SWMS', title: 'SWMS', site: null, expiresOn: old, archived: true }),
  ];
  const kept = [
    add('planItem', { type: 'RESTACK', day: recent, time: '07:00', status: 'DONE', stage: 'WAITING', log: [] }),
    add('paperwork', { type: 'SWMS', title: 'SWMS', site: null, expiresOn: old, archived: false }),
    add('planItem', { type: 'RESTACK', day: old, time: '07:00', status: 'PLANNED', stage: 'WAITING', log: [] }),
  ];
  assert.equal(
    atomic(f.db, () => f.sim.planTick(0)),
    true,
  );
  const ids = new Set(
    f.db
      .prepare('SELECT id FROM objects WHERE company_id=?')
      .all(f.user.company_id)
      .map((r) => r.id),
  );
  for (const id of gone) assert.equal(ids.has(id), false);
  for (const id of kept) assert.equal(ids.has(id), true);
});
