process.env.TZ = 'Australia/Sydney';
// Billing you can send (ADR 0011, audit #6 and C9): customers and the one-time link of the client fields; the hire-stop rule in each
// variant with its window; off-hire -> pickup -> collected -> the statement says so; one statement per customer across two sites; an
// issue is idempotent, its reprint byte-identical and the row locked; a rate change after issue changes nothing issued and is refused
// past billedUpTo; reversal and adjustments; charge lines on the right customer; the Xero and MYOB files parse and carry the totals;
// unbilled and Needs you; permissions; the LIVE invariant. Nothing here ticks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Simulation } from '../src/simulation.js';
import { LIVE_OPS } from '../src/domain/mode.js';
import { addDays } from '../src/domain/schedule.js';
import { hireOffHire, hireGst } from '../src/domain/hire.js';
import { XERO_HEAD, MYOB_HEAD, shareGst, statementText } from '../src/domain/billing.js';
import { liveFixture, records, D0 } from './helpers/live-fixture.js';
const D = (n) => addDays(D0, n);
// A real yard with a day rate of $1.00 a piece on its one product, and a customer for Bondi.
function billingFixture(t, opts = {}) {
  const f = liveFixture(t, opts);
  f.cmd('hireRate', { product: f.product.id, day: 100 });
  f.acme = f.cmd('customerSave', {
    name: 'Acme Builders',
    abn: '53 004 085 616',
    billingEmail: 'ap@acme.test',
    termsDays: 14,
  }).customer;
  f.cmd('siteDetails', { id: f.site.id, customer: f.acme.id, po: 'PO-77' });
  f.deliver = (site, n, day, hm = '09:00') => {
    f.clock(day, '08:00');
    const o = f.cmd('orderCreate', { site, lines: [{ product: f.product.id, quantity: n }] }).order;
    const trip = f.cmd('tripBook', { orders: [o.id], truck: f.truck.id, driver: f.team.Dave.id }).trip;
    f.clock(day, hm);
    f.cmd('tripLoaded', { trip: trip.id });
    f.cmd('tripDelivered', { trip: trip.id, receivedBy: 'J. Smith' });
    f.cmd('tripReturned', { trip: trip.id });
    return { order: o, trip };
  };
  f.collect = (site, n, day, { back = true } = {}) => {
    f.clock(day, '12:00');
    const b = f.cmd('bringBackCreate', { site, lines: [{ product: f.product.id, quantity: n }] }).order;
    const trip = f.cmd('tripBook', { orders: [b.id], truck: f.truck.id, driver: f.team.Dave.id, time: '13:00' }).trip;
    f.clock(day, '13:30');
    f.cmd('tripCollected', { trip: trip.id });
    if (back) f.cmd('tripReturned', { trip: trip.id });
    return { order: b, trip };
  };
  f.statement = (site, from, to) => f.sim.hire({ site, from, to }).statement;
  return f;
}
// A general manager (operations, no money), an accounts person (money, no operations), a supervisor.
function member(f, role, name = role) {
  const made = f.auth.invite(f.user, { email: randomUUID() + '@example.com', roles: [role] });
  const token = f.auth.acceptInvitation({ token: made.token, name, password: 'demonstration-password' });
  const sim = new Simulation(f.db, f.auth.authenticate(token));
  return { sim, cmd: (a, i = {}, key = randomUUID()) => sim.execute(a, i, key) };
}
const parseCsv = (text) =>
  text
    .split('\r\n')
    .filter(Boolean)
    .map((line) => {
      const cells = [];
      let cur = '',
        q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) {
          if (ch === '"' && line[i + 1] === '"') {
            cur += '"';
            i++;
          } else if (ch === '"') q = false;
          else cur += ch;
        } else if (ch === '"') q = true;
        else if (ch === ',') {
          cells.push(cur);
          cur = '';
        } else cur += ch;
      }
      cells.push(cur);
      return cells;
    });

test('the billing commands are on the LIVE allow-list and refused in the Practice yard; statements are locked by the database', (t) => {
  const f = billingFixture(t);
  for (const a of [
    'customerSave',
    'customerRemove',
    'customerLinkSites',
    'offHireRequested',
    'hireSettings',
    'statementIssue',
    'statementReverse',
    'adjustmentAdd',
    'openingLot',
    'goLiveImport',
  ])
    assert.ok(LIVE_OPS.has(a), a);
  const demo = new Simulation(f.db, f.owner);
  for (const a of ['customerSave', 'statementIssue', 'offHireRequested', 'hireSettings'])
    assert.throws(
      () => demo.execute(a, { name: 'x', customer: 'x', site: 'x' }, randomUUID()),
      (e) => e.status === 409 && /real yard/.test(e.message),
      a,
    );
  f.deliver(f.site.id, 10, D0);
  f.clock(D(3), '10:00');
  const st = f.cmd('statementIssue', { customer: f.acme.id, to: D(2) }).statement;
  assert.throws(
    () => f.db.prepare("UPDATE objects SET data=json_set(data,'$.total',1) WHERE id=?").run(st.id),
    /never changes/,
    'a DB trigger refuses the update',
  );
  assert.throws(() => f.db.prepare('DELETE FROM objects WHERE id=?').run(st.id), /never removed/);
  assert.throws(() => f.sim.repo.save({ ...f.sim.repo.get(st.id, 'statement'), total: 1 }), /never changes/);
});

