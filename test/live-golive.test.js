process.env.TZ = 'Australia/Sydney';
// Bringing an existing yard in (ADR 0011, the core of audit #9): opening lots run hire from onHireSince and never from the import day;
// the go-live import checks every row and refuses a batch with a wrong row in plain words; any system name and no weight in a real
// yard (the Practice yard keeps its gates); the parallel-run report; retention: removed rates, sites and paperwork are kept with a
// reason, and the clock's housekeeping removes only old closed messages and notifications. Nothing here ticks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Simulation } from '../src/simulation.js';
import { addDays } from '../src/domain/schedule.js';
import { goLiveCheck, goLiveDay, goLiveMoney, goLiveWeight, pickField } from '../src/domain/golive.js';
import { liveFixture, D0 } from './helpers/live-fixture.js';
import { fixture } from './helpers/fixture.js';
const D = (n) => addDays(D0, n);
const ledger = (f, sql = '1=1') =>
  f.db.prepare(`SELECT * FROM ledger WHERE company_id=? AND ${sql} ORDER BY sequence`).all(f.company);

test('an opening lot: on hire from onHireSince (IMPORT, occurred_at that day at midday company time), priced at the rates of each day', (t) => {
  const f = liveFixture(t);
  f.cmd('hireRate', { product: f.product.id, day: 100 });
  const acme = f.cmd('customerSave', { name: 'Acme Builders' }).customer;
  f.clock(D0, '10:00');
  assert.throws(
    () => f.cmd('openingLot', { site: f.site.id, product: f.product.id, quantity: 5, onHireSince: D(1) }),
    /ahead of today/,
  );
  assert.throws(
    () => f.cmd('openingLot', { site: f.site.id, product: f.product.id, quantity: 5, onHireSince: '3/3/2026' }),
    /YYYY-MM-DD/,
  );
  const r = f.cmd('openingLot', {
    site: f.site.id,
    product: f.product.id,
    quantity: 5,
    onHireSince: D(-30),
    customer: acme.id,
    reference: 'Docket 4411',
  });
  assert.equal(r.lot.occurredAt, new Date(f.at(D(-30), '12:00')).toISOString());
  assert.equal(f.sim.repo.get(f.site.id, 'site').customer, acme.id, 'the site takes the customer');
  const row = ledger(f, "event='OPENING_BALANCE'").at(-1);
  assert.equal(row.actor_kind, 'IMPORT');
  assert.equal(row.origin, 'command:openingLot');
  assert.equal(row.occurred_at, r.lot.occurredAt);
  assert.notEqual(row.created_at.slice(0, 10), row.occurred_at.slice(0, 10), 'recorded today, happened then');
  assert.match(row.reason, /since .* \(brought in at go-live\) · Docket 4411/);
  // hire runs from the day the pieces went out, never from the import day
  const s = f.sim.hire({ site: f.site.id, from: D(-30), to: D0 }).statement;
  assert.equal(s.pieceDays, 31 * 5);
  assert.equal(s.startPieces, 5);
  assert.equal(f.sim.hire({}).sites[0].since, D(-30));
  // a rate dated in the past prices the days from then; the days before keep the earlier price
  f.cmd('hireRate', { product: f.product.id, day: 200, from: D(-10) });
  const p = f.sim.hire({ site: f.site.id, from: D(-30), to: D0 }).statement;
  assert.equal(p.subtotal, 20 * 5 * 100 + 11 * 5 * 200);
  assert.equal(p.rateChanges, 1);
  // the bring-back and the statement work on an opening lot like on any delivery
  const b = f.cmd('bringBackCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 5 }] }).order;
  assert.equal(b.lines[0].held, 5);
  assert.throws(
    () => f.cmd('statementIssue', { customer: acme.id, to: D0 }),
    (e) => e.code === 'TO_TODAY' && /still has gear on hire/.test(e.message),
    'to today while the lot is out: refused',
  );
  f.clock(D(1), '09:00');
  const st = f.cmd('statementIssue', { customer: acme.id, to: D0 }).statement;
  assert.equal(st.sites[0].from, D(-30));
  assert.equal(st.subtotal, p.subtotal);
  // the Practice yard has no opening lots
  const demo = new Simulation(f.db, f.owner);
  assert.throws(
    () => demo.execute('openingLot', { site: 'x' }, randomUUID()),
    (e) => e.status === 409,
  );
});

test('the check, pure: dates, money, weights and headers are read plainly or refused in words; wrong rows say what is wrong', () => {
  assert.deepEqual(goLiveDay('2026-03-03'), { day: '2026-03-03' });
  assert.deepEqual(goLiveDay('3/3/2026'), { day: '2026-03-03' });
  assert.deepEqual(goLiveDay('03.03.2026'), { day: '2026-03-03' });
  assert.match(goLiveDay('3-Mar-26').problem, /not understood: use DD\/MM\/YYYY/);
  assert.match(goLiveDay('31/02/2026').problem, /not understood/);
  assert.deepEqual(goLiveMoney('$1,234.50'), { cents: 123450 });
  assert.deepEqual(goLiveMoney(' 12 '), { cents: 1200 });
  assert.deepEqual(goLiveMoney(''), { cents: null });
  assert.match(goLiveMoney('12.345').problem, /dollars and cents/);
  assert.deepEqual(goLiveWeight('12.5 kg'), { grams: 12500 });
  assert.deepEqual(goLiveWeight('12500'), { grams: 12500 });
  assert.deepEqual(goLiveWeight('12.5', true), { grams: 12500 });
  assert.deepEqual(goLiveWeight(''), { grams: null });
  assert.equal(pickField({ 'Customer Name': 'Acme', ABN: '1' }, ['name', 'customer name']), 'Acme');
  const ctx = {
    customers: new Map([['acme builders', { id: 'c1', name: 'Acme Builders' }]]),
    customerNames: new Map([['c1', 'Acme Builders']]),
    sites: new Map([['bondi', { id: 's1', name: 'Bondi', customer: 'c1' }]]),
    productsByRef: new Map([['ls24', [{ id: 'p1', name: 'Ledger 2.4 m', reference: 'LS24' }]]]),
    productsByName: new Map([['ledger 2.4 m', [{ id: 'p1', name: 'Ledger 2.4 m', reference: 'LS24' }]]]),
    today: D0,
  };
  const c = goLiveCheck(
    'customers',
    [
      { Name: 'Acme Builders', ABN: '53 004 085 616' },
      { Name: 'Bob', ABN: '12 345 678 901', Email: 'bob@', Terms: '400' },
      { Name: 'Bob' },
      { Name: '' },
    ],
    ctx,
  );
  assert.equal(c.ok, false);
  assert.equal(c.rows[0].ok, true);
  assert.equal(c.rows[0].plan.action, 'skip');
  assert.deepEqual(c.rows[1].problems, [
    "ABN '12 345 678 901' fails its check digits",
    "email 'bob@' is not an email address",
    'terms of more than 120 days',
  ]);
  assert.deepEqual(c.rows[2].problems, ["'Bob' is on row 2 already"]);
  assert.deepEqual(c.rows[3].problems, ['a customer name is needed']);
  assert.match(c.words, /3 rows of 4 need fixing before anything is brought in. Nothing was changed./);
  const s = goLiveCheck('sites', [{ Site: 'Coogee', Customer: 'Nobody' }, { Site: 'Bondi' }], ctx);
  assert.deepEqual(s.rows[0].problems, ["no customer called 'Nobody': import the customers first"]);
  assert.equal(s.rows[1].plan.action, 'skip');
  const h = goLiveCheck(
    'onHire',
    [
      { Site: 'Bondi', Part: 'Ledger 2.4 m', Qty: '40', Since: '3/3/2026' },
      { Site: 'Manly', Part: 'LS24', Qty: '1', Since: 'March' },
      { Site: 'Bondi', Part: 'Transom 1.2 m', Qty: '6', Since: '01/09/2026', System: 'Kwikstage' },
      { Site: 'Bondi', Part: 'Ledger 2.4 m', Qty: '4', Since: '2026-09-01', Customer: 'Bob' },
    ],
    ctx,
  );
  assert.equal(h.rows[0].ok, true);
  assert.deepEqual([h.rows[0].plan.product, h.rows[0].plan.since, h.rows[0].plan.quantity], ['p1', '2026-03-03', 40]);
  assert.deepEqual(h.rows[1].problems, [
    "no site called 'Manly': import the sites first",
    "on hire since: date 'March' not understood: use DD/MM/YYYY (for example 03/03/2026)",
  ]);
  assert.equal(h.rows[2].ok, true, 'an unknown part is made, with any system name');
  assert.deepEqual(h.rows[2].plan.make, {
    name: 'Transom 1.2 m',
    reference: 'Transom 1.2 m',
    system: 'Kwikstage',
    category: 'Scaffold components',
    unitWeight: null,
  });
  assert.deepEqual(h.rows[3].problems, ["no customer called 'Bob': import the customers first"]);
  const r = goLiveCheck(
    'rates',
    [{ Part: 'Ledger 2.4 m', Week: '$7.00', Minimum: '7 days' }, { Part: 'Nothing', Day: '1' }, { Reference: 'LS24' }],
    ctx,
  );
  assert.deepEqual(
    [r.rows[0].plan.week, r.rows[0].plan.day, r.rows[0].plan.minDays, r.rows[0].plan.from],
    [700, null, 7, null],
  );
  assert.deepEqual(r.rows[1].problems, ["no part called 'Nothing': import the stock first"]);
  assert.deepEqual(r.rows[2].problems, ['a week rate or a day rate is needed', 'Ledger 2.4 m is on row 1 already']);
  assert.throws(() => goLiveCheck('people', [], ctx), /Choose a list/);
});

test('the go-live import: customers, sites, stock, on-hire lots and rates from pasted sheets, all or nothing, then the first statement', (t) => {
  const f = liveFixture(t);
  f.clock(D0, '10:00');
  const before = f.sim.repo.all('customer').length;
  // a wrong row refuses the whole batch with every row's problems, and writes nothing
  assert.throws(
    () => f.cmd('goLiveImport', { kind: 'customers', rows: [{ Name: 'Acme Builders' }, { Name: 'Bob', ABN: '1' }] }),
    (e) => e.status === 409 && e.code === 'CHECK_FAILED' && e.detail.check.rows[1].problems[0].includes('ABN'),
  );
  assert.equal(f.sim.repo.all('customer').length, before, 'nothing was changed');
  assert.equal(f.sim.goLivePreview({ kind: 'customers', rows: [{ Name: 'Acme Builders' }] }).ok, true);
  const c = f.cmd('goLiveImport', {
    kind: 'customers',
    rows: [
      { Name: 'Acme Builders', ABN: '53 004 085 616', Email: 'ap@acme.test', Terms: '14', PO: 'PO-1' },
      { Name: 'Harbour Homes' },
    ],
  });
  assert.equal(c.made.length, 2);
  const s = f.cmd('goLiveImport', {
    kind: 'sites',
    rows: [
      { Site: 'Coogee', Customer: 'Acme Builders', Address: '2 Beach St', PO: 'PO-9' },
      { Site: 'Manly', Customer: 'harbour homes' },
      { Site: 'Bondi' },
    ],
  });
  assert.deepEqual(
    s.made.map((m) => m.name),
    ['Coogee', 'Manly'],
  );
  assert.equal(s.skipped.length, 1, 'Bondi is already a site');
  const coogee = f.sim.repo.all('site').find((x) => x.name === 'Coogee');
  assert.equal(coogee.customer, c.made[0].id);
  assert.equal(coogee.po, 'PO-9');
  assert.equal(coogee.client, 'Acme Builders');
  // yard stock: a known part, and a new part with its own system name and no weight (a real yard only)
  const st = f.cmd('goLiveImport', {
    kind: 'stock',
    rows: [
      { Part: f.product.name, Qty: '20' },
      { Part: 'Tee transom 1.2 m', Qty: '30', System: 'Kwikstage', Category: 'Transoms' },
    ],
  });
  const transom = f.sim.repo.all('product').find((p) => p.name === 'Tee transom 1.2 m');
  assert.ok(transom);
  assert.equal(transom.system, 'Kwikstage');
  assert.equal(transom.category, 'Transoms');
  assert.equal(transom.unitWeight, null);
  assert.equal(st.made.filter((m) => m.kind === 'stock').length, 2);
  const inYard = (pid) =>
    f.sim
      .containers()
      .filter((x) => x.location === f.yard.id)
      .reduce((n, x) => n + f.sim.repo.quantity(x.id, pid), 0);
  assert.equal(inYard(transom.id), 30);
  // on-hire lots with their dates (a new part made on the way), then rates
  const h = f.cmd('goLiveImport', {
    kind: 'onHire',
    rows: [
      { Site: 'Coogee', Part: f.product.name, Qty: '40', Since: '3/9/2026' },
      { Site: 'Coogee', Part: 'Tee transom 1.2 m', Qty: '6', Since: '2026-09-03' },
      { Site: 'Manly', Part: 'Tee standard 2.0 m', Qty: '8', Since: '13/09/2026', Weight: '14 kg' },
    ],
  });
  assert.equal(h.made.filter((m) => m.kind === 'lot').length, 3);
  assert.equal(f.sim.repo.all('product').find((p) => p.name === 'Tee standard 2.0 m').unitWeight, 14000);
  f.cmd('goLiveImport', {
    kind: 'rates',
    rows: [
      { Part: f.product.name, Week: '$7.00' },
      { Part: 'Tee transom 1.2 m', Day: '0.50', Minimum: '7' },
      { Part: 'Tee standard 2.0 m', Day: '1.00', From: '1/9/2026' },
    ],
  });
  assert.equal(f.sim.hire({}).rates.length, 3);
  // the first statement: Coogee from 3 Sep to D0 (13 Oct): 41 days, issued the next morning (the lots are still out)
  f.clock(D(1), '09:00');
  const first = f.cmd('statementIssue', { customer: c.made[0].id, to: D0 }).statement;
  assert.equal(first.number, 'ST-000001');
  assert.equal(first.sites[0].name, 'Coogee');
  assert.equal(first.sites[0].from, '2026-09-03');
  assert.equal(first.sites[0].lines.find((l) => l.product.id === f.product.id).pieceDays, 41 * 40);
  assert.equal(first.sites[0].lines.find((l) => l.product.id === transom.id).amount, 41 * 6 * 50);
  // the parallel run: the app beside what the office invoiced
  const pr = f.sim.parallelRun({
    from: '2026-09-01',
    to: '2026-09-30',
    invoiced: [{ customer: c.made[0].id, amount: 100000 }],
  });
  const acme = pr.rows.find((r) => r.customer === c.made[0].id);
  assert.equal(acme.app, Math.round((28 * 40 * 700) / 7) + 28 * 6 * 50);
  assert.equal(acme.invoiced, 100000);
  assert.equal(acme.difference, acme.app - 100000);
  const harbour = pr.rows.find((r) => r.customer === c.made[1].id);
  assert.equal(harbour.app, 18 * 8 * 100, 'Manly from 13 Sep at $1/day');
  assert.equal(harbour.invoiced, null);
});

test('a real yard takes any system name and a part without a weight; the Practice yard keeps its three systems and its lifting rule', (t) => {
  const f = liveFixture(t);
  const p = f.cmd('product', {
    name: 'Kwikstage ledger 1.8 m',
    reference: 'KL18',
    manufacturer: 'Own list',
    region: 'AU',
    system: 'Kwikstage',
    category: 'Ledgers',
    verification: 'COMPANY CONFIGURED',
  });
  assert.equal(p.system, 'Kwikstage');
  assert.equal(p.unitWeight, null);
  f.cmd('gameAddStock', { lines: [{ product: p.id, quantity: 25 }] });
  assert.equal(
    f.sim
      .containers()
      .filter((x) => x.location === f.yard.id)
      .reduce((n, x) => n + f.sim.repo.quantity(x.id, p.id), 0),
    25,
  );
  assert.throws(
    () => f.cmd('product', { name: 'x', reference: 'x', system: '', verification: 'COMPANY CONFIGURED' }),
    /Give the scaffold system a name/,
  );
  assert.equal(f.sim.effective(p.id).unitWeight, null, 'no weight invented');
  // the Practice yard
  const d = fixture(t);
  assert.throws(
    () => d.cmd('product', { name: 'x', reference: 'x', system: 'Kwikstage', verification: 'DEMO ONLY' }),
    /Enable this scaffold system/,
  );
});

test('retention in a real yard: removed rates, sites and paperwork are kept with a reason; housekeeping removes only old closed messages and notifications', (t) => {
  const f = liveFixture(t);
  f.cmd('hireRate', { product: f.product.id, day: 100 });
  const gone = f.cmd('hireRate', { product: f.product.id });
  assert.match(gone.message, /removed/);
  const kept = f.sim.repo.all('hireRate')[0];
  assert.equal(kept.removed, true);
  assert.equal(kept.versions.length, 1, 'its history stays');
  assert.equal(f.sim.hire({}).rates.length, 0, 'not priced');
  f.cmd('hireRate', { product: f.product.id, day: 150 });
  assert.equal(f.sim.hire({}).rates.length, 1);
  assert.equal(f.sim.repo.all('hireRate').length, 2);
  // a site removed before it was used is archived with why, never deleted, and Undo opens it again
  const typo = f.cmd('gameSite', { name: 'Bondii' }).site;
  const r = f.cmd('gameRemoveSite', { site: typo.id, reason: 'typed twice' });
  assert.equal(r.removed, true);
  const s = f.sim.repo.get(typo.id, 'site');
  assert.equal(s.status, 'ARCHIVED');
  assert.equal(s.removedReason, 'typed twice');
  assert.ok(ledger(f, "event='SITE_REMOVED'").length, 'the history says so');
  f.cmd('gameRestoreSite', { undo: r.undo });
  assert.equal(f.sim.repo.get(typo.id, 'site').status, 'ACTIVE');
  f.cmd('archive', { id: typo.id, reason: 'job finished' });
  assert.equal(f.sim.repo.get(typo.id, 'site').removedReason, 'job finished');
  // paperwork is archived, not deleted (as before)
  const pw = f.cmd('paperworkAdd', { title: 'Council permit', type: 'PERMIT', site: f.site.id, expiresOn: D(30) });
  f.cmd('paperworkRemove', { id: pw.paperwork.id });
  assert.equal(f.sim.repo.all('paperwork').length, 1);
  // housekeeping: notifications older than retentionYears go; nothing else
  f.sim.notify('Old news', 'x', null);
  const old = f.sim.repo.all('notification').at(-1);
  f.db
    .prepare("UPDATE objects SET data=json_set(data,'$.createdAt','2010-01-01T00:00:00.000Z') WHERE id=?")
    .run(old.id);
  f.sim.notify('New', 'y', null);
  const ledgerBefore = ledger(f).length,
    objectsBefore = f.db
      .prepare("SELECT COUNT(*) n FROM objects WHERE company_id=? AND kind<>'notification'")
      .get(f.company).n;
  f.clock(D0, '10:00');
  assert.equal(f.sim.clockRetention(f.sim.planNow()), 1);
  assert.equal(f.sim.clockRetention(f.sim.planNow()), 0, 'once a day');
  assert.deepEqual(
    f.sim.repo.all('notification').map((n) => n.title),
    ['New'],
  );
  assert.equal(ledger(f).length, ledgerBefore);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM objects WHERE company_id=? AND kind<>'notification'").get(f.company).n,
    objectsBefore,
  );
  assert.equal(f.sim.hireSettingsView().retentionYears, 7);
  assert.throws(() => f.cmd('hireSettings', { retentionYears: 2 }), /between 5 and 99/);
});
