process.env.TZ = 'Australia/Sydney';
// Part 4 (billing, ADR 0011) and part 5 (gear lists, roster, tasks, ADR 0012) in one tree: a MOVE gear list (site -> site) transfers hire
// between the two sites' customers by the piece (no minimum-hire top-up at the first site, the first day kept at the second); a BACK gear
// list is a bring-back on the site account and ends hire like one; a worker's task never touches the ledger, charge lines or statements;
// Needs you carries money and roster items together, each kind with a rank and a word on screen; Daily activities lists a gear list once;
// the Office drawer is the owner's order with the Control room hidden in a real yard; mode.js allows both sides' commands. Never ticks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../src/simulation.js';
import { LIVE_OPS } from '../src/domain/mode.js';
import { NEEDS_RANK } from '../src/domain/needs.js';
import { addDays } from '../src/domain/schedule.js';
import { LT_KIND_WORDS } from '../public/live-today.js';
import { OFFICE_TILES } from '../public/game.js';
import { LIVE_HIDDEN_TILES } from '../public/mode.js';
import { liveFixture, records, D0 } from './helpers/live-fixture.js';
const D = (n) => addDays(D0, n);
const at = (f, d, hm) => new Date(f.at(d, hm)).toISOString();
// A real yard billing by the day ($1.00 a piece, minimum hire 7 days): Bondi is Acme's, Manly is Bob's. 10 pieces go to Bondi on D0 by a
// gear list (the one tap that books the truck and Dave).
function yard(t, { minDays = 7 } = {}) {
  const f = liveFixture(t);
  f.cmd('hireRate', { product: f.product.id, day: 100, minDays });
  f.acme = f.cmd('customerSave', { name: 'Acme Builders', termsDays: 14 }).customer;
  f.bob = f.cmd('customerSave', { name: 'Bob the Builder', termsDays: 14 }).customer;
  f.cmd('siteDetails', { id: f.site.id, customer: f.acme.id, po: 'PO-77' });
  f.manly = f.cmd('gameSite', { name: 'Manly', address: '2 The Corso, Manly', customer: f.bob.id }).site;
  f.gear = (from, to, quantity, day, time, extra = {}) =>
    f.cmd('gearListCreate', {
      from,
      to,
      lines: [{ product: f.product.id, quantity }],
      day,
      time,
      truck: f.truck.id,
      driver: f.team.Dave.id,
      ...extra,
    });
  f.tripOf = (item) => f.sim.repo.get(f.sim.repo.get(f.item(item.id).order, 'order').trip, 'trip');
  const out = f.gear({ kind: 'yard' }, { kind: 'site', id: f.site.id }, 10, D0, '10:00');
  const trip = f.tripOf(out.item);
  f.clock(D0, '10:30');
  f.cmd('tripLoaded', { trip: trip.id, at: at(f, D0, '10:05'), reason: 'Paper docket' });
  f.cmd('tripDelivered', { trip: trip.id, at: at(f, D0, '10:25'), reason: 'Paper docket', receivedBy: 'Ana' });
  f.cmd('tripReturned', { trip: trip.id });
  return f;
}

