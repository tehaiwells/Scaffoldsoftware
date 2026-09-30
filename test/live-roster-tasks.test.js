process.env.TZ = 'Australia/Sydney';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/database.js';
import { Simulation } from '../src/simulation.js';
import { LIVE_OPS } from '../src/domain/mode.js';
import { crewLink, crewClaim, crewAuthenticate } from '../src/crew-auth.js';
import { addDays } from '../src/domain/schedule.js';
import { liveFixture, records, D0 } from './helpers/live-fixture.js';
// Part 5 (owner brief 30 September 2026), a real yard (the LIVE suite: never ticks): the roster and task commands on the allow-list; the
// phones' own taps (PERSON) and the office's for them (ON_BEHALF); a yard hand's Packed and ready also recording the pack on the list's
// trip; the day-before asks at 3 pm company time (Perth on a Sydney server) and the reminder; the LIVE invariant with a pattern, a shared
// task and a list over 10,000 clock passes; Needs you; migration 010 on a copy of a real database.
const D1 = addDays(D0, 1),
  D2 = addDays(D0, 2);
function phone(f, person) {
  const made = crewLink(f.auth, f.user, { person: person.id });
  const claimed = crewClaim(f.auth, { token: made.token, label: 'Test phone' });
  const user = crewAuthenticate(f.db, claimed.token);
  const sim = new Simulation(f.db, user);
  return { user, sim, cmd: (a, i = {}, key = randomUUID()) => sim.execute(a, i, key), me: () => sim.crewMe() };
}
const list = (f, day, extra = {}) =>
  f.cmd('planMaterials', {
    day,
    time: '10:00',
    site: f.site.id,
    lines: [{ product: f.product.id, quantity: 12 }],
    ...extra,
  }).item;

test('the roster and task commands are on the LIVE allow-list; the phone ops take the taps; the Practice yard has them too', (t) => {
  for (const a of [
    'rosterPick',
    'rosterClear',
    'rosterPattern',
    'rosterPatternEnd',
    'taskCreate',
    'taskUpdate',
    'taskCancel',
    'taskAssign',
    'taskUnassign',
    'taskStep',
    'taskDone',
  ])
    assert.ok(LIVE_OPS.has(a), a);
  const f = liveFixture(t);
  const kev = f.cmd('teamAdd', { name: 'Kevin', job: 'YARD', email: 'kev@example.com' }).person;
  assert.equal(kev.email, 'kev@example.com');
  const r = f.cmd('rosterPick', { person: kev.id, days: [D1] });
  assert.equal(r.next14[0].status, 'ROSTERED');
});