test('customers: a validated ABN, unique names, soft removal with a reason, and the one-time reversible link of the client fields', (t) => {
  const f = billingFixture(t);
  assert.throws(() => f.cmd('customerSave', { name: 'Bad ABN', abn: '12 345 678 901' }), /not valid/);
  assert.throws(() => f.cmd('customerSave', { name: 'acme  builders' }), /already a customer called Acme Builders/);
  const c = f.sim.customersView().customers.find((x) => x.id === f.acme.id);
  assert.equal(c.abnText, '53 004 085 616');
  assert.deepEqual(
    c.sites.map((s) => [s.name, s.po]),
    [['Bondi', 'PO-77']],
  );
  // a site with a client name and no customer: linked once, to a customer of that name (made when missing), and undone
  const coogee = f.cmd('gameSite', { name: 'Coogee' }).site;
  f.cmd('siteDetails', { id: coogee.id, client: 'Harbour Homes' });
  const maroubra = f.cmd('gameSite', { name: 'Maroubra' }).site;
  f.cmd('siteDetails', { id: maroubra.id, client: 'ACME BUILDERS' });
  assert.deepEqual(
    f.sim.customersView().unlinkedSites.map((s) => s.name),
    ['Coogee', 'Maroubra'],
  );
  const link = f.cmd('customerLinkSites');
  assert.deepEqual(
    link.linked.map((l) => [l.name, l.customerName]),
    [
      ['Coogee', 'Harbour Homes'],
      ['Maroubra', 'Acme Builders'],
    ],
  );
  assert.deepEqual(
    link.created.map((x) => x.name),
    ['Harbour Homes'],
  );
  assert.equal(f.sim.repo.get(maroubra.id, 'site').customerFrom, 'client');
  assert.match(f.cmd('customerLinkSites').message, /Nothing to link/);
  f.cmd('customerUnlinkSite', { site: maroubra.id });
  assert.equal(f.sim.repo.get(maroubra.id, 'site').customer, null);
  assert.equal(f.sim.repo.get(maroubra.id, 'site').client, 'ACME BUILDERS', 'the client name stays');
  // removal is soft and refused while an open site links to it
  const harbour = link.created[0];
  assert.throws(() => f.cmd('customerRemove', { id: harbour.id, reason: 'duplicate' }), /Coogee still links/);
  f.cmd('siteDetails', { id: coogee.id, customer: null });
  f.cmd('customerRemove', { id: harbour.id, reason: 'duplicate of Harbour Homes Pty Ltd' });
  const v = f.sim.customersView();
  assert.ok(!v.customers.some((x) => x.id === harbour.id));
  assert.equal(v.removed.find((x) => x.id === harbour.id).removedReason, 'duplicate of Harbour Homes Pty Ltd');
  assert.throws(() => f.cmd('siteDetails', { id: coogee.id, customer: harbour.id }), /was removed/);
  f.cmd('customerRestore', { id: harbour.id });
  assert.ok(f.sim.customersView().customers.some((x) => x.id === harbour.id));
  // a second company never sees these customers
  assert.equal(f.sim.repo.all('customer').length, 2);
  const other = liveFixture(t, { setup: false });
  assert.equal(other.sim.repo.all('customer').length, 0);
});

test('the hire-stop rule, pure: off-hire day, day after, at collection, and the window; open lots are provisional', () => {
  const slot = { open: [{ q: 10, start: D0 }], closed: [{ q: 4, start: D0, end: D(7) }] };
  const notice = [{ pickup: 'P-1', when: D(5), who: 'Mick' }];
  const a = hireOffHire(slot, notice, D(8), 'OFF_HIRE_DAY', 7);
  assert.equal(a.closed[0].end, D(5), 'collected on D7, within 7 days: hire stopped on the off-hire day');
  assert.deepEqual(a.closed[0].oh, {
    pickup: 'P-1',
    when: D(5),
    who: 'Mick',
    stoppedOn: D(5),
    collectedOn: D(7),
    ran: false,
  });
  assert.equal(a.open.length, 0, 'the open lot is provisionally stopped');
  assert.equal(a.closed[1].why, 'offhire');
  assert.equal(a.closed[1].end, D(5));
  const b = hireOffHire(slot, notice, D(8), 'DAY_AFTER', 7);
  assert.equal(b.closed[0].end, D(6));
  const c = hireOffHire(slot, notice, D(8), 'COLLECTION', 7);
  assert.equal(c, slot, 'rule (c): nothing changes');
  const d = hireOffHire(slot, notice, D(8), 'OFF_HIRE_DAY', 1);
  assert.equal(d.closed[0].end, D(7), 'collected 2 days after the call, window 1 day: hire ran to collection');
  assert.equal(d.closed[0].oh.ran, true);
  assert.equal(d.open.length, 1, 'the window has closed: the open lot runs on');
  const e = hireOffHire(slot, notice, D(13), 'OFF_HIRE_DAY', 7);
  assert.equal(e.open.length, 1, 'today is past the window with no collection: hire runs on');
  const late = hireOffHire({ open: [], closed: [{ q: 1, start: D(6), end: D(7) }] }, notice, D(8), 'OFF_HIRE_DAY', 7);
  assert.equal(late.closed[0].end, D(7), 'a lot delivered after the call is not covered');
  assert.equal(late.closed[0].oh, undefined);
});

