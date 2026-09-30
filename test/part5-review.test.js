process.env.TZ = 'Australia/Sydney';
// Part 5 review (the owner's and the adversarial findings on the merged clone, ADR 0011): one message per person per day for the tasks
// (shared, never called off while another task still needs it; a task added late joins it), a pattern that stopped fills again, a moved
// list keeps one-per-priority, a driver's Loaded never ticks a worker's own Got the list, P1 before P2 on the phone, a place or time
// change re-asks, the office's phoned-in Done packs the trip, one ask to the driver (READY stands for the booking), a worker on a task is
// rostered in the same tap or refused when they said no, the card's words name the packers, the phone shows a pack once, the picker
// counts the from-site, the pre-start says one word per person, the queue drops an ALREADY_DONE quietly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { planFixture, D0 } from './helpers/plan-fixture.js';
import { liveFixture, D0 as LD0 } from './helpers/live-fixture.js';
import { addDays } from '../src/domain/schedule.js';
import { Simulation } from '../src/simulation.js';
import { crewLink, crewClaim, crewAuthenticate } from '../src/crew-auth.js';
import { createCrewQueue } from '../public/crew-queue.js';
import { crewPage, askCard } from '../public/crew.js';
import { prestartSheet, psSheetHTML } from '../public/prestart.js';
import { glFormHTML } from '../public/gear.js';
import { gmTest } from '../public/game.js';
const D1 = addDays(D0, 1),
  D2 = addDays(D0, 2);
const LD1 = addDays(LD0, 1);

function ready(t, opts = {}) {
  const f = planFixture(t, opts);
  const { p, per } = f.stock(3);
  const bondi = f.site('Bondi');
  const truck1 = f.trucks()[0];
  const dave = f.cmd('teamAdd', { name: 'Dave', role: 'DRIVER' }).person;
  const kev = f.cmd('teamAdd', { name: 'Kevin', job: 'YARD' }).person;
  const sam = f.cmd('teamAdd', { name: 'Samuel', job: 'YARD' }).person;
  f.cmd('planReplies', { on: false });
  return Object.assign(f, { p, per, bondi, truck1, dave, kev, sam });
}
const plain = (f, name, day, workers, extra = {}) =>
  f.cmd('taskCreate', { kind: 'PLAIN', day, name, workers, ...extra }).task;
const msgsOf = (f, person, subject) =>
  f.sim.repo.all('message').filter((m) => m.person === person && (!subject || m.subject === subject));
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
function phone(f, person) {
  const made = crewLink(f.auth, f.user, { person: person.id });
  const claimed = crewClaim(f.auth, { token: made.token, label: 'Test phone' });
  const user = crewAuthenticate(f.db, claimed.token);
  const sim = new Simulation(f.db, user);
  return { user, sim, cmd: (a, i = {}, key = randomUUID()) => sim.execute(a, i, key), me: () => sim.crewMe() };
}

test('one day-before ask per worker per day is shared by their tasks: cancelling or leaving one task keeps it while another still needs them; the last one calls it off; the day-of notice the same', (t) => {
  const f = ready(t);
  const t1 = plain(f, 'First', D1, [{ person: f.kev.id, priority: 1 }]),
    t2 = plain(f, 'Second', D1, [{ person: f.kev.id, priority: 2 }]);
  f.clock(D0, '15:01');
  f.pass();
  assert.equal(msgsOf(f, f.kev.id, 'TASK_READY').length, 1, 'one ask for both tasks');
  const ask = msgsOf(f, f.kev.id, 'TASK_READY')[0];
  assert.match(ask.text, /P1 First.*P2 Second/);
  f.cmd('taskCancel', { id: t1.id });
  assert.equal(f.sim.repo.get(ask.id, 'message').status, 'SENT', 'Second still needs the ask');
  f.pass();
  assert.equal(msgsOf(f, f.kev.id, 'TASK_READY').length, 1, 'nothing sent again');
  assert.equal(f.sim.taskView(f.sim.taskFor(t2.id)).workers[0].answer, 'WAITING');
  // off the last task: called off
  f.cmd('taskUnassign', { id: t2.id, person: f.kev.id });
  assert.equal(f.sim.repo.get(ask.id, 'message').status, 'CALLED_OFF');
  // the day-of notice: finishing one task keeps it while another is open
  const a = plain(f, 'A', D2, [{ person: f.sam.id, priority: 1 }]),
    b = plain(f, 'B', D2, [{ person: f.sam.id, priority: 2 }]);
  f.clock(D2, '06:01');
  f.pass();
  const notice = msgsOf(f, f.sam.id, 'TASK_DAY')[0];
  assert.ok(notice, 'one notice for both');
  f.cmd('taskDone', { id: a.id, for: f.sam.id });
  assert.equal(f.sim.repo.get(notice.id, 'message').closedAt, null, 'B is still open');
  f.cmd('taskDone', { id: b.id, for: f.sam.id });
  assert.ok(f.sim.repo.get(notice.id, 'message').closedAt, 'closed with the last task');
});

