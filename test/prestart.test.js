process.env.TZ = 'Australia/Sydney';
import test from 'node:test';
import assert from 'node:assert/strict';
import { planFixture, D0 } from './helpers/plan-fixture.js';
import { addDays } from '../src/domain/schedule.js';
import { prestartSheet, psSheetHTML, psPageHTML } from '../public/prestart.js';
import { tpPageHTML, tpTaskHTML } from '../public/tasks.js';
import { rsAddHTML, rsRowHTML } from '../public/roster.js';
// Part 5: the Pre-start sheet's pure model from the server's own view (names, priority order, times, where, the gear list's lines, "with"),
// the printed HTML, and the Task progress page's ticks, rendered in Node.
const D1 = addDays(D0, 1);

test('prestartSheet: every rostered or tasked worker in name order with their tasks P1 to P3, the lines, who they share with; the drivers; the sheet prints it plainly', (t) => {
  const f = planFixture(t);
  f.cmd('teamStart');
  const site = f.site('Bondi');
  const kev = f.cmd('teamAdd', { name: 'Kevin', job: 'YARD' }).person,
    sam = f.cmd('teamAdd', { name: 'Samuel', job: 'YARD' }).person,
    jo = f.cmd('teamAdd', { name: 'Joanne', job: 'ONSITE' }).person;
  const { p } = f.stock(2);
  const booking = f.cmd('planTruck', {
    day: D1,
    time: '07:00',
    truck: f.trucks()[0].id,
    driver: f.driver('Dave').id,
  }).item;
  const it = f.cmd('planMaterials', {
    day: D1,
    time: '07:00',
    site: site.id,
    lines: [{ product: p.id, quantity: 12 }],
    truckPlan: booking.id,
  }).item;
  f.cmd('taskCreate', {
    kind: 'LIST',
    list: it.id,
    workers: [
      { person: kev.id, priority: 2 },
      { person: sam.id, priority: 1 },
    ],
  });
  f.cmd('taskCreate', {
    kind: 'PLAIN',
    day: D1,
    name: 'Sweep the racks',
    time: '06:30',
    note: 'Behind the office',
    workers: [{ person: kev.id, priority: 1 }],
  });
  f.cmd('rosterPick', { person: jo.id, days: [D1], where: site.id, time: '06:30' });
  f.cmd('rosterPick', { person: kev.id, days: [D1] });
  const v = f.sim.prestartView({ day: D1 });
  assert.deepEqual([v.day, v.company, v.summary], [D1, 'Tee Scaffolding', { workers: 3, tasks: 2, done: 0 }]);
  const m = prestartSheet(v);
  assert.deepEqual([m.kind, m.what, m.title], ['prestart', 'Pre-start', 'Pre-start · Wed 14 Oct']);
  assert.deepEqual(
    m.workers.map((w) => [w.name, w.rostered, w.where, w.tasks.map((x) => 'P' + x.priority + ' ' + x.name)]),
    [
      ['Joanne', 'Rostered', 'Bondi', []],
      ['Kevin', 'Rostered', 'Main yard', ['P1 Sweep the racks', 'P2 Bondi gear']],
      ['Samuel', 'Not rostered', 'Main yard', ['P1 Bondi gear']],
    ],
  );
  const gear = m.workers[1].tasks[1];
  assert.deepEqual(
    [gear.time, gear.where, gear.kind, gear.lines, gear.with],
    ['7:00 am', 'Bondi', 'pack + load', ['12 × ' + p.name], ['Samuel']],
  );
  assert.equal(m.workers[1].tasks[0].note, 'Behind the office');
  assert.deepEqual(
    m.drivers.map((d) => [d.name, d.truck, d.time, d.trips.map((x) => x.words)]),
    [['Dave', f.trucks()[0].name, '7:00 am', ['Deliver to Bondi']]],
  );
  const html = psSheetHTML(m);
  assert.match(html, /class="pr-sheet ps-sheet"/);
  for (const words of [
    'Pre-start · Wed 14 Oct',
    'Tee Scaffolding',
    'Kevin',
    'P1 Sweep the racks',
    'P2 Bondi gear',
    '12 × ' + p.name,
    'with Samuel',
    'Drivers',
    'Dave',
    'Deliver to Bondi',
    'Signed',
  ])
    assert.ok(html.includes(words), words);
  assert.ok(
    html.indexOf('Joanne') < html.indexOf('Kevin') && html.indexOf('Kevin') < html.indexOf('Samuel'),
    'name order',
  );
  assert.ok(!/ style="/.test(html), 'no inline styles (CSP)');
  const page = psPageHTML(v);
  assert.ok(
    page.includes('data-ps-print') &&
      page.includes('data-ps-date') &&
      page.includes('Wed 14 Oct: 3 workers, 2 tasks, 1 driver.'),
  );
});

test('Task progress in Node: a worker panel with empty boxes, then a green tick where a step is confirmed; "N of M done"; the office may tick an empty box', (t) => {
  const f = planFixture(t);
  const kev = f.cmd('teamAdd', { name: 'Kevin', job: 'YARD' }).person;
  const site = f.site('Bondi');
  const { p } = f.stock(2);
  const it = f.cmd('planMaterials', {
    day: D0,
    time: '10:00',
    site: site.id,
    lines: [{ product: p.id, quantity: 12 }],
  }).item;
  const g = f.cmd('taskCreate', { kind: 'LIST', list: it.id, workers: [{ person: kev.id, priority: 1 }] }).task;
  let v = f.sim.tasksView({ day: D0 });
  let html = tpPageHTML(v);
  assert.ok(html.includes('<b>0 of 1 done</b>'));
  assert.equal((html.match(/class="tp-box can"/g) ?? []).length, 1, 'only Got the list can be ticked yet');
  assert.equal((html.match(/tp-box on/g) ?? []).length, 0);
  f.cmd('taskStep', { id: g.id, step: 'RECEIVED', for: kev.id });
  f.cmd('taskStep', { id: g.id, step: 'PACKED', for: kev.id });
  v = f.sim.tasksView({ day: D0 });
  html = tpPageHTML(v);
  assert.equal((html.match(/tp-box on/g) ?? []).length, 2, 'two green ticks');
  assert.ok(html.includes('data-tp-tick="' + g.id + '" data-person="' + kev.id + '" data-step="LOADED"'));
  f.cmd('taskStep', { id: g.id, step: 'LOADED', for: kev.id });
  v = f.sim.tasksView({ day: D0 });
  html = tpPageHTML(v);
  assert.ok(html.includes('<b>1 of 1 done</b>') && html.includes('tp-task is-done'));
  const w = v.workers.find((x) => x.person === kev.id);
  assert.match(tpTaskHTML(w.tasks[0], w.tasks[0].workers[0], v), /Ticked by Owner/);
  assert.ok(!/ style="/.test(html));
  // the Workers page's pieces
  assert.ok(rsAddHTML(f.sim.teamView()).includes('+1 worker'));
  const row = f.sim.teamView({ roster: true }).people.find((x) => x.name === 'Kevin');
  assert.match(rsRowHTML(row), /data-rs-open="[^"]+".*Roster<small>Not rostered<\/small>/);
});