test('off-hire: a pickup number and a bring-back for the day; hire stops by the rule; the statement line says so; overdue on Needs you', (t) => {
  const f = billingFixture(t);
  f.deliver(f.site.id, 10, D0);
  f.clock(D(5), '10:00');
  assert.throws(() => f.cmd('offHireRequested', { site: f.site.id, when: D(6), whoCalled: 'Mick' }), /cannot be ahead/);
  const r = f.cmd('offHireRequested', { site: f.site.id, when: D(5), whoCalled: 'Mick', note: 'crane off Friday' });
  assert.equal(r.offHire.label, 'P-1');
  assert.equal(r.offHire.pieces, 10);
  assert.equal(r.order.direction, 'BACK');
  assert.equal(r.order.lines[0].requested, 10, 'everything on the site record');
  assert.equal(r.offHire.pickupDay, D(5));
  assert.match(r.message, /hire stops on the off-hire day/);
  assert.throws(
    () => f.cmd('offHireRequested', { site: f.site.id, when: D(5), whoCalled: 'Mick' }),
    /already has pickup P-1/,
  );
  // provisional: the day after the call, hire has stopped on D5 (5 days: D0..D4)
  f.clock(D(6), '10:00');
  let s = f.statement(f.site.id, D0, D(6));
  assert.equal(s.pieceDays, 50);
  assert.equal(s.subtotal, 5000);
  assert.equal(s.lines[0].offHire.length, 1);
  assert.match(
    s.lines[0].offHire[0].words,
    /Off-hire called Sun 18 Oct by Mick \(pickup P-1\)\. Hire stopped Sun 18 Oct/,
  );
  assert.match(s.lines[0].offHire[0].words, /not collected yet/);
  assert.match(s.hireStopRule, /hire stops on the off-hire day when the gear is collected within 7 days/);
  // the pickup day passes uncollected: Needs you says so, once
  f.clock(D(6), '17:30');
  const n = f.sim.needsYou();
  const item = n.items.find((i) => i.kind === 'OFF_HIRE_OVERDUE');
  assert.ok(item, JSON.stringify(n.items));
  assert.match(
    item.words,
    /Bondi: off-hire called Sun 18 Oct by Mick, pickup P-1 \(B-1\) not collected, due Sun 18 Oct/,
  );
  assert.equal(item.action.label, 'Book the pickup');
  // collected on D7 (within the window): the lot is settled on the off-hire day; the words say collected
  f.clock(D(7), '12:00');
  const coll = f.cmd('tripBook', {
    orders: [r.order.id],
    truck: f.truck.id,
    driver: f.team.Dave.id,
    time: '13:00',
  }).trip;
  f.clock(D(7), '13:30');
  f.cmd('tripCollected', { trip: coll.id });
  f.cmd('tripReturned', { trip: coll.id });
  assert.ok(!f.sim.needsYou().items.some((i) => i.kind === 'OFF_HIRE_OVERDUE'), 'cleared by the collection');
  assert.equal(f.sim.offHiresView().offHires[0].status, 'COLLECTED');
  assert.equal(f.sim.offHiresView().offHires[0].collectedOn, D(7));
  f.clock(D(8), '10:00');
  s = f.statement(f.site.id, D0, D(8));
  assert.equal(s.pieceDays, 50, 'hire stopped on the off-hire day, not the collection day');
  assert.match(
    s.lines[0].offHire[0].words,
    /Hire stopped Sun 18 Oct \(company rule: hire stops on the off-hire day\); collected Tue 20 Oct\./,
  );
  // the day-after rule: 6 days; at collection: 7 days
  f.cmd('hireSettings', { stopRule: 'DAY_AFTER' });
  assert.equal(f.statement(f.site.id, D0, D(8)).pieceDays, 60);
  f.cmd('hireSettings', { stopRule: 'COLLECTION' });
  s = f.statement(f.site.id, D0, D(8));
  assert.equal(s.pieceDays, 70);
  assert.deepEqual(s.lines[0].offHire, [], 'rule (c) reads the ledger as it is');
  // the window: collected 2 days after the call with a 1-day window: hire ran to collection, and the line says so
  f.cmd('hireSettings', { stopRule: 'OFF_HIRE_DAY', collectWithinDays: 1 });
  s = f.statement(f.site.id, D0, D(8));
  assert.equal(s.pieceDays, 70);
  assert.match(
    s.lines[0].offHire[0].words,
    /Collected Tue 20 Oct, 2 days after the call: hire ran to collection \(company rule: within 1 days\)/,
  );
  // the settings are the owner's
  const gm = member(f, 'GENERAL_MANAGER');
  assert.throws(
    () => gm.cmd('hireSettings', { stopRule: 'COLLECTION' }),
    (e) => e.status === 403,
  );
  assert.throws(() => f.cmd('hireSettings', { stopRule: 'WHENEVER' }), /Choose when hire stops/);
});