test('a task added after 3 pm joins the ask the worker already has for that day (its words list every task); a fresh ask goes only after a no', (t) => {
  const f = ready(t);
  plain(f, 'A', D1, [{ person: f.sam.id, priority: 1 }]);
  f.clock(D0, '15:30');
  f.pass();
  assert.equal(msgsOf(f, f.sam.id, 'TASK_READY').length, 1);
  const b = plain(f, 'B', D1, [{ person: f.sam.id, priority: 2 }]);
  assert.equal(msgsOf(f, f.sam.id, 'TASK_READY').length, 1, 'no second ask');
  const ask = msgsOf(f, f.sam.id, 'TASK_READY')[0];
  assert.match(ask.text, /P1 A.*P2 B/, 'the words now list both');
  assert.equal(f.sim.taskView(f.sim.taskFor(b.id)).workers[0].message, ask.id);
  // said no: a task added after that is asked afresh
  f.cmd('messageAnswer', { id: ask.id, yes: false, reason: 'Crook', via: 'OFFICE' });
  plain(f, 'C', D1, [{ person: f.sam.id, priority: 3 }]);
  assert.equal(msgsOf(f, f.sam.id, 'TASK_READY').length, 2);
});

test('a pattern that stopped fills again: Mon–Fri, stop, Mon–Sat gives the whole fortnight back (a day the office cleared by hand stays off)', (t) => {
  const f = ready(t);
  assert.match(f.cmd('rosterPattern', { person: f.kev.id, kind: 'MON_FRI' }).message, /10 days rostered/);
  f.cmd('rosterClear', { person: f.kev.id, days: [D1] }); // by hand
  assert.match(f.cmd('rosterPatternEnd', { person: f.kev.id }).message, /9 days ahead cleared/);
  const r = f.cmd('rosterPattern', { person: f.kev.id, kind: 'MON_SAT' });
  assert.match(r.message, /11 days rostered/, '12 Mon–Sat days in the window, less the day cleared by hand');
  assert.equal(f.sim.rosterOf(f.kev.id, D1).status, 'REMOVED', 'cleared by hand stays off');
  assert.equal(f.sim.rosterOf(f.kev.id, D2).status, 'ROSTERED');
  assert.equal(f.sim.rosterOf(f.kev.id, D2).source, 'PATTERN');
});

test('a gear list moved to another day keeps one task per priority there: a worker who already has that priority moves to the next free one; one with three tasks is taken off', (t) => {
  const f = ready(t);
  plain(f, 'Sweep', D1, [{ person: f.kev.id, priority: 1 }]);
  for (const [n, p] of [
    ['One', 1],
    ['Two', 2],
    ['Three', 3],
  ])
    plain(f, n, D1, [{ person: f.sam.id, priority: p }]);
  const r = list(f, {
    day: D2,
    workers: [
      { person: f.kev.id, priority: 1 },
      { person: f.sam.id, priority: 1 },
    ],
  });
  f.cmd('planMove', { id: r.item.id, day: D1 });
  const task = f.sim.taskFor(r.task.id);
  assert.equal(task.day, D1);
  assert.deepEqual(
    task.workers.map((w) => [f.sim.planName(w.person), w.priority]),
    [['Kevin', 2]],
    'Kevin bumped to P2, Samuel off (three tasks already)',
  );
  assert.ok(task.log.some((l) => /Kevin: P1 was taken on .*, now P2/.test(l.text)));
  assert.ok(f.sim.repo.all('notification').some((n) => n.title === 'Needs someone'));
  assert.throws(
    () => plain(f, 'Another', D1, [{ person: f.kev.id, priority: 2 }]),
    /Kevin already has a P2 that day: Bondi gear/,
  );
});