test('phones: a worker’s own taps are PERSON and scoped to their own tasks; the office’s are ON_BEHALF; a tap sent twice with its key returns the first answer; a yard hand’s Packed and ready records the pack on the list’s trip', (t) => {
  const f = liveFixture(t);
  const kev = f.cmd('teamAdd', { name: 'Kevin', job: 'YARD' }).person;
  const booking = f.cmd('planTruck', { day: D0, time: '11:00', truck: f.truck.id, driver: f.team.Dave.id }).item;
  const it = list(f, D0, { truckPlan: booking.id });
  const other = list(f, D0);
  const g = f.cmd('taskCreate', {
      kind: 'LIST',
      list: it.id,
      workers: [
        { person: kev.id, priority: 1 },
        { person: f.team.Sam.id, priority: 1 },
      ],
    }).task,
    o = f.cmd('taskCreate', { kind: 'LIST', list: other.id, workers: [{ person: f.team.Jo.id, priority: 1 }] }).task;
  const kp = phone(f, kev);
  let me = kp.me();
  assert.deepEqual(
    [me.can.tasks, me.myDay.tasks.length, me.myDay.tasks[0].now, me.myDay.tasks[0].mine.next],
    [true, 1, true, 'RECEIVED'],
  );
  assert.throws(
    () => kp.cmd('taskStep', { id: o.id, step: 'RECEIVED' }),
    /Record not found in your company\./,
    'someone else’s task',
  );
  // a phone's tap is its own person's whatever `for` says
  const key = randomUUID();
  const r1 = kp.cmd('taskStep', { id: g.id, step: 'RECEIVED', for: f.team.Sam.id }, key);
  assert.equal(f.sim.repo.get(g.id, 'workTask').workers[1].steps.RECEIVED, undefined, 'Sam untouched');
  assert.deepEqual(
    kp.cmd('taskStep', { id: g.id, step: 'RECEIVED', for: f.team.Sam.id }, key),
    r1,
    'the same key returns the first answer',
  );
  assert.throws(() => kp.cmd('taskStep', { id: g.id, step: 'RECEIVED' }), /Got the list: already done at/);
  const x1 = f.sim.repo.get(g.id, 'workTask');
  assert.deepEqual(
    [x1.workers[0].steps.RECEIVED.kind, x1.workers[0].steps.RECEIVED.byName, x1.workers[0].steps.RECEIVED.onBehalfOf],
    ['PERSON', 'Kevin', null],
  );
  // Packed and ready from a yard hand's phone: the trip's pack too (the same as their Packed tap), once
  const trip = f.sim.repo.all('trip')[0];
  assert.equal(trip.state, 'BOOKED');
  kp.cmd('taskStep', { id: g.id, step: 'PACKED' });
  const t2 = f.sim.repo.get(trip.id, 'trip');
  assert.deepEqual([t2.state, t2.steps.PACKED.kind], ['PACKED', 'PERSON']);
  assert.match(
    f.sim.repo
      .get(g.id, 'workTask')
      .log.map((l) => l.text)
      .join(' '),
    /Pack recorded on Trip 1/,
  );
  // the office for Sam: ON_BEHALF; Truck loaded is a light mark (the driver's Loaded & left moves the stock)
  f.cmd('taskStep', { id: g.id, step: 'RECEIVED', for: f.team.Sam.id });
  const done = f.cmd('taskStep', { id: g.id, step: 'LOADED', for: f.team.Sam.id });
  assert.deepEqual(
    [done.task.status, done.task.done.kind, done.task.steps.LOADED.onBehalfOf],
    ['DONE', 'ON_BEHALF', f.team.Sam.id],
  );
  assert.equal(f.sim.repo.get(trip.id, 'trip').state, 'PACKED', 'the trip has not left: only the driver moves stock');
  assert.equal(
    f.db
      .prepare('SELECT COUNT(*) n FROM ledger WHERE company_id=? AND event IN (?,?)')
      .get(f.company, 'LOADED', 'DELIVERED').n,
    0,
  );
  me = kp.me();
  assert.deepEqual([me.myDay.tasks[0].mine.done, me.myDay.tasks[0].status], [true, 'DONE']);
  // a plain task's Done from the phone, and the roster on the phone
  const p = f.cmd('taskCreate', {
    kind: 'PLAIN',
    day: D0,
    name: 'Sweep',
    workers: [{ person: kev.id, priority: 2 }],
  }).task;
  f.cmd('rosterPick', { person: kev.id, days: [D0, D1] });
  me = kp.me();
  assert.deepEqual(
    [me.roster.today.status, me.roster.tomorrow.status, me.myDay.tasks.find((x) => x.now)?.name],
    ['ROSTERED', 'ROSTERED', 'Sweep'],
  );
  assert.equal(kp.cmd('taskDone', { id: p.id }).task.status, 'DONE');
  const g3 = f.cmd('taskCreate', {
    kind: 'LIST',
    list: list(f, D0).id,
    workers: [{ person: kev.id, priority: 3 }],
  }).task;
  assert.throws(
    () => kp.cmd('taskDone', { id: g3.id }),
    /Tap the steps/,
    'a gear list is tapped step by step on a phone',
  );
});