test('one statement per customer across two sites, sequential numbers, a stored snapshot, byte-identical reprint, idempotent issue', (t) => {
  const f = billingFixture(t);
  const coogee = f.cmd('gameSite', { name: 'Coogee', customer: f.acme.id, po: 'PO-88' }).site;
  assert.equal(f.sim.repo.get(coogee.id, 'site').customer, f.acme.id, 'Send’s New site takes a customer');
  f.deliver(f.site.id, 10, D0);
  f.deliver(coogee.id, 4, D(1));
  f.clock(D(4), '10:00');
  const preview = f.sim.statementPreview({ customer: f.acme.id, to: D(3) });
  assert.equal(preview.number, 'PREVIEW');
  assert.equal(preview.canIssue, true);
  assert.equal(preview.subtotal, 40 * 100 + 12 * 100, 'Bondi 10 pieces D0..D3, Coogee 4 pieces D1..D3');
  assert.equal(f.sim.repo.all('statement').length, 0, 'a preview writes nothing');
  const key = randomUUID();
  const r = f.cmd('statementIssue', { customer: f.acme.id, to: D(3) }, key);
  const st = r.statement;
  assert.equal(st.number, 'ST-000001');
  assert.deepEqual(
    st.sites.map((s) => [s.name, s.po, s.from, s.to, s.subtotal]),
    [
      ['Bondi', 'PO-77', D0, D(3), 4000],
      ['Coogee', 'PO-88', D(1), D(3), 1200],
    ],
  );
  assert.equal(st.subtotal, 5200);
  assert.equal(st.gst, 520);
  assert.equal(st.total, 5720);
  assert.equal(st.dueOn, D(4 + 14), 'terms: 14 days from the issue day');
  assert.equal(st.customer.abnText, '53 004 085 616');
  assert.equal(st.company.name, 'Tee Scaffolding');
  assert.match(st.hireStopRule, /Company rule/);
  assert.equal(st.footer, 'Statement — your accounting package issues the tax invoice.');
  assert.equal(st.issuedBy.name, 'Tee');
  assert.equal(f.sim.repo.get(f.site.id, 'site').billedUpTo, D(3));
  assert.equal(f.sim.repo.get(coogee.id, 'site').lastStatement, 'ST-000001');
  // idempotent by key; a second issue for the same period is refused with the statement that covers it
  assert.deepEqual(f.cmd('statementIssue', { customer: f.acme.id, to: D(3) }, key), r);
  assert.throws(
    () => f.cmd('statementIssue', { customer: f.acme.id, to: D(3) }),
    (e) => e.status === 409 && e.code === 'ALREADY_ISSUED' && /billed up to Fri 16 Oct on ST-000001/.test(e.message),
  );
  assert.equal(f.sim.repo.all('statement').length, 1);
  // the reprint is the stored text, byte for byte, and equal to the text the snapshot renders
  const a = f.sim.statementReprint(st.id),
    b = f.sim.statementReprint(st.id);
  assert.equal(a.text, b.text);
  assert.equal(a.name, 'ST-000001.txt');
  assert.equal(a.text, statementText(f.sim.repo.get(st.id, 'statement')));
  assert.match(a.text, /HIRE STATEMENT ST-000001/);
  assert.match(a.text, /Total \(inc GST\) \$57\.20/);
  assert.match(a.text, /Statement — your accounting package issues the tax invoice\./);
  // the hire page's preview for the next period starts after billedUpTo
  f.deliver(f.site.id, 2, D(4));
  f.clock(D(6), '10:00');
  const next = f.sim.statementPreview({ customer: f.acme.id, to: D(5) });
  assert.deepEqual(
    next.sites.map((s) => [s.name, s.from, s.to]),
    [
      ['Bondi', D(4), D(5)],
      ['Coogee', D(4), D(5)],
    ],
  );
  assert.equal(next.subtotal, 12 * 2 * 100 + 4 * 2 * 100);
  const second = f.cmd('statementIssue', { customer: f.acme.id, to: D(5) }).statement;
  assert.equal(second.number, 'ST-000002');
  assert.equal(
    f.sim
      .statementsView()
      .statements.map((s) => s.number)
      .join(','),
    'ST-000002,ST-000001',
  );
  // an unpriced product is never sent
  const other = f.sim.repo.all('product').find((p) => p.id !== f.product.id && f.sim.effective(p.id).unitWeight > 0);
  f.cmd('gameAddStock', { lines: [{ product: other.id, quantity: 5 }] });
  f.clock(D(6), '11:00');
  const o = f.cmd('orderCreate', { site: f.site.id, lines: [{ product: other.id, quantity: 5 }] }).order;
  const trip = f.cmd('tripBook', { orders: [o.id], truck: f.truck.id, driver: f.team.Dave.id, time: '12:00' }).trip;
  f.clock(D(6), '12:30');
  f.cmd('tripLoaded', { trip: trip.id });
  f.cmd('tripDelivered', { trip: trip.id, receivedBy: 'J' });
  f.clock(D(7), '10:00');
  assert.throws(
    () => f.cmd('statementIssue', { customer: f.acme.id, to: D(6) }),
    (e) => e.code === 'UNPRICED' && /No rate yet for/.test(e.message),
  );
});

