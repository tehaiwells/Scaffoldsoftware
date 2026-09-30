process.env.TZ = 'Australia/Sydney';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { planFixture, D0, L } from './helpers/plan-fixture.js';
import { addDays } from '../src/domain/schedule.js';
import { planSimAnswer } from '../src/domain/plantime.js';
import { createApp } from '../src/server.js';
// Part 5 (owner brief 30 September 2026), the Practice yard: tasks with a priority per worker per day, a gear list as a task with its
// three steps (Got the list per worker, Packed and Truck loaded once), a plain task's Done per worker, the office ticking for someone,
// the gear list's hook (taskListSync), the day-before and day-of messages, the day-end flag, the simulated Done, and the views.
const D1 = addDays(D0, 1),
  D2 = addDays(D0, 2);
function team(f) {
  const kev = f.cmd('teamAdd', { name: 'Kevin', job: 'YARD' }).person,
    sam = f.cmd('teamAdd', { name: 'Samuel', job: 'YARD' }).person,
    jo = f.cmd('teamAdd', { name: 'Joanne', job: 'ONSITE' }).person;
  return { kev, sam, jo };
}
const list = (f, site, day = D1, extra = {}) => {
  const { p } = f.stock(2);
  return f.cmd('planMaterials', {
    day,
    time: day === D0 ? '10:00' : '07:00',
    site: site.id,
    lines: [{ product: p.id, quantity: 12 }],
    ...extra,
  }).item;
};
const task = (f, id) => f.sim.repo.get(id, 'workTask');

test('a plain task: one per priority per day, at most three a day, up to 20 words of validation; a gear list task takes its name, site and time from the list; a second call adds people', (t) => {
  const f = planFixture(t);
  const { kev, sam, jo } = team(f),
    site = f.site('Bondi');
  const a = f.cmd('taskCreate', {
    kind: 'PLAIN',
    day: D1,
    name: 'Sweep the racks',
    time: '09:00',
    workers: [{ person: kev.id, priority: 1 }],
  });
  assert.equal(a.message, 'Sweep the racks on Wed 14 Oct at 9:00 am: Kevin is on it.');
  assert.deepEqual(
    [a.task.kind, a.task.siteName, a.task.workers[0].priority, a.task.status],
    ['PLAIN', 'the yard', 1, 'OPEN'],
  );
  assert.throws(
    () => f.cmd('taskCreate', { kind: 'PLAIN', day: D1, name: 'Another', workers: [{ person: kev.id, priority: 1 }] }),
    /Kevin already has a P1 that day: Sweep the racks\./,
  );
  f.cmd('taskCreate', { kind: 'PLAIN', day: D1, name: 'Second', workers: [{ person: kev.id, priority: 2 }] });
  f.cmd('taskCreate', { kind: 'PLAIN', day: D1, name: 'Third', workers: [{ person: kev.id, priority: 3 }] });
  assert.throws(
    () => f.cmd('taskCreate', { kind: 'PLAIN', day: D2, name: 'x', workers: [{ person: kev.id, priority: 4 }] }),
    /Priority must be a whole number between 1 and 3/,
  );
  assert.throws(
    () => f.cmd('taskCreate', { kind: 'PLAIN', day: D1, name: '', workers: [{ person: kev.id, priority: 1 }] }),
    /Give the task a name/,
  );
  assert.throws(() => f.cmd('taskCreate', { kind: 'PLAIN', day: D1, name: 'x', workers: [] }), /Pick who does it\./);
  assert.throws(
    () =>
      f.cmd('taskCreate', {
        kind: 'PLAIN',
        day: addDays(D0, -1),
        name: 'x',
        workers: [{ person: kev.id, priority: 1 }],
      }),
    /That day has passed/,
  );
  // the list
  const it = list(f, site);
  const g = f.cmd('taskCreate', { kind: 'LIST', list: it.id, workers: [{ person: sam.id, priority: 1 }] });
  assert.deepEqual(
    [g.task.name, g.task.day, g.task.time, g.task.site, g.task.listWords],
    ['Bondi gear', D1, '07:00', site.id, 'Bondi gear · the yard → Bondi'],
  );
  assert.equal(g.task.lines.length, 1);
  assert.throws(
    () => f.cmd('taskCreate', { kind: 'LIST', list: it.id, day: D2, workers: [{ person: kev.id, priority: 1 }] }),
    /The list is on Wed 14 Oct\. Its task goes on that day\./,
  );
  assert.throws(
    () => f.cmd('taskCreate', { kind: 'LIST', list: it.id, workers: [{ person: kev.id, priority: 1 }] }),
    /Kevin already has a P1 that day/,
  );
  const again = f.cmd('taskCreate', { kind: 'LIST', list: it.id, workers: [{ person: jo.id, priority: 1 }] });
  assert.equal(again.message, 'Joanne added.');
  assert.equal(again.task.id, g.task.id, 'one task per list');
  assert.throws(
    () => f.cmd('taskCreate', { kind: 'PLAIN', day: D1, name: 'Fourth', workers: [{ person: kev.id, priority: 3 }] }),
    /already has a P3|already has three tasks/,
  );
  assert.equal(f.sim.taskForList(it.id).id, g.task.id);
  assert.throws(() => f.cmd('taskCancel', { id: g.task.id }), /Cancel the gear list on Daily activities/);
  assert.throws(() => f.cmd('taskUpdate', { id: g.task.id, name: 'Other' }), /follows its list/);
  const u = f.cmd('taskUpdate', {
    id: a.task.id,
    name: 'Sweep the racks well',
    time: '10:00',
    note: 'Behind the office',
  });
  assert.deepEqual([u.task.name, u.task.time, u.task.note], ['Sweep the racks well', '10:00', 'Behind the office']);
});