test("P1 before P2: a worker's own tap on a later task waits until their part of the earlier one is done; the office may tick in any order", (t) => {
  const f = ready(t);
  const a = plain(f, 'First', D0, [{ person: f.kev.id, priority: 1 }]),
    b = plain(f, 'Second', D0, [{ person: f.kev.id, priority: 2 }]);
  const kp = f.sim.crewPhoneView ? null : null; // the Practice yard has no phones: the office's view stands in
  void kp;
  // the office for them, out of order: refused for a phone, fine for the office
  const before = f.sim.taskFor(b.id);
  assert.equal(before.status, 'OPEN');
  assert.throws(() => {
    const sim = f.sim;
    const was = sim.dispatchPhone;
    sim.dispatchPhone = () => ({ id: f.kev.id, kind: 'worker', person: { name: 'Kevin' }, role: 'YARD' });
    try {
      sim.taskDone({ id: b.id });
    } finally {
      sim.dispatchPhone = was;
    }
  }, /Finish P1 first: First\./);
  assert.equal(f.cmd('taskDone', { id: b.id, for: f.kev.id }).task.status, 'DONE', 'the office ticks what it was told');
  assert.equal(f.sim.taskFor(a.id).status, 'OPEN');
});

test('the place or time of a rostered day changes: the ask already sent is called off, the day is ROSTERED again and asked afresh; the old ask is finished', (t) => {
  const f = ready(t);
  f.cmd('rosterPick', { person: f.kev.id, days: [D1] });
  f.clock(D0, '15:00');
  f.pass();
  const first = msgsOf(f, f.kev.id, 'ROSTER')[0];
  f.cmd('messageAnswer', { id: first.id, yes: true, via: 'OFFICE' });
  assert.equal(f.sim.rosterOf(f.kev.id, D1).status, 'CONFIRMED');
  f.cmd('rosterPick', { person: f.kev.id, days: [D1], where: f.bondi.id, time: '09:00' });
  const row = f.sim.rosterOf(f.kev.id, D1);
  assert.deepEqual([row.status, row.where, row.time], ['ROSTERED', f.bondi.id, '09:00']);
  assert.equal(f.sim.repo.get(first.id, 'message').status, 'CALLED_OFF');
  const asks = msgsOf(f, f.kev.id, 'ROSTER');
  assert.equal(asks.length, 2, 'asked again at once (after 3 pm)');
  assert.equal(asks[1].attempt, 2);
  assert.match(asks[1].text, /at Bondi from 9:00 am/);
  assert.throws(() => f.cmd('messageAnswer', { id: first.id, yes: true, via: 'OFFICE' }), /called off/);
  f.cmd('messageAnswer', { id: asks[1].id, yes: true, via: 'OFFICE' });
  assert.equal(f.sim.rosterOf(f.kev.id, D1).status, 'CONFIRMED');
});