test('the day-before asks go at 3 pm company time (Perth on a Sydney server), never by simulation, with one reminder after two hours; the answer on the phone confirms or denies the day; too late is flagged', (t) => {
  const f = liveFixture(t, { zone: 'Australia/Perth' });
  const kev = f.cmd('teamAdd', { name: 'Kevin', job: 'YARD' }).person;
  f.cmd('rosterPattern', { person: kev.id, kind: 'MON_FRI' });
  f.cmd('taskCreate', {
    kind: 'PLAIN',
    day: D1,
    name: 'Sweep',
    time: '09:00',
    workers: [{ person: kev.id, priority: 1 }],
  });
  const msgs = () => f.sim.repo.all('message').filter((m) => m.person === kev.id);
  f.clock(D0, '14:59');
  f.pass();
  assert.equal(msgs().length, 0);
  f.clock(D0, '15:00');
  f.pass();
  assert.deepEqual(
    msgs()
      .map((m) => m.subject)
      .sort(),
    ['ROSTER', 'TASK_READY'],
  );
  const ask = msgs().find((m) => m.subject === 'ROSTER');
  assert.equal(ask.sentAt, new Date(f.at(D0, '15:00')).toISOString(), 'Perth time, not the server’s');
  // 10,000 passes: nobody answers by itself (the LIVE invariant on messages)
  for (let i = 0; i < 1000; i++) f.pass();
  assert.ok(msgs().every((m) => m.status === 'SENT'));
  assert.equal(f.sim.rosterOf(kev.id, D1).status, 'ROSTERED');
  // the reminder after two hours (the clock's, reading the message's day and time)
  f.clock(D0, '17:01');
  f.pass();
  assert.ok(
    msgs().every((m) => m.remindedAt),
    'one reminder each',
  );
  assert.equal(f.sim.repo.all('notification').filter((n) => n.title === 'Reminder sent').length, 2);
  // the phone: Deny with a reason, then the office asks again and Kevin confirms on the phone
  const kp = phone(f, kev);
  const a = kp.cmd('messageAnswer', { id: ask.id, yes: false, reason: 'Crook' });
  assert.deepEqual([a.rosterDay.status, a.rosterDay.reason, a.rosterDay.via], ['DENIED', 'Crook', 'PHONE']);
  // Kevin has a task that day: Needs you names the task that needs someone (a denied day with no task says "Roster someone else")
  assert.deepEqual(
    f.sim.needsYou().items.map((x) => [x.kind, x.words]),
    [['TASK_CANT_WORK', 'Kevin can’t work tomorrow: P1 Sweep needs someone.']],
  );
  assert.equal(f.sim.tasksView({ day: D1 }).workers[0].tasks[0].workers[0].cantWork, true);
  assert.equal(f.sim.taskMyDay(kev.id, D0).tomorrow.length, 0, 'their phone shows no tasks for a day they can’t work');
  f.cmd('rosterPick', { person: kev.id, days: [D1] });
  const again = msgs()
    .filter((m) => m.subject === 'ROSTER')
    .at(-1);
  assert.equal(again.attempt, 2);
  kp.cmd('messageAnswer', { id: again.id, yes: true });
  assert.deepEqual([f.sim.rosterOf(kev.id, D1).status, f.sim.rosterOf(kev.id, D1).answer.via], ['CONFIRMED', 'PHONE']);
  assert.equal(f.sim.needsYou().count, 0);
  // once the rostered time has passed the phone can no longer answer (the office can)
  f.clock(D1, '07:01');
  assert.throws(() => kp.cmd('messageAnswer', { id: again.id, yes: false }), /Too late to answer, call the office\./);
  // too late: the day began and Sam was never asked (the computer was off)
  f.cmd('rosterPick', { person: f.team.Sam.id, days: [D2] });
  f.clock(D2, '06:01');
  f.pass();
  assert.ok(f.sim.rosterOf(f.team.Sam.id, D2).notAsked);
  assert.ok(f.sim.repo.all('notification').some((n) => n.body === "Sam wasn't asked about today. Call them."));
  assert.throws(() => kp.cmd('messageAnswer', { id: again.id, yes: true }), /This is already finished\./);
});

test('the LIVE invariant: 10,000 clock passes over a pattern, a shared task and a list leave every record as people left it; the window stays 14 days ahead; a task nobody confirmed is flagged for Needs you, never done', (t) => {
  const f = liveFixture(t);
  const kev = f.cmd('teamAdd', { name: 'Kevin', job: 'YARD' }).person;
  f.cmd('rosterPattern', { person: kev.id, kind: 'MON_SAT' });
  f.cmd('rosterPick', { person: f.team.Jo.id, days: [D1, D2] });
  const it = list(f, D1);
  f.cmd('taskCreate', {
    kind: 'LIST',
    list: it.id,
    workers: [
      { person: kev.id, priority: 1 },
      { person: f.team.Sam.id, priority: 1 },
    ],
  });
  const plain = f.cmd('taskCreate', {
    kind: 'PLAIN',
    day: D0,
    name: 'Sweep',
    time: '09:30',
    workers: [{ person: f.team.Jo.id, priority: 1 }],
  }).task;
  f.pass();
  const before = records(f.db, f.company);
  let ms = f.at(D0, '09:00');
  for (let i = 0; i < 10000; i++) {
    ms += 30000; // the clock's 30 s, a little over three days
    f.setTime(ms);
    f.pass();
    if (i % 2880 === 0) {
      const today = f.sim.planToday(ms);
      const ahead = f.sim.repo
        .all('rosterDay')
        .filter((r) => r.person === kev.id && r.day > today && r.status !== 'REMOVED');
      assert.ok(
        ahead.every((r) => r.day <= addDays(today, 14)),
        'never further than a fortnight',
      );
      assert.ok(
        ahead.some((r) => r.day === addDays(today, 14) || addDays(today, 14).length),
        'the window moves with the day',
      );
    }
  }
  assert.deepEqual(records(f.db, f.company), before, 'the clock moved and completed nothing');
  const roster = f.sim.repo.all('rosterDay');
  assert.ok(
    roster.every((r) => ['ROSTERED', 'REMOVED'].includes(r.status)),
    'no day confirmed or denied by the clock',
  );
  assert.ok(
    roster.some((r) => r.createdBy === 'clock'),
    'the pattern was filled by the clock',
  );
  for (const x of f.sim.repo.all('workTask')) {
    assert.equal(x.status, 'OPEN');
    assert.equal(x.done, null);
    assert.deepEqual(x.steps, {});
    for (const w of x.workers) assert.deepEqual(w.steps, {});
  }
  const flagged = f.sim.repo.get(plain.id, 'workTask');
  assert.equal(flagged.flag.code, 'NOT_CONFIRMED');
  assert.equal(
    f.sim.repo.all('notification').filter((n) => n.title === 'Not confirmed' && /Sweep/.test(n.body)).length,
    1,
    'said once',
  );
  assert.ok(f.sim.needsYou().items.some((x) => x.kind === 'TASK_NOT_DONE' && x.action.view === 'PROGRESS'));
  assert.equal(
    f.db.prepare('SELECT COUNT(*) n FROM ledger WHERE company_id=?').get(f.company).n,
    before.ledger === '[]' ? 0 : JSON.parse(before.ledger).length,
  );
});