test('the steps of a shared gear-list task: each worker taps Got the list, Packed and Truck loaded once by anyone, in order; the task is done on Truck loaded; a step already there is 409 with its time', (t) => {
  const f = planFixture(t);
  const { kev, sam, jo } = team(f),
    site = f.site('Bondi');
  const it = list(f, site, D0);
  const g = f.cmd('taskCreate', {
    kind: 'LIST',
    list: it.id,
    workers: [
      { person: kev.id, priority: 1 },
      { person: sam.id, priority: 1 },
      { person: jo.id, priority: 2 },
    ],
  }).task;
  const tomorrow = f.cmd('taskCreate', {
    kind: 'PLAIN',
    day: D1,
    name: 'Later',
    workers: [{ person: kev.id, priority: 1 }],
  }).task;
  assert.throws(
    () => f.cmd('taskStep', { id: tomorrow.id, step: 'RECEIVED', for: kev.id }),
    /A plain task has one Done\./,
  );
  assert.throws(() => f.cmd('taskDone', { id: tomorrow.id, for: kev.id }), /Not today yet\./);
  assert.throws(() => f.cmd('taskStep', { id: g.id, step: 'PACKED', for: kev.id }), /Tap Got the list first\./);
  assert.throws(() => f.cmd('taskStep', { id: g.id, step: 'RECEIVED' }), /Say who did it\./);
  f.clock(D0, '07:12');
  const r1 = f.cmd('taskStep', { id: g.id, step: 'RECEIVED', for: kev.id });
  assert.equal(r1.message, 'Got the list.');
  assert.throws(
    () => f.cmd('taskStep', { id: g.id, step: 'RECEIVED', for: kev.id }),
    /Got the list: already done at 07:12\./,
  );
  try {
    f.cmd('taskStep', { id: g.id, step: 'RECEIVED', for: kev.id });
  } catch (e) {
    assert.equal(e.code, 'ALREADY_DONE');
    assert.equal(e.status, 409);
  }
  assert.throws(() => f.cmd('taskStep', { id: g.id, step: 'LOADED', for: kev.id }), /Tap Packed and ready first\./);
  const r2 = f.cmd('taskStep', { id: g.id, step: 'PACKED', for: kev.id });
  assert.equal(r2.message, 'Packed and ready.');
  assert.throws(
    () => f.cmd('taskStep', { id: g.id, step: 'PACKED', for: sam.id }),
    /Tap Got the list first\./,
    'Sam has not got the list',
  );
  f.cmd('taskStep', { id: g.id, step: 'RECEIVED', for: sam.id });
  assert.throws(
    () => f.cmd('taskStep', { id: g.id, step: 'PACKED', for: sam.id }),
    /Packed and ready: already done at 07:12\./,
  );
  const v = f.sim.taskView(task(f, g.id));
  assert.deepEqual(
    v.workers.map((w) => [w.name, !!w.steps.RECEIVED, !!w.steps.PACKED, w.next]),
    [
      ['Kevin', true, true, 'LOADED'],
      ['Samuel', true, true, 'LOADED'],
      ['Joanne', false, true, 'RECEIVED'],
    ],
  );
  assert.deepEqual(v.progress, { done: 3, total: 5 });
  const r3 = f.cmd('taskStep', { id: g.id, step: 'LOADED', for: sam.id });
  assert.equal(r3.message, 'Truck loaded. Done.');
  const done = task(f, g.id);
  assert.deepEqual(
    [done.status, done.done.kind, done.done.onBehalfOf, done.steps.LOADED.byName],
    ['DONE', 'ON_BEHALF', sam.id, 'Owner'],
  );
  assert.throws(() => f.cmd('taskStep', { id: g.id, step: 'RECEIVED', for: jo.id }), /already done/);
  const tv = f.sim.tasksView({ day: D0 });
  assert.deepEqual(tv.summary, { done: 1, total: 1 });
  assert.deepEqual(
    tv.workers
      .filter((w) => w.tasks.length)
      .map((w) => [w.name, w.done, w.tasks[0].workers.find((x) => x.person === w.person).done]),
    [
      ['Joanne', 1, true],
      ['Kevin', 1, true],
      ['Samuel', 1, true],
    ],
  );
});