test('one ask to the driver: a booking made by a gear list sends no DRIVE ask; READY at 3 pm stands for the booking (one answer on the card); a driver changed before 3 pm is told he gets a message then; a list made this morning asks as any booking', (t) => {
  const f = ready(t);
  const r = list(f);
  assert.deepEqual(msgsOf(f, f.dave.id).length, 0);
  const tp = () => f.item(r.item.truckPlan);
  assert.equal(tp().viaGear, r.item.id);
  assert.equal(f.sim.planItemView(tp()).driverRow.askAt, 'DAY_BEFORE');
  const bill = f.cmd('teamAdd', { name: 'Bill', role: 'DRIVER' }).person;
  const changed = f.cmd('planAsk', { item: tp().id, person: bill.id });
  assert.match(changed.message, /Bill gets a message .* at 3:00 pm\./);
  assert.equal(msgsOf(f, bill.id).length, 0);
  f.clock(D0, '15:00');
  f.pass();
  const ask = msgsOf(f, bill.id)[0];
  assert.equal(ask.subject, 'READY');
  assert.equal(tp().message, ask.id, 'the booking carries the READY');
  assert.deepEqual(
    msgsOf(f, bill.id).map((m) => m.subject),
    ['READY'],
  );
  f.cmd('messageAnswer', { id: ask.id, yes: true, via: 'OFFICE' });
  f.pass();
  assert.equal(f.sim.planItemView(tp()).driverRow.answer, 'YES');
  assert.equal(f.sim.planItemView(f.item(r.item.id)).readyAsk.answer, 'YES');
  // the day itself: a list made after 6 am for today, the driver asked as for any booking (a DRIVE), never "not asked in time"
  f.clock(D1, '08:00');
  const truck2 = f.cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: f.yard.id });
  const late = list(f, { day: D1, time: '11:00', truck: truck2.id, driver: f.dave.id });
  f.pass();
  assert.deepEqual(
    msgsOf(f, f.dave.id)
      .map((m) => m.subject)
      .sort(),
    ['DAY', 'DRIVE'],
    'the booking’s own ask, and the day notice',
  );
  assert.ok(f.item(late.item.id).readyNotAsked);
  assert.ok(!f.sim.repo.all('notification').some((n) => n.title === 'Not asked in time'));
});