test('a rate change after issue changes 0 issued totals: for every day or on or before billedUpTo it is refused and points at an adjustment', (t) => {
  const f = billingFixture(t);
  f.deliver(f.site.id, 10, D0);
  f.clock(D(4), '10:00');
  const st = f.cmd('statementIssue', { customer: f.acme.id, to: D(3) }).statement;
  const before = f.sim.statementReprint(st.id).text,
    hash = f.sim.repo.get(st.id, 'statement').hash;
  assert.throws(
    () => f.cmd('hireRate', { product: f.product.id, day: 200 }),
    (e) =>
      e.status === 409 &&
      e.code === 'BILLED' &&
      /up to Fri 16 Oct is on issued statement ST-000001/.test(e.message) &&
      e.detail.earliest === D(4),
    '"Correct past hire too" is refused',
  );
  assert.throws(
    () => f.cmd('hireRate', { product: f.product.id, day: 200, from: D(3) }),
    (e) => e.code === 'BILLED',
  );
  assert.throws(
    () => f.cmd('hireSiteRate', { site: f.site.id, product: f.product.id, day: 300, from: D(2) }),
    (e) => e.code === 'BILLED',
  );
  f.cmd('hireRate', { product: f.product.id, day: 200, from: D(4) });
  assert.equal(f.sim.statementReprint(st.id).text, before, 'the issued statement reprints the same');
  assert.equal(f.sim.repo.get(st.id, 'statement').hash, hash);
  assert.equal(f.sim.statementGet(st.id).total, 4400);
  f.clock(D(6), '10:00');
  const next = f.cmd('statementIssue', { customer: f.acme.id, to: D(5) }).statement;
  assert.equal(next.subtotal, 10 * 2 * 200, 'the new rate from D4');
  // the change to what was billed is an adjustment, the owner's, carried by the next statement
  const gm = member(f, 'GENERAL_MANAGER');
  assert.throws(
    () => gm.cmd('adjustmentAdd', { customer: f.acme.id, amount: -500, description: 'x', reason: 'y' }),
    (e) => e.status === 403,
  );
  const adj = f.cmd('adjustmentAdd', {
    customer: f.acme.id,
    amount: -500,
    description: 'Credit: rate agreed at $0.50 for the first week',
    reason: 'Rate agreed by phone before ST-000001',
    statement: st.id,
  }).adjustment;
  assert.equal(adj.number, 'ADJ-000001');
  assert.equal(adj.approvedBy.name, 'Tee');
  f.deliver(f.site.id, 1, D(6));
  f.clock(D(8), '10:00');
  const third = f.cmd('statementIssue', { customer: f.acme.id, to: D(7) }).statement;
  assert.deepEqual(
    third.adjustments.map((a) => [a.number, a.amount, a.statement.number]),
    [['ADJ-000001', -500, 'ST-000001']],
  );
  assert.equal(third.subtotal, 11 * 2 * 200 - 500);
  assert.match(f.sim.statementReprint(third.id).text, /Adjustment ADJ-000001 · Credit: rate agreed/);
  assert.ok(!f.sim.statementPreview({ customer: f.acme.id, to: D(7) }).adjustments.length, 'carried once');
});

test('reversal: the same lines negated under the next number, billedUpTo rolled back, the period issued again; a later statement blocks it', (t) => {
  const f = billingFixture(t);
  f.deliver(f.site.id, 10, D0);
  f.clock(D(4), '10:00');
  const st = f.cmd('statementIssue', { customer: f.acme.id, to: D(3) }).statement;
  const gm = member(f, 'GENERAL_MANAGER');
  assert.throws(
    () => gm.cmd('statementReverse', { statement: st.id, reason: 'x' }),
    (e) => e.status === 403,
    'the owner voids',
  );
  const rev = f.cmd('statementReverse', { statement: st.id, reason: 'Wrong PO on the statement' }).statement;
  assert.equal(rev.number, 'ST-000002');
  assert.deepEqual(rev.reverses, { id: st.id, number: 'ST-000001' });
  assert.equal(rev.total, -st.total);
  assert.equal(rev.sites[0].lines[0].pieceDays, -40);
  assert.equal(f.sim.repo.get(f.site.id, 'site').billedUpTo, null, 'rolled back');
  assert.equal(f.sim.statementGet(st.id).reversedBy.number, 'ST-000002');
  assert.throws(() => f.cmd('statementReverse', { statement: st.id, reason: 'again' }), /already reversed/);
  assert.throws(() => f.cmd('statementReverse', { statement: rev.id, reason: 'again' }), /itself a reversal/);
  const again = f.cmd('statementIssue', { customer: f.acme.id, to: D(3) }).statement;
  assert.equal(again.number, 'ST-000003');
  assert.equal(again.total, st.total);
  f.clock(D(6), '10:00');
  f.cmd('statementIssue', { customer: f.acme.id, to: D(5) });
  assert.throws(
    () => f.cmd('statementReverse', { statement: again.id, reason: 'x' }),
    /billed past ST-000003 \(ST-000004\)/,
  );
});