test('a plain task is done when every worker has tapped Done (or the office marks it); the phone shows P1, then P3 when there is no P2, no idle between', (t) => {
  const f = planFixture(t);
  const { kev, sam } = team(f);
  const p1 = f.cmd('taskCreate', {
      kind: 'PLAIN',
      day: D0,
      name: 'Sweep',
      time: '10:00',
      workers: [
        { person: kev.id, priority: 1 },
        { person: sam.id, priority: 1 },
      ],
    }).task,
    p3 = f.cmd('taskCreate', {
      kind: 'PLAIN',
      day: D0,
      name: 'Stack the empties',
      workers: [{ person: kev.id, priority: 3 }],
    }).task;
  let my = f.sim.taskMyDay(kev.id, D0);
  assert.deepEqual(
    my.tasks.map((x) => [x.name, x.priority, x.now, x.mine.next]),
    [
      ['Sweep', 1, true, 'DONE'],
      ['Stack the empties', 3, false, 'DONE'],
    ],
  );
  const d1 = f.cmd('taskDone', { id: p1.id, for: kev.id });
  assert.equal(d1.message, 'Done. Waiting for the others on it.');
  assert.equal(task(f, p1.id).status, 'OPEN');
  my = f.sim.taskMyDay(kev.id, D0);
  assert.deepEqual(
    my.tasks.map((x) => [x.name, x.now, x.mine.done]),
    [
      ['Sweep', false, true],
      ['Stack the empties', true, false],
    ],
    'Kevin moves straight to P3',
  );
  assert.equal(f.sim.taskMyDay(sam.id, D0).tasks[0].now, true, 'Sam still has Sweep as now');
  const d2 = f.cmd('taskDone', { id: p1.id, for: sam.id });
  assert.equal(d2.message, 'Sweep is done.');
  assert.equal(task(f, p1.id).status, 'DONE');
  assert.throws(() => f.cmd('taskDone', { id: p3.id }), /Say who did it, or tick All done\./);
  const d3 = f.cmd('taskDone', { id: p3.id, all: true, note: 'Phoned in' });
  assert.equal(d3.task.status, 'DONE');
  assert.equal(task(f, p3.id).workers[0].steps.DONE.note, 'Phoned in');
  assert.throws(() => f.cmd('taskDone', { id: p3.id, all: true }), /already done/);
  // assign and unassign
  const p2 = f.cmd('taskCreate', {
    kind: 'PLAIN',
    day: D1,
    name: 'Tidy',
    workers: [{ person: kev.id, priority: 1 }],
  }).task;
  assert.equal(f.cmd('taskAssign', { id: p2.id, person: sam.id, priority: 2 }).message, 'Samuel is on it.');
  assert.throws(() => f.cmd('taskAssign', { id: p2.id, person: sam.id, priority: 3 }), /Samuel is already on it\./);
  assert.equal(f.cmd('taskUnassign', { id: p2.id, person: sam.id }).message, 'Samuel taken off.');
  f.clock(D1, '08:00');
  f.cmd('taskDone', { id: p2.id, for: kev.id });
  assert.equal(task(f, p2.id).status, 'DONE');
  const c = f.cmd('taskCreate', {
    kind: 'PLAIN',
    day: D1,
    name: 'Cancel me',
    workers: [{ person: kev.id, priority: 2 }],
  }).task;
  assert.equal(f.cmd('taskCancel', { id: c.id, reason: 'Rain' }).message, 'Cancelled: Cancel me.');
  assert.equal(task(f, c.id).status, 'CANCELLED');
});

