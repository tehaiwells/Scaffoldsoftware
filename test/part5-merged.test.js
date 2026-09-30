process.env.TZ = 'Australia/Sydney';
// Part 5 merged (ADR 0011): the gear list and the workers' task are one thing end to end. One tap makes the list, books the truck and driver
// and makes the workers' task; the task's steps are the list's worker chain; the calendar lists the day's tasks beside its bookings; the
// day-before messages reach the driver (READY) and every worker (TASK_READY, and ROSTER when rostered) once each; the Practice yard's
// simulated people answer through the one message registry and its engine finishes the task; a real yard's task follows the phones and the
// trip, and the clock changes no record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { planFixture, D0, L } from './helpers/plan-fixture.js';
import { liveFixture, records, D0 as LD0 } from './helpers/live-fixture.js';
import { addDays } from '../src/domain/schedule.js';
import { planSimAnswer } from '../src/domain/plantime.js';
import { chipOfTask } from '../public/plan-cal.js';
import { Simulation } from '../src/simulation.js';
import { crewLink, crewClaim, crewAuthenticate } from '../src/crew-auth.js';
const D1 = addDays(D0, 1);
const LD1 = addDays(LD0, 1);

// the Practice yard: stock, a site, a truck, Dave, and two yard workers
function ready(t, opts = {}) {
  const f = planFixture(t, opts);
  const { p, per } = f.stock(3);
  const bondi = f.site('Bondi');
  const truck1 = f.trucks()[0];
  const dave = f.cmd('teamAdd', { name: 'Dave', role: 'DRIVER' }).person;
  const kev = f.cmd('teamAdd', { name: 'Kevin', job: 'YARD' }).person;
  const sam = f.cmd('teamAdd', { name: 'Samuel', job: 'YARD' }).person;
  return Object.assign(f, { p, per, bondi, truck1, dave, kev, sam });
}
const list = (f, extra = {}) =>
  f.cmd('gearListCreate', {
    from: { kind: 'yard' },
    to: { kind: 'site', id: f.bondi.id },
    lines: [{ product: f.p.id, quantity: f.per }],
    day: D1,
    time: '07:00',
    truck: f.truck1.id,
    driver: f.dave.id,
    workers: [
      { person: f.kev.id, priority: 1 },
      { person: f.sam.id, priority: 1 },
    ],
    ...extra,
  });
const subjectsOf = (f, person) =>
  f.sim.repo
    .all('message')
    .filter((m) => m.person === person)
    .map((m) => m.subject)
    .sort();
const yesAll = (f) => {
  for (const m of f.sim.repo.all('message'))
    if (m.status === 'SENT' && m.needsAnswer) f.cmd('messageAnswer', { id: m.id, yes: true, via: 'OFFICE' });
};