test('charge lines land on the right customer’s statement with their approver; older lines resolve through the site', (t) => {
  const f = billingFixture(t);
  const bob = f.cmd('customerSave', { name: 'Bob the Builder' }).customer;
  const coogee = f.cmd('gameSite', { name: 'Coogee', customer: bob.id }).site;
  f.cmd('productValue', { product: f.product.id, replacementValue: 2500 });
  f.deliver(f.site.id, 10, D0);
  f.deliver(coogee.id, 6, D0, '11:00');
  const { trip } = f.collect(f.site.id, 10, D(2), { back: false });
  f.cmd('tripReturned', { trip: trip.id, lines: [{ product: f.product.id, quantity: 8 }] });
  f.cmd('returnResolve', { trip: trip.id, lines: [{ product: f.product.id, quantity: 2, outcome: 'LOST' }] });
  const charge = f.sim.chargeLines(f.site.id)[0];
  assert.equal(charge.customer, f.acme.id, 'the site’s customer on the line');
  assert.equal(charge.amount, 5000);
  f.clock(D(3), '10:00');
  const acme = f.cmd('statementIssue', { customer: f.acme.id, to: D(2) }).statement;
  assert.deepEqual(
    acme.sites[0].charges.map((c) => [c.quantity, c.unitValue, c.amount, c.reason, c.approvedBy]),
    [[2, 2500, 5000, 'LOST', null]],
  );
  assert.equal(acme.subtotal, 10 * 2 * 100 + 5000, 'D0, D1 on hire (collected D2), plus the charge');
  assert.match(
    f.sim.statementReprint(acme.id).text,
    /lost, charged Thu 15 Oct · \$25\.00 each · approved by the office · \$50\.00/,
  );
  const bobs = f.cmd('statementIssue', { customer: bob.id, to: D(2) }).statement;
  assert.equal(bobs.sites[0].charges.length, 0, 'never on another customer’s statement');
  assert.equal(bobs.subtotal, 6 * 3 * 100);
  // a charge is billed once
  f.clock(D(5), '10:00');
  assert.throws(
    () => f.cmd('statementIssue', { customer: f.acme.id, to: D(4) }),
    (e) => e.code === 'ALREADY_ISSUED' || e.code === 'NOTHING_TO_BILL',
  );
});