test('taskListSync, the gear list side of the seam: RECEIVED, PACKED and LOADED as engine marks (never overwriting a person’s), CANCELLED, MOVED', (t) => {
  const f = planFixture(t);
  const { kev, sam } = team(f),
    site = f.site('Bondi');
  const it = list(f, site, D0);
  const g = f.cmd('taskCreate', {
    kind: 'LIST',
    list: it.id,
    workers: [
      { person: kev.id, priority: 1 },
      { person: sam.id, priority: 2 },
    ],
  }).task;
  const now = L(D0, '06:00');
  f.cmd('taskStep', { id: g.id, step: 'RECEIVED', for: kev.id }); // Kevin's own, before the engine
  assert.equal(f.sim.taskListSync('nothing', 'PACKED', now), null);
  f.sim.taskListSync(it.id, 'RECEIVED', now);
  let x = task(f, g.id);
  assert.deepEqual(
    [x.workers[0].steps.RECEIVED.kind, x.workers[1].steps.RECEIVED.kind],
    ['ON_BEHALF', 'ENGINE'],
    'a person’s mark is kept',
  );
  f.sim.taskListSync(it.id, 'PACKED', now + 60000);
  f.sim.taskListSync(it.id, 'PACKED', now + 120000);
  x = task(f, g.id);
  assert.equal(x.steps.PACKED.at, new Date(now + 60000).toISOString(), 'idempotent: the first mark stays');
  f.sim.taskListSync(it.id, 'LOADED', now + 180000, {
    at: new Date(now + 180000).toISOString(),
    by: null,
    byName: 'Truck 1',
    kind: 'ENGINE',
    onBehalfOf: null,
  });
  x = task(f, g.id);
  assert.deepEqual([x.status, x.done.kind, x.steps.LOADED.byName], ['DONE', 'ENGINE', 'Truck 1']);
  // moved: the task follows its list; cancelled: the task goes with it
  const it2 = list(f, site, D1);
  const g2 = f.cmd('taskCreate', { kind: 'LIST', list: it2.id, workers: [{ person: kev.id, priority: 1 }] }).task;
  f.clock(D0, '15:00');
  f.pass();
  assert.ok(task(f, g2.id).workers[0].message, 'asked for tomorrow');
  f.cmd('planMove', { id: it2.id, day: D2, time: '08:00' });
  f.sim.taskListSync(it2.id, 'MOVED', f.sim.planNow());
  x = task(f, g2.id);
  assert.deepEqual([x.day, x.time, x.workers[0].message], [D2, '08:00', null]);
  assert.equal(
    f.sim.repo.all('message').find((m) => m.person === kev.id && m.subject === 'TASK_READY').status,
    'CALLED_OFF',
  );
  f.cmd('planCancel', { id: it2.id });
  f.sim.taskListSync(it2.id, 'CANCELLED', f.sim.planNow());
  assert.equal(task(f, g2.id).status, 'CANCELLED');
});