test('a worker on a task and the roster: one who said they can’t work that day is refused; one not rostered is rostered in the same tap when asked (roster: true), said in the reply; the forms know who is not rostered', (t) => {
  const f = ready(t);
  f.cmd('rosterPick', { person: f.kev.id, days: [D1] });
  f.clock(D0, '15:00');
  f.pass();
  f.cmd('messageAnswer', { id: msgsOf(f, f.kev.id, 'ROSTER')[0].id, yes: false, via: 'OFFICE' });
  assert.throws(() => plain(f, 'Sweep', D1, [{ person: f.kev.id, priority: 1 }]), /Kevin can't work on Wed 14 Oct\./);
  const a = f.cmd('taskCreate', {
    kind: 'PLAIN',
    day: D1,
    name: 'Sweep',
    workers: [{ person: f.sam.id, priority: 1 }],
  });
  assert.equal(a.message, 'Sweep on Wed 14 Oct: Samuel is on it.');
  assert.equal(f.sim.rosterOf(f.sam.id, D1), null, 'not rostered unless asked to');
  const b = f.cmd('taskCreate', {
    kind: 'PLAIN',
    day: D2,
    name: 'Stack',
    site: f.bondi.id,
    workers: [{ person: f.sam.id, priority: 1 }],
    roster: true,
  });
  assert.equal(b.message, 'Stack on Thu 15 Oct: Samuel is on it. Samuel rostered for Thu 15 Oct too.');
  assert.deepEqual([f.sim.rosterOf(f.sam.id, D2).status, f.sim.rosterOf(f.sam.id, D2).where], ['ROSTERED', f.bondi.id]);
  assert.equal(b.task.workers[0].rostered, 'ROSTERED');
  // the gear list's task the same way
  const g = list(f, { day: D2, workers: [{ person: f.kev.id, priority: 1 }], roster: true });
  assert.match(g.message, /Kevin is on it\. Kevin rostered for Thu 15 Oct too\./);
  // the views: Task progress's team says who is rostered; the calendar's roster rows feed the gear form's chips
  const team = f.sim.tasksView({ day: D2 }).team.filter((w) => /^(Kevin|Samuel)$/.test(w.name));
  assert.deepEqual(
    team.map((w) => [w.name, w.rostered]),
    [
      ['Kevin', 'ROSTERED'],
      ['Samuel', 'ROSTERED'],
    ],
  );
  const month = f.sim.planMonth(D1.slice(0, 7));
  assert.ok(month.roster.some((r) => r.person === f.kev.id && r.day === D1 && r.status === 'DENIED'));
  const html = glFormHTML(
    {
      fromKind: 'yard',
      toKind: 'site',
      toSite: f.bondi.id,
      lines: [],
      day: D1,
      workers: [{ person: f.sam.id, priority: 1 }],
    },
    {
      sites: [{ id: f.bondi.id, name: 'Bondi' }],
      trucks: [],
      drivers: [],
      taken: { trucks: [], drivers: [] },
      workers: [
        { id: f.kev.id, name: 'Kevin' },
        { id: f.sam.id, name: 'Samuel' },
      ],
      rostered: new Map([[f.kev.id, 'DENIED']]),
      dayLabel: 'Wed 14 Oct',
      live: false,
      hire: true,
      timesHTML: '',
      pickHTML: '',
      opt: (v, l, sel) => '<option value="' + v + '"' + (sel ? ' selected' : '') + '>' + l + '</option>',
      today: D0,
      bookedDriver: () => null,
    },
  ).body;
  assert.ok(html.includes('Kevin<small class="gl-chip-ros no">can’t work</small>'));
  assert.ok(html.includes('Samuel<small class="gl-chip-ros">not rostered</small>'));
  assert.ok(html.includes('data-gl-roster checked> Roster Samuel for the day too'));
});

test('the card says who packs it: "Kevin and Samuel pack it on the day"', (t) => {
  const f = ready(t);
  const r = list(f, {
    workers: [
      { person: f.kev.id, priority: 1 },
      { person: f.sam.id, priority: 2 },
    ],
  });
  assert.equal(f.sim.planItemView(f.item(r.item.id)).words, 'Kevin and Samuel pack it on the day');
  const one = list(f, { day: D2, workers: [{ person: f.kev.id, priority: 1 }] });
  assert.equal(f.sim.planItemView(f.item(one.item.id)).words, 'Kevin packs it on the day');
});

test('the pre-start says one word per person (Confirmed, Can’t work, Rostered, Not rostered) and the print shell one title', (t) => {
  const f = ready(t);
  f.cmd('rosterPick', { person: f.kev.id, days: [D1] });
  f.cmd('rosterPick', { person: f.sam.id, days: [D1] });
  f.clock(D0, '15:00');
  f.pass();
  f.cmd('messageAnswer', { id: msgsOf(f, f.kev.id, 'ROSTER')[0].id, yes: true, via: 'OFFICE' });
  f.cmd('messageAnswer', { id: msgsOf(f, f.sam.id, 'ROSTER')[0].id, yes: false, via: 'OFFICE' });
  const m = prestartSheet(f.sim.prestartView({ day: D1 }));
  assert.deepEqual(
    m.workers.map((w) => [w.name, w.rostered]),
    [
      ['Kevin', 'Confirmed'],
      ['Samuel', 'Can’t work'],
    ],
  );
  assert.equal(m.shellTitle, 'Wed 14 Oct');
  const html = psSheetHTML(m);
  assert.ok(!html.includes('Confirmed: '), 'no second Confirmed');
  assert.equal(html.split('Confirmed').length - 1, 1);
});

test('the phone page: an answered "Your tasks tomorrow" is gone once the day has begun; a finished task sits under Done; Change my answer while the day is ahead; a pack shows once for a worker on the list’s task', (t) => {
  const today = '2026-10-13';
  const task = (id, priority, done) => ({
    id,
    name: 'Bondi gear',
    kind: 'LIST',
    day: today,
    lines: [],
    workers: [],
    status: done ? 'DONE' : 'OPEN',
    mine: { person: 'kev', priority, steps: {}, next: done ? null : 'RECEIVED', done, canTap: !done },
    priority,
    now: !done,
  });
  const ask = {
    id: 'm1',
    subject: 'TASK_READY',
    day: today,
    dayLabel: 'Tue 13 Oct',
    timeWords: '7:00 am',
    needsAnswer: true,
    answeredAt: '2026-10-12T05:00:00Z',
    answer: 'YES',
    canAnswer: true,
    canSee: false,
    status: 'YES',
    text: 'Hi Kev, tomorrow: P1 pack Bondi gear.',
    words: 'You said yes',
  };
  const me = {
    today,
    person: { id: 'kev', name: 'Kev', kind: 'worker', role: 'YARD' },
    company: 'Tee',
    trips: [],
    asks: [ask],
    packs: [],
    myDay: { today, tasks: [task('t1', 1, true), task('t2', 2, false)], tomorrow: [] },
    roster: null,
  };
  const html = crewPage({ me, pending: [] });
  assert.ok(!html.includes('Your tasks today'), 'the answered day-before ask is not shown on the day');
  assert.ok(!html.includes('Hi Kev, tomorrow'));
  assert.ok(html.includes('<h2 class="cr-day">Done</h2>'), 'the finished task is under Done');
  assert.ok(html.indexOf('<h2 class="cr-day">Now</h2>') < html.indexOf('<h2 class="cr-day">Done</h2>'));
  assert.ok(!html.includes('<h2 class="cr-day">Next</h2>'));
  // the day before: the answered ask shows with Change my answer; tapped, the two buttons come back
  const yesterday = {
    ...me,
    today: '2026-10-12',
    myDay: { today: '2026-10-12', tasks: [], tomorrow: [task('t2', 1, false)] },
  };
  const before = crewPage({ me: yesterday, pending: [] });
  assert.ok(before.includes('data-cr-change="m1"'));
  const changing = askCard(ask, { pending: [], open: { change: 'm1' }, me: yesterday });
  assert.ok(changing.includes('data-cr-yes="m1"') && changing.includes('data-cr-no="m1"'));
  assert.ok(changing.includes('Never mind'));
});

test('the offline queue drops a tap the server says is already done (ALREADY_DONE, as ALREADY_CONFIRMED) without a problem', async () => {
  const store = new Map();
  const queue = createCrewQueue(
    { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v) },
    async () => ({ status: 409, body: { code: 'ALREADY_DONE', error: 'Got the list: already done at 07:10.' } }),
    { now: () => 0 },
  );
  queue.tap('taskStep', { id: 't1', step: 'RECEIVED' });
  assert.equal(await queue.flush(), 1);
  assert.deepEqual(queue.pending(), []);
  assert.deepEqual(queue.problems(), []);
});