test('one tap makes the list, the truck booking and the workers’ task; the calendar lists the day’s tasks; the day-before messages reach the driver and each worker once; the office answers a roster ask through the one registry', (t) => {
  const f = ready(t);
  f.cmd('planReplies', { on: false });
  f.cmd('rosterPick', { person: f.kev.id, days: [D1] });
  const r = list(f);
  assert.match(r.message, /^Bondi gear on Wed 14 Oct at 7:00 am\. .* with Dave booked\. Kevin and Samuel are on it\.$/);
  assert.deepEqual(
    r.task.workers.map((w) => w.name + ' P' + w.priority),
    ['Kevin P1', 'Samuel P1'],
  );
  assert.equal(r.task.kind, 'LIST');
  assert.equal(f.sim.taskForList(r.item.id).id, r.task.id, 'the task is the list’s (read through the index)');
  const v = f.sim.planItemView(f.item(r.item.id));
  assert.equal(v.task.id, r.task.id, 'the list’s view carries its task');
  assert.deepEqual(
    v.task.workers.map((w) => [w.name, w.steps.RECEIVED, w.steps.PACKED, w.steps.LOADED]),
    [
      ['Kevin', null, null, null],
      ['Samuel', null, null, null],
    ],
    'three empty ticks per worker',
  );
  // a plain task the same day: the calendar lists both, the list’s task first (P1 before P2), the plain one as a chip of its own
  const plain = f.cmd('taskCreate', {
    kind: 'PLAIN',
    day: D1,
    name: 'Sweep the racks',
    time: '09:00',
    workers: [{ person: f.kev.id, priority: 2 }],
  }).task;
  const month = f.sim.planMonth(D1.slice(0, 7));
  assert.deepEqual(
    month.tasks.map((x) => [x.day, x.kind, x.name]),
    [
      [D1, 'LIST', 'Bondi gear'],
      [D1, 'PLAIN', 'Sweep the racks'],
    ],
  );
  assert.equal(chipOfTask(month.tasks[1]).label, 'P2 Sweep the racks · Kevin');
  assert.equal(chipOfTask(month.tasks[1]).tone, 'crew');
  assert.ok(
    month.items.some((i) => i.id === r.item.id && i.gear && i.task?.id === r.task.id),
    'the list is on the calendar with its task',
  );
  // 3 pm the day before: READY to Dave (beside his DRIVE ask), TASK_READY to Kevin and Samuel, ROSTER to Kevin (rostered); once each
  f.clock(D0, '15:00');
  f.pass();
  f.pass();
  f.pass();
  assert.deepEqual(subjectsOf(f, f.dave.id), ['DRIVE', 'READY']);
  assert.deepEqual(subjectsOf(f, f.kev.id), ['ROSTER', 'TASK_READY']);
  assert.deepEqual(subjectsOf(f, f.sam.id), ['TASK_READY']);
  const kevAsk = f.sim.repo.all('message').find((m) => m.subject === 'TASK_READY' && m.person === f.kev.id);
  assert.match(
    kevAsk.text,
    /^Hi Kevin, tomorrow: P1 pack Bondi gear \(7:00 am, Bondi\), P2 Sweep the racks \(9:00 am, the yard\)\./,
  );
  // the office answers the roster ask for Kevin: the day is confirmed at once, and the reply carries the day (the registry’s reply hook)
  const ask = f.sim.repo.all('message').find((m) => m.subject === 'ROSTER' && m.person === f.kev.id);
  const a = f.cmd('messageAnswer', { id: ask.id, yes: true, via: 'OFFICE' });
  assert.equal(a.message, 'Marked as confirmed for Kevin.');
  assert.equal(a.rosterDay.status, 'CONFIRMED');
  assert.equal(f.sim.rosterOf(f.kev.id, D1).status, 'CONFIRMED');
  // the day: the simulated crew packs and the truck drives; the task hears every step (ENGINE marks) and is done when the truck is loaded
  yesAll(f);
  f.clock(D1, '06:01');
  f.pass();
  const got = f.sim.repo.get(r.task.id, 'workTask');
  assert.ok(
    got.workers.every((w) => w.steps.RECEIVED?.kind === 'ENGINE'),
    'the crew has the list: Received for both, by the engine',
  );
  f.clock(D1, '07:01');
  assert.ok(
    f.until(() => f.item(r.item.id).status === 'DONE', 3000),
    'delivered by the engine',
  );
  const done = f.sim.repo.get(r.task.id, 'workTask');
  assert.equal(done.status, 'DONE');
  assert.deepEqual([done.steps.PACKED.kind, done.steps.LOADED.kind, done.done.kind], ['ENGINE', 'ENGINE', 'ENGINE']);
  const tv = f.sim.tasksView({ day: D1 });
  assert.deepEqual(tv.summary, { done: 1, total: 2 }, 'the list’s task is done, the plain one is not');
  const kevRow = tv.workers.find((w) => w.name === 'Kevin');
  assert.deepEqual(
    kevRow.tasks.map((x) => [x.priority ?? x.workers.find((w) => w.name === 'Kevin').priority, x.name, x.status]),
    [
      [1, 'Bondi gear', 'DONE'],
      [2, 'Sweep the racks', 'OPEN'],
    ],
  );
  const dv = f.sim.planItemView(f.item(r.item.id));
  assert.ok(
    dv.task.workers.every((w) => w.steps.RECEIVED && w.steps.PACKED && w.steps.LOADED),
    'the list’s card shows every tick',
  );
  assert.equal(dv.chain.filter((c) => c.done).length, 5, 'and the driver’s chain');
  // Pre-start for the day: both workers, the list’s lines, ‘with’ the other
  const ps = f.sim.prestartView({ day: D1 });
  const kevPs = ps.workers.find((w) => w.name === 'Kevin');
  assert.equal(kevPs.tasks[0].name, 'Bondi gear');
  assert.deepEqual(
    kevPs.tasks[0].lines.map((l) => l.quantity),
    [f.per],
  );
  assert.deepEqual(kevPs.tasks[0].workersWith, ['Samuel']);
  assert.ok(ps.drivers.some((d) => d.name === 'Dave'));
  assert.equal(plain.status, 'OPEN');
});