test('messages: one TASK_READY per worker per day at 3 pm listing their tasks in priority order, one TASK_DAY notice at 6 am; the simulated answer; the day-end flag once; the Practice yard’s simulated Done two hours after a plain task’s time', (t) => {
  const f = planFixture(t);
  const { kev, sam } = team(f),
    site = f.site('Bondi');
  const it = list(f, site, D1);
  f.cmd('taskCreate', { kind: 'LIST', list: it.id, workers: [{ person: kev.id, priority: 2 }] });
  f.cmd('taskCreate', {
    kind: 'PLAIN',
    day: D1,
    name: 'Sweep the racks',
    time: '09:00',
    workers: [{ person: kev.id, priority: 1 }],
  });
  const p3 = f.cmd('taskCreate', {
    kind: 'PLAIN',
    day: D1,
    name: 'Stack the empties',
    workers: [{ person: kev.id, priority: 3 }],
  }).task;
  const msgs = () => f.sim.repo.all('message').filter((m) => m.person === kev.id && m.itemType === 'TASK');
  f.clock(D0, '14:59');
  f.pass();
  assert.equal(msgs().length, 0);
  f.clock(D0, '15:00');
  f.pass();
  const [ready] = msgs();
  assert.equal(msgs().length, 1, 'one message for the three tasks');
  assert.equal(ready.subject, 'TASK_READY');
  assert.equal(
    ready.text,
    'Hi Kevin, tomorrow: P1 Sweep the racks (9:00 am, the yard), P2 pack Bondi gear (7:00 am, Bondi), P3 Stack the empties. Ready? Please reply Confirm or Can’t make it. – Tee Scaffolding',
  );
  assert.ok(
    f.sim.taskDayRows(D1).every((x) => x.workers[0].message === ready.id),
    'every task of the day points at the one message',
  );
  const s = planSimAnswer(ready);
  f.at(L(D0, '15:00') + s.delaySec * 1000);
  f.pass();
  const tv = f.sim.tasksView({ day: D1 });
  assert.equal(tv.workers.find((w) => w.name === 'Kevin').answer, s.yes ? 'YES' : 'NO');
  if (!s.yes) assert.ok(f.sim.repo.all('notification').some((n) => /Kevin can’t make it on Wed 14 Oct/.test(n.body)));
  f.clock(D1, '06:00');
  f.pass();
  const day = msgs().find((m) => m.subject === 'TASK_DAY');
  assert.ok(day && !day.needsAnswer);
  assert.match(day.text, /^Today: P1 Sweep the racks \(9:00 am, the yard\), P2 pack Bondi gear/);
  assert.equal(msgs().filter((m) => m.subject === 'TASK_DAY').length, 1);
  f.sim.execute('messageSeen', { id: day.id }, randomUUID());
  assert.ok(f.sim.repo.get(day.id, 'message').seenAt);
  // the simulated Done: Sweep (9:00) is done by itself at 11:00; the list task and the untimed P3 are not
  f.clock(D1, '10:59');
  f.pass();
  assert.equal(f.sim.taskDayRows(D1).find((x) => x.name === 'Sweep the racks').status, 'OPEN');
  f.clock(D1, '11:00');
  f.pass();
  const sweep = f.sim.taskDayRows(D1).find((x) => x.name === 'Sweep the racks');
  assert.deepEqual(
    [sweep.status, sweep.done.kind, sweep.workers[0].steps.DONE.byName],
    ['DONE', 'SIMULATED', 'Kevin (simulated)'],
  );
  assert.equal(task(f, p3.id).status, 'OPEN', 'no time: the crew leaves it for a person');
  // the demo answers switch off: nothing is done by itself
  f.cmd('planReplies', { on: false });
  const p4 = f.cmd('taskCreate', {
    kind: 'PLAIN',
    day: D1,
    name: 'Quiet',
    time: '05:00',
    workers: [{ person: sam.id, priority: 1 }],
  }).task;
  assert.ok(p4);
  f.pass();
  assert.equal(task(f, p4.id).status, 'OPEN');
  // day end: the open ones are flagged once, never done
  f.clock(D1, '17:00');
  f.pass();
  f.pass();
  const flagged = f.sim.taskDayRows(D1).filter((x) => x.flag);
  assert.deepEqual(
    flagged.map((x) => x.status),
    ['OPEN', 'OPEN', 'OPEN'],
  );
  assert.equal(
    f.sim.repo.all('notification').filter((n) => n.title === 'Not confirmed').length,
    3,
    JSON.stringify(f.sim.repo.all('notification').map((n) => n.title + ' | ' + n.body)),
  );
  assert.equal(
    f.sim
      .tasksView({ day: D1 })
      .workers.find((w) => w.name === 'Kevin')
      .tasks.filter((x) => x.flag).length,
    2,
    'Kevin’s two open ones (Quiet is Samuel’s)',
  );
});