test('the accounting file: Xero and MYOB layouts parse, carry the right totals, need the owner’s account codes; each download is recorded', (t) => {
  const f = billingFixture(t);
  const bob = f.cmd('customerSave', { name: 'Bob the Builder', termsDays: 30 }).customer;
  const coogee = f.cmd('gameSite', { name: 'Coogee', customer: bob.id }).site;
  f.cmd('productValue', { product: f.product.id, replacementValue: 3333 });
  f.deliver(f.site.id, 10, D0);
  f.deliver(coogee.id, 7, D0, '11:00');
  const { trip } = f.collect(f.site.id, 10, D(2), { back: false });
  f.cmd('tripReturned', { trip: trip.id, lines: [{ product: f.product.id, quantity: 9 }] });
  f.cmd('returnResolve', { trip: trip.id, lines: [{ product: f.product.id, quantity: 1, outcome: 'LOST' }] });
  f.cmd('adjustmentAdd', { customer: bob.id, amount: -123, description: 'Goodwill', reason: 'late delivery' });
  f.clock(D(3), '10:00');
  const a = f.cmd('statementIssue', { customer: f.acme.id, to: D(2) }).statement,
    b = f.cmd('statementIssue', { customer: bob.id, to: D(2) }).statement;
  const month = D(3).slice(0, 7);
  assert.throws(() => f.sim.accountingFile({ format: 'xero', month }), /Set the Xero sales account code/);
  assert.throws(() => f.sim.accountingFile({ format: 'myob', month }), /Set the MYOB income account number/);
  assert.equal(f.sim.hireSettingsView().xeroReady, false);
  f.cmd('hireSettings', { xeroAccountCode: '200', myobAccountNumber: '4-1000' });
  const xero = f.sim.accountingFile({ format: 'xero', month });
  const rows = parseCsv(xero.body);
  assert.deepEqual(rows[0], XERO_HEAD);
  assert.equal(xero.name, 'scaffold-xero-' + month + '.csv');
  const col = (name) => XERO_HEAD.indexOf(name);
  const byNumber = (n) => rows.slice(1).filter((r) => r[col('*InvoiceNumber')] === n);
  assert.equal(byNumber('ST-000001').length, 2, 'a hire line and a charge line');
  assert.equal(byNumber('ST-000002').length, 2, 'a hire line and an adjustment');
  const sum = (list) => Math.round(list.reduce((s, r) => s + Number(r[col('*UnitAmount')]) * 100, 0));
  assert.equal(sum(byNumber('ST-000001')), a.subtotal, 'ex GST');
  assert.equal(sum(byNumber('ST-000002')), b.subtotal);
  const first = byNumber('ST-000001')[0];
  assert.equal(first[col('*ContactName')], 'Acme Builders');
  assert.equal(first[col('EmailAddress')], 'ap@acme.test');
  assert.equal(first[col('Reference')], 'PO-77');
  assert.equal(first[col('*InvoiceDate')], '16/10/2026');
  assert.equal(first[col('*DueDate')], '30/10/2026');
  assert.equal(first[col('*Quantity')], '1');
  assert.equal(first[col('*AccountCode')], '200');
  assert.equal(first[col('*TaxType')], 'GST on Income');
  assert.equal(first[col('Currency')], 'AUD');
  assert.equal(rows[0].length, 27);
  assert.ok(
    rows.slice(1).every((r) => r.length === 27),
    'every row has every column',
  );
  // MYOB: tab-delimited, the field list in MYOB's order, GST per line adding to the statement's GST
  const myob = f.sim.accountingFile({ format: 'myob', month });
  const lines = myob.body
    .split('\r\n')
    .filter(Boolean)
    .map((l) => l.split('\t'));
  assert.deepEqual(lines[0], MYOB_HEAD);
  assert.equal(myob.name, 'scaffold-myob-' + month + '.txt');
  const m = (name) => MYOB_HEAD.indexOf(name);
  const mine = (n) => lines.slice(1).filter((r) => r[m('Invoice No.')] === n);
  const cents = (list, field) => Math.round(list.reduce((s, r) => s + Number(r[field]) * 100, 0));
  assert.equal(cents(mine('ST-000001'), m('Amount')), a.subtotal);
  assert.equal(cents(mine('ST-000001'), m('Tax Amount')), a.gst);
  assert.equal(cents(mine('ST-000002'), m('Amount')), b.subtotal);
  assert.equal(cents(mine('ST-000002'), m('Tax Amount')), b.gst);
  assert.equal(mine('ST-000002')[0][m('Co./Last Name')], 'Bob the Builder');
  assert.equal(mine('ST-000002')[0][m('Account No.')], '4-1000');
  assert.equal(mine('ST-000002')[0][m('Tax Code')], 'GST');
  assert.equal(mine('ST-000002')[0][m('Inclusive')], '', 'ex GST');
  assert.equal(mine('ST-000002')[0][m('Terms - Balance Due Days')], '30');
  assert.equal(mine('ST-000002')[0][m('Date')], '16/10/2026');
  assert.ok(lines.slice(1).every((r) => r.length === MYOB_HEAD.length));
  // generic
  const gen = parseCsv(f.sim.accountingFile({ format: 'generic', month }).body);
  assert.equal(gen[0][0], 'Statement');
  assert.equal(gen.length - 1, 4);
  // recorded
  assert.deepEqual(
    f.sim.statementGet(a.id).exports.map((e) => e.format),
    ['XERO', 'MYOB', 'GENERIC'],
  );
  assert.throws(
    () => f.sim.accountingFile({ format: 'xero', month: '2020-01' }),
    /No statements were issued in 2020-01/,
  );
  // GST shared by largest remainder always adds up
  for (const [amounts, gst] of [
    [[333, 333, 334], hireGst(1000)],
    [[5, 5, 5], hireGst(15)],
    [[-1000, 300], hireGst(-700)],
  ])
    assert.equal(
      shareGst(amounts, gst).reduce((s, x) => s + x, 0),
      gst,
      amounts.join(','),
    );
});