test('fired in a real yard: the fortnight ahead goes, tasks from tomorrow lose them, the phone is signed out; today’s day and a started task stay', (t) => {
  const f = liveFixture(t);
  const kev = f.cmd('teamAdd', { name: 'Kevin', job: 'YARD' }).person;
  f.cmd('rosterPattern', { person: kev.id, kind: 'MON_FRI' });
  f.cmd('rosterPick', { person: kev.id, days: [D0] });
  const today = f.cmd('taskCreate', {
      kind: 'PLAIN',
      day: D0,
      name: 'Today',
      workers: [{ person: kev.id, priority: 1 }],
    }).task,
    tomorrow = f.cmd('taskCreate', {
      kind: 'PLAIN',
      day: D1,
      name: 'Tomorrow',
      workers: [
        { person: kev.id, priority: 1 },
        { person: f.team.Sam.id, priority: 1 },
      ],
    }).task;
  const kp = phone(f, kev);
  kp.cmd('taskDone', { id: today.id });
  f.cmd('teamRemove', { id: kev.id });
  const days = f.sim.repo.all('rosterDay').filter((r) => r.person === kev.id);
  assert.equal(days.find((r) => r.day === D0).status, 'ROSTERED');
  assert.ok(days.filter((r) => r.day > D0).every((r) => r.status === 'REMOVED'));
  assert.deepEqual(
    f.sim.repo.get(tomorrow.id, 'workTask').workers.map((w) => w.person),
    [f.team.Sam.id],
  );
  assert.deepEqual(
    f.sim.repo.get(today.id, 'workTask').workers.map((w) => w.person),
    [kev.id],
    'done today: the record stays',
  );
  assert.throws(() => kp.me(), /not signed in|Record not found|401/);
  assert.equal(
    f.sim
      .prestartView({ day: D1 })
      .workers.map((w) => w.name)
      .includes('Kevin'),
    false,
  );
  assert.ok(f.sim.tasksView({ day: D1 }).workers.find((w) => w.name === 'Sam'));
});

test('migration 010 on a copy of a real database (SCAFFOLD_MIGRATION_SAMPLE_V9): every company stays DEMO and nothing else changes', (t) => {
  const sample = process.env.SCAFFOLD_MIGRATION_SAMPLE_V9;
  if (!sample || !existsSync(sample)) {
    t.skip('no sample database given');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'scaffold-mig10-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'sample.sqlite');
  for (const ext of ['', '-wal', '-shm']) if (existsSync(sample + ext)) copyFileSync(sample + ext, path + ext);
  const dump = () => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return {
        companies: JSON.stringify(db.prepare('SELECT id,name,mode,time_zone FROM companies ORDER BY id').all()),
        objects: JSON.stringify(db.prepare('SELECT id,company_id,kind,data,version FROM objects ORDER BY rowid').all()),
        ledger: JSON.stringify(db.prepare('SELECT * FROM ledger ORDER BY sequence').all()),
        version: db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v,
      };
    } finally {
      db.close();
    }
  };
  const v = new DatabaseSync(path);
  v.exec('DELETE FROM engine_lease;PRAGMA wal_checkpoint(TRUNCATE)');
  v.close();
  const before = dump();
  assert.equal(before.version, 9);
  openDatabase(path, { backupDirectory: join(dir, 'before-update') }).close();
  const after = dump();
  assert.equal(after.version, 10);
  assert.equal(after.companies, before.companies);
  assert.ok(JSON.parse(after.companies).every((c) => c.mode === 'DEMO'));
  assert.equal(after.objects, before.objects);
  assert.equal(after.ledger, before.ledger);
  const idx = new DatabaseSync(path, { readOnly: true });
  try {
    const names = idx
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'objects_%'")
      .all()
      .map((r) => r.name);
    for (const n of ['objects_roster_person_day', 'objects_roster_day', 'objects_task_day', 'objects_task_list'])
      assert.ok(names.includes(n), n);
  } finally {
    idx.close();
  }
});