test('someone leaves the team: off every open task from today they had not started; a task with nobody stays open', (t) => {
  const f = planFixture(t);
  const { kev, sam } = team(f);
  const a = f.cmd('taskCreate', {
      kind: 'PLAIN',
      day: D0,
      name: 'Started',
      workers: [
        { person: kev.id, priority: 1 },
        { person: sam.id, priority: 1 },
      ],
    }).task,
    b = f.cmd('taskCreate', { kind: 'PLAIN', day: D1, name: 'Alone', workers: [{ person: kev.id, priority: 1 }] }).task;
  f.cmd('taskDone', { id: a.id, for: kev.id });
  f.cmd('teamRemove', { id: kev.id });
  assert.deepEqual(
    task(f, a.id).workers.map((w) => w.person),
    [kev.id, sam.id],
    'a started part stays on the record',
  );
  assert.deepEqual(task(f, b.id).workers, []);
  assert.equal(task(f, b.id).status, 'OPEN');
  const tv = f.sim.tasksView({ day: D1 });
  assert.equal(tv.summary.total, 1);
  assert.ok(!tv.workers.some((w) => w.name === 'Kevin'));
  // taken off the roster that day: off the tasks that day not started
  const c = f.cmd('taskCreate', {
    kind: 'PLAIN',
    day: D2,
    name: 'Rostered off',
    workers: [{ person: sam.id, priority: 1 }],
  }).task;
  f.cmd('rosterPick', { person: sam.id, days: [D2] });
  f.cmd('rosterClear', { person: sam.id, days: [D2] });
  assert.deepEqual(task(f, c.id).workers, []);
  assert.match(task(f, c.id).log.at(-1).text, /not rostered/);
});