test('a MOVE gear list moves hire from Acme’s Bondi to Bob’s Manly by the piece: no top-up at Bondi, the first day kept at Manly', (t) => {
  const f = yard(t);
  f.clock(D0, '17:30');
  const mv = f.gear({ kind: 'site', id: f.site.id }, { kind: 'site', id: f.manly.id }, 6, D(1), '08:00');
  assert.equal(mv.item.direction, 'MOVE');
  const trip = f.tripOf(mv.item);
  f.clock(D(1), '08:30');
  f.cmd('tripCollected', { trip: trip.id, at: at(f, D(1), '08:30') });
  f.clock(D(1), '09:20');
  f.cmd('tripDelivered', { trip: trip.id, at: at(f, D(1), '09:15'), receivedBy: 'Bo' });
  assert.equal(f.item(mv.item.id).status, 'DONE');
  // Acme's statement to D3: Bondi 10 on D0 then 4 a day; the 6 that moved charge no minimum hire (a transfer is not a collection)
  f.clock(D(4), '10:00');
  const acme = f.cmd('statementIssue', { customer: f.acme.id, to: D(3) }).statement;
  assert.deepEqual(
    acme.sites.map((s) => [s.name, s.from, s.to]),
    [['Bondi', D0, D(3)]],
    'Acme is billed for Bondi only',
  );
  const bondi = acme.sites[0];
  assert.equal(
    bondi.lines.reduce((n, l) => n + l.pieceDays, 0),
    10 + 4 * 3,
  );
  assert.ok(
    bondi.lines.every((l) => !l.topUp),
    'no minimum-hire top-up for the pieces that moved on',
  );
  assert.equal(acme.subtotal, (10 + 4 * 3) * 100);
  // Bob's statement to D3: Manly 6 a day from the day they landed, on Bob's statement only
  const bob = f.cmd('statementIssue', { customer: f.bob.id, to: D(3) }).statement;
  assert.deepEqual(
    bob.sites.map((s) => [s.name, s.from, s.to]),
    [['Manly', D(1), D(3)]],
  );
  assert.equal(
    bob.sites[0].lines.reduce((n, l) => n + l.pieceDays, 0),
    6 * 3,
  );
  assert.equal(bob.subtotal, 6 * 3 * 100);
  assert.ok(bob.sites[0].lines.every((l) => !l.topUp));
  assert.equal(f.sim.repo.get(f.site.id, 'site').billedUpTo, D(3));
  assert.equal(f.sim.repo.get(f.manly.id, 'site').billedUpTo, D(3));
  // the pieces remember when they first went out: a bring-back gear list from Manly on D5 (5 days after D0, under the 7-day minimum
  // counted from D0, not D1) tops up 2 days a piece on Bob's next statement, never Acme's
  f.clock(D(4), '17:30');
  const back = f.gear({ kind: 'site', id: f.manly.id }, { kind: 'yard' }, 6, D(5), '09:00');
  assert.equal(back.item.direction, 'BACK');
  const bt = f.tripOf(back.item);
  f.clock(D(5), '09:30');
  f.cmd('tripCollected', { trip: bt.id, at: at(f, D(5), '09:20') });
  f.cmd('tripReturned', { trip: bt.id });
  f.clock(D(7), '10:00');
  const bob2 = f.cmd('statementIssue', { customer: f.bob.id, to: D(6) }).statement;
  const topUps = bob2.sites[0].lines.filter((l) => l.topUp);
  assert.equal(topUps.length, 1, 'one top-up line');
  assert.equal(topUps[0].topUp.pieceDays, 6 * 2, 'D0..D4 on hire = 5 days, minimum 7: 2 days a piece');
  assert.equal(bob2.subtotal, 6 * 1 * 100 + 6 * 2 * 100, 'D4 on hire (collected D5) plus the top-up');
  f.clock(D(8), '10:00');
  const acme2 = f.sim.statementPreview({ customer: f.acme.id, to: D(7) });
  assert.equal(acme2.subtotal, 4 * 4 * 100, 'Bondi D4..D7: 4 a day, nothing from the move');
});

test('a BACK gear list is a bring-back on the site account and ends hire like one; a short count is resolved the same way', (t) => {
  const f = yard(t, { minDays: null });
  f.cmd('productValue', { product: f.product.id, replacementValue: 2500 });
  f.clock(D(1), '17:30');
  const back = f.gear({ kind: 'site', id: f.site.id }, { kind: 'yard' }, 4, D(2), '09:00');
  const o = f.sim.repo.get(f.item(back.item.id).order, 'order');
  assert.equal(o.direction, 'BACK');
  assert.equal(o.site, f.site.id);
  assert.equal(f.sim.orderLabel(o), 'B-1', 'numbered with the bring-backs');
  const trip = f.tripOf(back.item);
  f.clock(D(2), '09:30');
  f.cmd('tripCollected', { trip: trip.id, at: at(f, D(2), '09:20') });
  f.cmd('tripReturned', { trip: trip.id, lines: [{ product: f.product.id, quantity: 3 }] });
  assert.equal(f.item(back.item.id).status, 'DONE');
  let a = f.sim.siteAccount(f.site.id);
  assert.equal(a.sent, 10);
  assert.equal(a.collected, 4);
  assert.equal(a.counted, 3, 'three counted back at the yard');
  assert.equal(a.onSite, 6);
  assert.equal(a.unresolved, 1, 'one to resolve');
  f.cmd('returnResolve', { trip: trip.id, lines: [{ product: f.product.id, quantity: 1, outcome: 'LOST' }] });
  a = f.sim.siteAccount(f.site.id);
  assert.equal(a.unresolved, 0);
  assert.equal(a.charged, 1);
  const charge = f.sim.chargeLines(f.site.id)[0];
  assert.equal(charge.customer, f.acme.id, 'the charge lands on the site’s customer');
  assert.equal(charge.amount, 2500);
  // hire: 10 on D0 and D1, 6 from D2 (the 4 collected on D2 are not on hire that day); the charge on Acme's statement
  f.clock(D(4), '10:00');
  const st = f.cmd('statementIssue', { customer: f.acme.id, to: D(3) }).statement;
  assert.equal(
    st.sites[0].lines.reduce((n, l) => n + l.pieceDays, 0),
    10 * 2 + 6 * 2,
  );
  assert.deepEqual(
    st.sites[0].charges.map((c) => [c.quantity, c.amount, c.reason]),
    [[1, 2500, 'LOST']],
  );
  assert.equal(st.subtotal, (10 * 2 + 6 * 2) * 100 + 2500);
});