test('unbilled since: the view, Today’s business card, and the UNBILLED rule after 31 days (money words for finance only)', (t) => {
  const f = billingFixture(t);
  const coogee = f.cmd('gameSite', { name: 'Coogee' }).site; // no customer
  f.deliver(f.site.id, 10, D0);
  f.deliver(coogee.id, 2, D0, '11:00');
  f.clock(D(2), '10:00');
  let u = f.sim.unbilledView();
  assert.equal(u.since, D0);
  assert.equal(u.amount, 10 * 3 * 100 + 2 * 3 * 100);
  assert.equal(u.customers[0].name, 'Acme Builders');
  assert.equal(u.customers[0].amount, 3000);
  assert.deepEqual(
    u.noCustomer.map((s) => [s.name, s.amount]),
    [['Coogee', 600]],
  );
  const money = f.sim.todayView().business.money;
  assert.equal(money.unbilled.amount, 3600);
  assert.equal(money.toInvoice, 3600 + hireGst(3600));
  assert.equal(money.toInvoiceWords, 'Unbilled since Tue 13 Oct (incl. GST)');
  f.cmd('statementIssue', { customer: f.acme.id, to: D(1) });
  u = f.sim.unbilledView();
  assert.equal(u.customers[0].amount, 1000, 'only D2 after billedUpTo');
  assert.equal(u.customers[0].since, D(2));
  assert.ok(!f.sim.needsYou().items.some((i) => i.kind === 'UNBILLED'), 'not yet 31 days');
  f.clock(D(34), '10:00');
  const items = f.sim.needsYou().items.filter((i) => i.kind === 'UNBILLED');
  assert.deepEqual(
    items.map((i) => [i.words, i.action.label]),
    [
      ['Coogee has gear on hire and no customer to bill', 'Pick a customer'],
      ['Acme Builders: $330.00 unbilled since Thu 15 Oct (33 days)', 'Issue statement'],
    ],
  );
  const gm = member(f, 'GENERAL_MANAGER');
  const theirs = gm.sim.needsYou().items.find((i) => i.kind === 'UNBILLED' && /Acme/.test(i.words));
  assert.equal(theirs.words, 'Acme Builders: unbilled since Thu 15 Oct (33 days)', 'no amount without finance.view');
});

test('permissions: Accounts sees money and issues statements, never operations; supervisors and crew never see money', (t) => {
  const f = billingFixture(t);
  f.deliver(f.site.id, 10, D0);
  f.clock(D(3), '10:00');
  const acc = member(f, 'ACCOUNTS', 'Pat');
  assert.ok(acc.sim.auth.permissions(acc.sim.user).includes('finance.view'));
  assert.ok(!acc.sim.auth.permissions(acc.sim.user).includes('operations.manage'));
  assert.equal(acc.sim.hire({}).sites.length, 1, 'money');
  assert.equal(acc.sim.unbilledView().amount, 4000, 'D0..D3');
  assert.ok(acc.sim.customersView().customers.length);
  const st = acc.cmd('statementIssue', { customer: f.acme.id, to: D(2) }).statement;
  assert.equal(st.issuedBy.name, 'Pat');
  assert.equal(acc.sim.statementsView().statements.length, 1);
  assert.throws(
    () => acc.cmd('orderCreate', { site: f.site.id, lines: [] }),
    (e) => e.status === 403,
    'no operations',
  );
  assert.throws(
    () => acc.cmd('tripBook', { orders: [] }),
    (e) => e.status === 403,
  );
  assert.throws(
    () => acc.cmd('offHireRequested', { site: f.site.id, whoCalled: 'x' }),
    (e) => e.status === 403,
  );
  assert.throws(
    () => acc.cmd('hireSettings', { stopRule: 'COLLECTION' }),
    (e) => e.status === 403,
    'the rule is the owner’s',
  );
  assert.throws(
    () => acc.cmd('statementReverse', { statement: st.id, reason: 'x' }),
    (e) => e.status === 403,
  );
  assert.equal(acc.sim.snapshot().sites.length, 0, 'no sites, no trucks');
  assert.deepEqual(acc.sim.needsYou().items, []);
  const sup = member(f, 'SUPERVISOR');
  assert.throws(
    () => sup.sim.hire({}),
    (e) => e.status === 403,
  );
  assert.throws(
    () => sup.sim.statementGet(st.id),
    (e) => e.status === 403,
  );
  assert.throws(
    () => sup.sim.unbilledView(),
    (e) => e.status === 403,
  );
  assert.throws(
    () => sup.cmd('statementIssue', { customer: f.acme.id }),
    (e) => e.status === 403,
  );
  assert.throws(
    () => sup.cmd('customerSave', { name: 'x' }),
    (e) => e.status === 403,
  );
  const gm = member(f, 'GENERAL_MANAGER');
  assert.throws(
    () => gm.sim.hire({}),
    (e) => e.status === 403,
  );
  assert.throws(
    () => gm.cmd('statementIssue', { customer: f.acme.id }),
    (e) => e.status === 403,
  );
  assert.ok(gm.cmd('customerSave', { name: 'Site office customer' }).customer, 'the office keeps customers');
});

test('the LIVE invariant holds with customers, off-hire, statements and settings in the records: 2,000 clock passes change nothing', (t) => {
  const f = billingFixture(t);
  f.deliver(f.site.id, 10, D0);
  f.clock(D(2), '10:00');
  f.cmd('offHireRequested', { site: f.site.id, when: D(2), whoCalled: 'Mick' });
  f.cmd('statementIssue', { customer: f.acme.id, to: D(1) });
  f.cmd('hireSettings', { stopRule: 'DAY_AFTER', xeroAccountCode: '200' });
  const before = records(f.db, f.company);
  for (let i = 0; i < 2000; i++) {
    f.setTime(f.at(D(2), '10:00') + i * 6 * 60000);
    f.pass();
  }
  assert.deepEqual(records(f.db, f.company), before);
  assert.equal(f.sim.repo.all('statement').length, 1);
});