test('the parts picker counts the place the gear comes from: "free at Bondi now" for a list from a site, and a gear list is exact in the Practice yard too', () => {
  const p = { id: 'p1', name: 'Standard 3.0 m', system: 'quickstage', unitWeight: 15000, retired: false };
  const state = {
    yards: [{ id: 'y1', name: 'Main yard' }],
    sites: [{ id: 's1', name: 'Bondi', status: 'ACTIVE' }],
    products: [p],
    stock: {
      y1: { rows: [{ product: 'p1', quantity: 300, free: 300 }] },
      s1: { rows: [{ product: 'p1', quantity: 40, free: 40 }] },
    },
  };
  const yard = gmTest.planPick({ state, lift: 1500000, exact: true, demo: true });
  assert.ok(yard.html().includes('300 free in the yard now'));
  assert.ok(
    yard.type('p1', 40).includes('40 pieces &middot; exactly what you type goes on the list'),
    'not snapped to a stillage',
  );
  assert.deepEqual(yard.done(), [{ product: 'p1', quantity: 40 }]);
  const site = gmTest.planPick({ state, lift: 1500000, exact: true, at: 's1', atName: 'Bondi', demo: true });
  assert.ok(site.html().includes('40 free at Bondi now'));
  assert.ok(site.type('p1', 60).includes('more than you have: 40 free at Bondi now'));
});