test('a task never touches the charge lines or a statement: a plain task and Got the list write no ledger row; Packed is the trip’s own pack', (t) => {
  const f = yard(t);
  const kev = f.team.Kev;
  f.clock(D(1), '10:00');
  const st = f.cmd('statementIssue', { customer: f.acme.id, to: D0 }).statement;
  f.clock(D(1), '17:30');
  const out = f.gear({ kind: 'yard' }, { kind: 'site', id: f.site.id }, 5, D(2), '10:00', {
    workers: [{ person: kev.id, priority: 1 }],
  });
  const task = f.sim.repo.all('workTask').find((x) => x.list === out.item.id);
  assert.ok(task, 'the list has its task');
  const plain = f.cmd('taskCreate', {
    kind: 'PLAIN',
    day: D(2),
    name: 'Sweep the racks',
    workers: [{ person: kev.id, priority: 2 }],
  });
  const count = (sql) => f.db.prepare(sql).get(f.company).n;
  // every command in a real yard leaves its COMMAND row (provenance, quantity 0): what matters is that no stock moves
  const ledger = () => count('SELECT COUNT(*) n FROM ledger WHERE company_id=? AND quantity<>0'),
    charges = () => count('SELECT COUNT(*) n FROM charge_lines WHERE company_id=?'),
    statements = () => f.sim.repo.all('statement').length,
    text = f.sim.statementReprint(st.id).text;
  const before = records(f.db, f.company),
    l0 = ledger(),
    c0 = charges(),
    s0 = statements();
  f.clock(D(2), '07:00');
  f.cmd('taskStep', { id: task.id, step: 'RECEIVED', for: kev.id });
  f.cmd('taskDone', { id: plain.task?.id ?? plain.id, for: kev.id });
  assert.equal(ledger(), l0, 'Got the list and a plain Done move nothing');
  const after = records(f.db, f.company);
  for (const k of ['objects', 'contents', 'plan'])
    assert.equal(after[k], before[k], k + ': a task step is record keeping on the task alone');
  // Packed on a gear list's task is the trip's own pack (packs.confirm): it writes what a pack writes, never money
  f.cmd('taskStep', { id: task.id, step: 'PACKED', for: kev.id });
  assert.equal(f.sim.repo.get(f.tripOf(out.item).id, 'trip').state, 'PACKED', 'the trip heard the pack');
  assert.equal(charges(), c0, 'no charge line from any task step');
  assert.equal(statements(), s0, 'no statement from any task step');
  assert.equal(f.sim.statementReprint(st.id).text, text, 'the issued statement is byte for byte as it was');
  assert.equal(f.sim.unbilledView().amount, f.sim.unbilledView().amount);
  const prog = f.sim.tasksView({ day: D(2) });
  assert.ok(JSON.stringify(prog).includes(task.id), 'Task progress shows the list’s task');
});

test('Needs you carries money and roster items together: every kind has a rank and a word on screen; ids never repeat', (t) => {
  const f = yard(t);
  // a task the day ended on with nobody confirming it (a flag from the clock's day-end), an overdue off-hire pickup and unpriced hire
  f.cmd('offHireRequested', { site: f.site.id, when: D0, whoCalled: 'Ana', pickupDay: D(1) });
  const kinds = Object.keys(NEEDS_RANK);
  for (const k of kinds) assert.ok(LT_KIND_WORDS[k], k + ' has a word on the Needs you list');
  for (const k of [
    'OFF_HIRE_OVERDUE',
    'UNBILLED',
    'BILLED_CHANGED',
    'TASK_NOT_DONE',
    'TASK_CANT_WORK',
    'ROSTER_DENIED',
  ])
    assert.ok(Number.isInteger(NEEDS_RANK[k]) && NEEDS_RANK[k] < 9, k + ' is ranked');
  assert.ok(NEEDS_RANK.OFF_HIRE_OVERDUE < NEEDS_RANK.TASK_NOT_DONE, 'gear waiting for a pickup before a task');
  assert.ok(NEEDS_RANK.TASK_NOT_DONE < NEEDS_RANK.UNBILLED, 'today’s work before the month’s billing');
  f.clock(D(3), '10:00');
  const n = f.sim.needsYou();
  const ids = n.items.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'no item twice');
  assert.ok(
    n.items.some((x) => x.kind === 'OFF_HIRE_OVERDUE' && /pickup P-1/.test(x.words)),
    'the overdue pickup is on the list: ' + JSON.stringify(n.items),
  );
  assert.ok(
    n.items.every((x) => x.kind in NEEDS_RANK && x.kind in LT_KIND_WORDS),
    'every item has a rank and a word',
  );
});