test('the Practice yard’s simulated people answer the roster and task asks by themselves through the one registry, and the engine keeps the old asks’ answers byte for byte', (t) => {
  const f = ready(t);
  f.cmd('rosterPick', { person: f.kev.id, days: [D1] });
  const r = list(f);
  f.clock(D0, '15:00');
  f.pass();
  const asks = f.sim.repo
    .all('message')
    .filter((m) => m.needsAnswer && ['ROSTER', 'TASK_READY', 'READY'].includes(m.subject));
  assert.equal(asks.length, 4, 'ROSTER (Kevin), TASK_READY (Kevin, Samuel), READY (Dave)');
  const latest = Math.max(...asks.map((m) => Date.parse(m.sentAt) + planSimAnswer(m).delaySec * 1000));
  f.at(latest + 1000);
  f.pass();
  for (const m of asks) {
    const s = planSimAnswer(m),
      saved = f.sim.repo.get(m.id, 'message');
    assert.equal(saved.status, s.yes ? 'YES' : 'NO', m.subject + ' answered by the simulation');
    assert.equal(saved.answer.via, 'SIMULATED');
  }
  const roster = asks.find((m) => m.subject === 'ROSTER');
  assert.equal(f.sim.rosterOf(f.kev.id, D1).status, planSimAnswer(roster).yes ? 'CONFIRMED' : 'DENIED');
  assert.equal(f.sim.rosterOf(f.kev.id, D1).answer.via, 'SIMULATED');
  const kevTask = f.sim.taskView(f.sim.repo.get(r.task.id, 'workTask')).workers.find((w) => w.name === 'Kevin');
  assert.equal(
    kevTask.answer,
    planSimAnswer(asks.find((m) => m.subject === 'TASK_READY' && m.person === f.kev.id)).yes ? 'YES' : 'NO',
  );
  const readyMsg = f.sim.repo.get(asks.find((m) => m.subject === 'READY').id, 'message');
  assert.equal(f.item(r.item.id).readyNo ? 'NO' : 'YES', readyMsg.status, 'the driver’s READY answer marks the list');
});

function phone(f, person) {
  const made = crewLink(f.auth, f.user, { person: person.id });
  const claimed = crewClaim(f.auth, { token: made.token, label: 'Test phone' });
  const user = crewAuthenticate(f.db, claimed.token);
  const sim = new Simulation(f.db, user);
  return { user, sim, cmd: (a, i = {}, key = randomUUID()) => sim.execute(a, i, key), me: () => sim.crewMe() };
}