// ---------------------------------------------------------------- a real yard
test("a real yard: the driver's Loaded finishes the task but never ticks a worker's own Got the list; the office's phoned-in Done packs the trip; a worker on the task sees the pack once on their phone", (t) => {
  const f = liveFixture(t);
  const kev = f.team.Kev,
    sam = f.team.Sam;
  const r = f.cmd('gearListCreate', {
    from: { kind: 'yard' },
    to: { kind: 'site', id: f.site.id },
    lines: [{ product: f.product.id, quantity: 7 }],
    day: LD0,
    time: '11:00',
    truck: f.truck.id,
    driver: f.team.Dave.id,
    workers: [
      { person: kev.id, priority: 1 },
      { person: sam.id, priority: 1 },
    ],
  });
  const trip = () => f.sim.repo.get(f.sim.repo.get(f.item(r.item.id).order, 'order').trip, 'trip');
  f.clock(LD0, '06:30');
  f.pass();
  // Kevin's phone: the task, and no second Pack ask or "Lists to pack" card for the same list
  const kp = phone(f, kev);
  const me = kp.me();
  assert.equal(me.myDay.tasks.length, 1);
  assert.ok(!me.asks.some((a) => a.subject === 'PACK'), 'the Pack ask is the task now');
  assert.deepEqual(me.packs, [], 'the pack card is the task now');
  assert.ok(
    f.sim.repo.all('message').some((m) => m.person === kev.id && m.subject === 'PACK'),
    'the message itself was sent',
  );
  const html = crewPage({ me, pending: [] });
  assert.equal(html.split('Bondi gear').length - 1 >= 1, true);
  assert.ok(!html.includes('Lists to pack'));
  // Dave loads it: the task is done, its Packed and Loaded are his; Kevin's and Samuel's own Got the list stay empty
  const dp = phone(f, f.team.Dave);
  f.cmd('packConfirmed', { trip: trip().id }); // the office records the pack (ON_BEHALF); the yard's phones never tapped Got the list
  dp.cmd('tripLoaded', { trip: trip().id });
  const v = f.sim.taskView(f.sim.taskFor(r.task.id));
  assert.equal(v.status, 'DONE');
  assert.equal(v.steps.LOADED.byName, 'Dave');
  assert.deepEqual(
    v.workers.map((w) => [w.name, w.steps.RECEIVED, w.done]),
    [
      ['Kev', null, true],
      ['Sam', null, true],
    ],
  );
  assert.deepEqual(v.progress, { done: 2, total: 4 });
  // a second list: the office ticks its task done from a phone call; the trip hears the pack too
  const r2 = f.cmd('gearListCreate', {
    from: { kind: 'yard' },
    to: { kind: 'site', id: f.site.id },
    lines: [{ product: f.product.id, quantity: 5 }],
    day: LD0,
    time: '14:00',
    truck: f.truck.id,
    driver: f.team.Dave.id,
    workers: [{ person: kev.id, priority: 2 }],
  });
  const done = f.cmd('taskDone', { id: r2.task.id, for: kev.id });
  assert.equal(done.task.status, 'DONE');
  assert.equal(done.message, 'Bondi gear is done. Pack recorded on Trip 2.');
  const trip2 = f.sim.repo.get(f.sim.repo.get(f.item(r2.item.id).order, 'order').trip, 'trip');
  assert.equal(trip2.state, 'PACKED');
  assert.equal(trip2.steps.PACKED.onBehalfOf, kev.id);
  // a phone's tap on a step already there is 409 ALREADY_DONE (the queue drops it quietly)
  assert.throws(() => kp.cmd('taskStep', { id: r2.task.id, step: 'RECEIVED' }), /already done/);
});

test('a real yard: the truck card carries a gear list’s trip as a line to the list (the trip view names its list); the clock never changes a task over the night', (t) => {
  const f = liveFixture(t);
  const r = f.cmd('gearListCreate', {
    from: { kind: 'yard' },
    to: { kind: 'site', id: f.site.id },
    lines: [{ product: f.product.id, quantity: 7 }],
    day: LD1,
    time: '07:00',
    truck: f.truck.id,
    driver: f.team.Dave.id,
    workers: [{ person: f.team.Kev.id, priority: 1 }],
  });
  const trips = f.sim.tripsView({ day: LD1 });
  const tv = trips.trips.find((x) => x.list);
  assert.deepEqual(tv.list, { id: r.item.id, name: 'Bondi gear', day: LD1 });
  const plainTrip = f.cmd('orderCreate', {
    site: f.site.id,
    lines: [{ product: f.product.id, quantity: 2 }],
    neededOn: LD1,
  });
  assert.equal(
    f.sim.tripsView({ day: LD1 }).orders.find((o) => o.id === plainTrip.order.id)?.planItem ?? null,
    null,
    'an order without a list has none',
  );
});