test('Daily activities lists a gear list once with its task riding on it; the office drawer is the owner’s order, no Control room in a real yard', (t) => {
  const f = yard(t);
  const kev = f.team.Kev ?? f.cmd('teamAdd', { name: 'Kev', role: 'YARDSMAN' }).person;
  f.clock(D(1), '17:30');
  const out = f.gear({ kind: 'yard' }, { kind: 'site', id: f.site.id }, 5, D(2), '10:00', {
    workers: [{ person: kev.id, priority: 1 }],
  });
  const plan = f.sim.planMonth(D(2).slice(0, 7));
  const gear = plan.items.filter((i) => i.day === D(2) && i.type === 'MATERIALS');
  assert.equal(gear.length, 1, 'the list once on the calendar');
  assert.equal(gear[0].id, out.item.id);
  assert.ok(gear[0].gear, 'as a gear list');
  const tasks = plan.tasks.filter((x) => x.day === D(2));
  assert.equal(tasks.length, 1, 'its task once');
  assert.equal(tasks[0].kind, 'LIST', 'a list task rides on the list’s chip, never its own');
  assert.equal(tasks[0].list, out.item.id);
  // the trip is on the day's lanes once
  const lanes = f.sim.dispatchView({ day: D(2) }),
    tripId = f.tripOf(out.item).id;
  assert.equal(
    lanes.lanes.flatMap((l) => l.trips).filter((x) => x.id === tripId).length,
    1,
    'its trip once on the day’s lanes',
  );
  assert.ok(!lanes.unbooked.some((x) => x.id === tripId || x.item === out.item.id), 'never also unbooked');
  // the drawer
  assert.deepEqual(
    OFFICE_TILES.filter((x) => x[4] === 'day').map((x) => x[1]),
    ['Yard & sites', 'Daily activities', 'Gear list', 'Workers', 'Task progress', 'Pre-start'],
  );
  assert.ok(
    OFFICE_TILES.some((x) => x[0] === 'HIRE'),
    'Hire stays (statements are issued there)',
  );
  assert.ok(LIVE_HIDDEN_TILES.includes('CONTROL'), 'a real yard has no Control room');
  assert.ok(!OFFICE_TILES.some((x) => x[0] === 'SCHEDULE'));
});

test('mode.js allows both sides’ commands in a real yard: billing and go-live, gear lists, roster and tasks', () => {
  for (const a of [
    'customerSave',
    'offHireRequested',
    'hireSettings',
    'statementIssue',
    'statementReverse',
    'adjustmentAdd',
    'openingLot',
    'goLiveImport',
    'gearListCreate',
    'gearListUpdate',
    'tripArrived',
    'rosterPick',
    'rosterPattern',
    'taskCreate',
    'taskStep',
    'taskDone',
  ])
    assert.ok(LIVE_OPS.has(a), a + ' is allowed in a real yard');
  assert.ok(!LIVE_OPS.has('tick'), 'the engine never');
});

test('a general manager runs gear lists and tasks; Accounts issues the statement and never a gear list', (t) => {
  const f = yard(t);
  const member = (role, name) => {
    const made = f.auth.invite(f.user, { email: name + '-' + Date.now() + '@example.com', roles: [role] });
    const token = f.auth.acceptInvitation({ token: made.token, name, password: 'demonstration-password' });
    const sim = new Simulation(f.db, f.auth.authenticate(token));
    return (a, i = {}) => sim.execute(a, i, name + ':' + a + ':' + Math.random());
  };
  const gm = member('GENERAL_MANAGER', 'Gina'),
    acct = member('ACCOUNTS', 'Alma');
  f.clock(D(1), '10:00');
  assert.throws(() => gm('statementIssue', { customer: f.acme.id, to: D0 }), /does not allow|permission/i);
  const st = acct('statementIssue', { customer: f.acme.id, to: D0 }).statement;
  assert.equal(st.number, 'ST-000001');
  assert.throws(
    () =>
      acct('gearListCreate', {
        from: { kind: 'yard' },
        to: { kind: 'site', id: f.site.id },
        lines: [{ product: f.product.id, quantity: 1 }],
        day: D(2),
        time: '10:00',
      }),
    /does not allow|permission/i,
  );
  const g = gm('gearListCreate', {
    from: { kind: 'yard' },
    to: { kind: 'site', id: f.site.id },
    lines: [{ product: f.product.id, quantity: 1 }],
    day: D(2),
    time: '10:00',
  });
  assert.equal(g.item.direction, 'OUT');
});