test('HTTP: /api/tasks, /api/prestart, /api/roster and /api/team?roster=1 for the office; a supervisor sees their site’s workers only and makes plain tasks there', async (t) => {
  const f = planFixture(t);
  const { kev, jo } = team(f),
    site = f.site('Bondi');
  f.cmd('teamUpdate', { id: jo.id, where: site.id });
  f.auth.addUser(f.user, {
    name: 'Sue',
    email: 'sue-tasks@example.com',
    password: 'demonstration-password',
    roles: ['SUPERVISOR'],
  });
  const sueToken = f.auth.login({ email: 'sue-tasks@example.com', password: 'demonstration-password' });
  f.cmd('siteDetails', { id: site.id, supervisor: f.auth.authenticate(sueToken).id });
  f.cmd('taskCreate', { kind: 'PLAIN', day: D0, name: 'Yard job', workers: [{ person: kev.id, priority: 1 }] });
  f.cmd('rosterPick', { person: kev.id, days: [D0] });
  const server = createApp(f.db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const owner = { cookie: 'session=' + f.auth.login({ email: f.user.email, password: 'demonstration-password' }) },
    sup = { cookie: 'session=' + sueToken };
  const get = async (path, headers) => {
    const r = await fetch(base + path, { headers });
    return { status: r.status, body: await r.json() };
  };
  const post = async (path, data, headers) => {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify(data),
    });
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await get('/api/tasks')).status, 401);
  const tasks = await get('/api/tasks?day=' + D0, owner);
  assert.equal(tasks.status, 200);
  assert.deepEqual(tasks.body.summary, { done: 0, total: 1 });
  const kevRow = tasks.body.workers.find((w) => w.name === 'Kevin');
  assert.deepEqual(
    [kevRow.rostered, kevRow.tasks[0].name, kevRow.tasks[0].workers[0].steps.DONE, tasks.body.canPlan],
    ['ROSTERED', 'Yard job', null, true],
  );
  assert.ok(tasks.body.team.length >= 3 && tasks.body.places.length >= 2);
  const pre = await get('/api/prestart?day=' + D0, owner);
  assert.equal(pre.status, 200);
  assert.deepEqual(
    [pre.body.company, pre.body.workers.map((w) => w.name), pre.body.workers[0].tasks[0].name, pre.body.summary],
    ['Tee Scaffolding', ['Kevin'], 'Yard job', { workers: 1, tasks: 1, done: 0 }],
  );
  const roster = await get('/api/roster?person=' + kev.id + '&from=' + D0 + '&to=' + D1, owner);
  assert.deepEqual(
    roster.body.days.map((d) => [d.day, d.status]),
    [[D0, 'ROSTERED']],
  );
  assert.equal((await get('/api/roster?person=' + kev.id, sup)).status, 403);
  const tm = await get('/api/team?roster=1', owner);
  assert.ok(tm.body.people.find((p) => p.name === 'Kevin').roster.next14.length === 1);
  // the supervisor: Bondi's workers only, read-only ticks, a plain task at Bondi for Joanne
  const supTasks = await get('/api/tasks?day=' + D0, sup);
  assert.equal(supTasks.status, 200);
  assert.deepEqual(
    [supTasks.body.workers.map((w) => w.name), supTasks.body.canPlan, supTasks.body.canTask],
    [['Joanne', 'Worker 1', 'Worker 2'], false, true],
    'Bondi’s crew only',
  );
  const made = await post(
    '/api/commands/taskCreate',
    { kind: 'PLAIN', day: D0, name: 'Handrails', site: site.id, workers: [{ person: jo.id, priority: 1 }] },
    sup,
  );
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const wrong = await post(
    '/api/commands/taskCreate',
    { kind: 'PLAIN', day: D0, name: 'Not hers', site: site.id, workers: [{ person: kev.id, priority: 2 }] },
    sup,
  );
  assert.equal(wrong.status, 409);
  assert.match(wrong.body.error, /Kevin is not at your site\./);
  assert.equal((await post('/api/commands/rosterPick', { person: jo.id, days: [D1] }, sup)).status, 403);
  assert.equal(
    (await post('/api/commands/taskStep', { id: made.body.task.id, step: 'RECEIVED', for: jo.id }, sup)).status,
    403,
  );
  const supPre = await get('/api/prestart?day=' + D0, sup);
  assert.deepEqual(
    supPre.body.workers.map((w) => w.name),
    ['Joanne'],
    'rostered or tasked at Bondi only',
  );
  assert.deepEqual(supPre.body.drivers, [], 'no trucks for a supervisor');
});