test('a real yard: the list’s task follows the phones and the trip (Got the list on each phone, Packed and ready also packs the trip, the driver’s Loaded & left finishes the task with his own mark); the clock changes no record', (t) => {
  const f = liveFixture(t);
  const kev = f.team.Kev,
    sam = f.team.Sam;
  const r = f.cmd('gearListCreate', {
    from: { kind: 'yard' },
    to: { kind: 'site', id: f.site.id },
    lines: [{ product: f.product.id, quantity: 7 }],
    day: LD1,
    time: '07:00',
    truck: f.truck.id,
    driver: f.team.Dave.id,
    workers: [
      { person: kev.id, priority: 1 },
      { person: sam.id, priority: 1 },
    ],
  });
  assert.match(r.message, /Kev and Sam are on it\. O-1: Held exactly\.$/);
  const before = records(f.db, f.company);
  f.clock(LD0, '15:00');
  for (let i = 0; i < 300; i++) f.pass();
  f.clock(LD1, '06:30');
  for (let i = 0; i < 300; i++) f.pass();
  assert.deepEqual(records(f.db, f.company), before, 'the clock only sent messages and set flags');
  assert.deepEqual(subjectsOf(f, f.team.Dave.id), ['DAY', 'DRIVE', 'READY']);
  assert.deepEqual(
    subjectsOf(f, kev.id),
    ['PACK', 'TASK_DAY', 'TASK_READY'],
    'a yard hand also gets the list’s pack notice, as before',
  );
  assert.deepEqual(subjectsOf(f, sam.id), ['TASK_DAY', 'TASK_READY']);
  const task = f.sim.repo.get(r.task.id, 'workTask');
  assert.equal(task.status, 'OPEN');
  assert.ok(
    task.workers.every((w) => !w.steps.RECEIVED),
    'nobody received anything by itself',
  );
  // the phones
  const kp = phone(f, kev),
    sp = phone(f, sam),
    dp = phone(f, f.team.Dave);
  assert.equal(kp.me().myDay.tasks[0].name, 'Bondi gear');
  assert.equal(kp.me().myDay.tasks[0].now, true);
  const first = kp.cmd('taskStep', { id: task.id, step: 'RECEIVED' }, 'k-kev-received');
  sp.cmd('taskStep', { id: task.id, step: 'RECEIVED' });
  assert.throws(() => sp.cmd('taskStep', { id: task.id, step: 'LOADED' }), /Packed/, 'packed comes before loaded');
  kp.cmd('taskStep', { id: task.id, step: 'PACKED' });
  const trip = f.sim.repo.get(f.sim.repo.get(f.item(r.item.id).order, 'order').trip, 'trip');
  assert.ok(trip.steps.PACKED, 'a yard hand’s Packed and ready also records the pack on the trip');
  assert.deepEqual([trip.steps.PACKED.kind, trip.steps.PACKED.byName], ['PERSON', 'Kev']);
  assert.ok(
    f.sim.repo.get(task.id, 'workTask').log.some((l) => /^Pack recorded on /.test(l.text)),
    'and the task says so',
  );
  // the driver: Loaded & left moves the stock and finishes the task, with his own mark on it
  dp.cmd('tripLoaded', { trip: trip.id });
  const done = f.sim.repo.get(task.id, 'workTask');
  assert.equal(done.status, 'DONE');
  assert.equal(done.steps.LOADED.kind, 'PERSON');
  assert.equal(done.steps.LOADED.byName, 'Dave');
  assert.equal(done.steps.PACKED.byName, 'Kev', 'the pack stays Kev’s (never overwritten)');
  const tv = f.sim.tasksView({ day: LD1 });
  assert.deepEqual(tv.summary, { done: 1, total: 1 });
  const v = f.sim.planItemView(f.item(r.item.id));
  assert.ok(v.task.workers.every((w) => w.steps.RECEIVED && w.steps.PACKED && w.steps.LOADED));
  assert.equal(v.chain.find((c) => c.step === 'LOADED').done, true);
  assert.equal(v.chain.find((c) => c.step === 'PACKED').done, true);
  assert.equal(kp.me().myDay.tasks[0].workers.find((w) => w.name === 'Kev').done, true);
  assert.equal(f.sim.planMonth(LD1.slice(0, 7)).tasks[0].status, 'DONE', 'the calendar’s task list says so too');
  // the same tap sent again with its key returns the first result, even now the task is done (one key per tap)
  assert.equal(kp.cmd('taskStep', { id: task.id, step: 'RECEIVED' }, 'k-kev-received').message, first.message);
  assert.equal(first.message, 'Got the list.');
});
