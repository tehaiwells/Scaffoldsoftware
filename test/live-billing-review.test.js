process.env.TZ = 'Australia/Sydney';
// The review of Phase 1A part 4 (ADR 0011, "After review"): a site moves to another customer only once the old customer is billed and
// charge lines follow the customer they were stamped with; a reversal goes back to the customer it was billed to; an opening lot years
// back still bills; a statement runs to yesterday and never to today while gear is out; an open off-hire window blocks the statement
// past the stop day, and a billed period that reads differently later is offered as a worked-out adjustment; the Hire overview keeps
// counting gear inside the window; a lot dated before the last statement, a sheet pasted twice and a removed site's name are refused
// or skipped in words; GST line by line so the files agree, and a credit larger than the hire has a way through; a customer with money
// owing stays; the one-time link keeps names in bounds; an open bring-back is netted out of a pickup; prices are the owner's; a
// pickup day already gone is overdue at once; the statement says what moved and what the top-up covers; the reversal carries its
// reason; the locked text carries the year and company time. Nothing here ticks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Simulation } from '../src/simulation.js';
import { addDays } from '../src/domain/schedule.js';
import { lineGst, hireDollars } from '../src/domain/hire.js';
import { liveFixture, D0 } from './helpers/live-fixture.js';
const D = (n) => addDays(D0, n);
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
  f.collect = (site, n, day, { back = true, hm = '13:30' } = {}) => {
    f.clock(day, '12:00');
    const b = f.cmd('bringBackCreate', { site, lines: [{ product: f.product.id, quantity: n }] }).order;
    const trip = f.cmd('tripBook', { orders: [b.id], truck: f.truck.id, driver: f.team.Dave.id, time: '13:00' }).trip;
    f.clock(day, hm);
    f.cmd('tripCollected', { trip: trip.id });
    if (back) f.cmd('tripReturned', { trip: trip.id });
    return { order: b, trip };
  };
  f.collectOrder = (orderId, day) => {
    f.clock(day, '12:00');
    const trip = f.cmd('tripBook', {
      orders: [orderId],
      truck: f.truck.id,
      driver: f.team.Dave.id,
      time: '13:00',
    }).trip;
    f.clock(day, '13:30');
    f.cmd('tripCollected', { trip: trip.id });
    f.cmd('tripReturned', { trip: trip.id });
    return trip;
  };
  f.statement = (site, from, to) => f.sim.hire({ site, from, to }).statement;
  return f;
}
function member(f, role, name = role) {
  const made = f.auth.invite(f.user, { email: randomUUID() + '@example.com', roles: [role] });
  const token = f.auth.acceptInvitation({ token: made.token, name, password: 'demonstration-password' });
  const sim = new Simulation(f.db, f.auth.authenticate(token));
  return { sim, cmd: (a, i = {}, key = randomUUID()) => sim.execute(a, i, key) };
}

test('a site moves to another customer only once nothing waits for the old customer’s statement; the charge line goes with it', (t) => {
  const f = billingFixture(t);
  const beta = f.cmd('customerSave', { name: 'Beta Constructions' }).customer;
  f.cmd('productValue', { product: f.product.id, replacementValue: 2500 });
  f.deliver(f.site.id, 10, D0);
  // a LOST charge on D2 while the site bills to Acme
  const { trip } = f.collect(f.site.id, 2, D(2), { back: false });
  f.cmd('tripReturned', { trip: trip.id, lines: [{ product: f.product.id, quantity: 1 }] });
  f.cmd('returnResolve', { trip: trip.id, lines: [{ product: f.product.id, quantity: 1, outcome: 'LOST' }] });
  assert.equal(f.sim.chargeLines(f.site.id)[0].customer, f.acme.id);
  f.clock(D(10), '10:00');
  assert.throws(
    () => f.cmd('siteDetails', { id: f.site.id, customer: beta.id }),
    /Bondi has hire since Tue 13 Oct not yet on a statement for Acme Builders\. Issue a statement to Acme Builders up to Thu 22 Oct first/,
  );
  assert.equal(f.sim.repo.get(f.site.id, 'site').customer, f.acme.id, 'unchanged');
  const st = f.cmd('statementIssue', { customer: f.acme.id }).statement; // to yesterday, D9
  assert.equal(st.to, D(9));
  assert.equal(st.sites[0].charges.length, 1, 'Acme’s charge on Acme’s statement');
  assert.equal(st.subtotal, (2 * 10 + 8 * 8) * 100 + 2500, 'D0..D1 with 10, D2..D9 with 8, and the lost one');
  // now the move goes through: today's hire goes with the site
  f.cmd('siteDetails', { id: f.site.id, customer: beta.id });
  f.clock(D(12), '10:00');
  const pb = f.sim.statementPreview({ customer: beta.id });
  assert.equal(pb.sites[0].from, D(10));
  assert.equal(pb.subtotal, 2 * 8 * 100);
  assert.equal(pb.sites[0].charges.length, 0);
  assert.equal(f.sim.statementPreview({ customer: f.acme.id }).empty, true, 'nothing of Bondi lands on Acme now');
  // a charge line only (no hire waiting) also holds the site
  const g = billingFixture(t);
  const gamma = g.cmd('customerSave', { name: 'Gamma' }).customer;
  g.cmd('productValue', { product: g.product.id, replacementValue: 2500 });
  g.deliver(g.site.id, 2, D0);
  const c2 = g.collect(g.site.id, 2, D(1), { back: false });
  g.cmd('tripReturned', { trip: c2.trip.id, lines: [{ product: g.product.id, quantity: 1 }] });
  g.cmd('returnResolve', { trip: c2.trip.id, lines: [{ product: g.product.id, quantity: 1, outcome: 'LOST' }] });
  g.clock(D(2), '10:00');
  g.cmd('statementIssue', { customer: g.acme.id, to: D(1) });
  g.clock(D(3), '10:00');
  g.cmd('siteDetails', { id: g.site.id, customer: gamma.id }); // billed and collected: free to move
  assert.equal(g.sim.repo.get(g.site.id, 'site').customer, gamma.id);
});

test('a reversal goes back to the customer it was billed to; a billed site never goes back to no customer', (t) => {
  const f = billingFixture(t);
  const beta = f.cmd('customerSave', { name: 'Beta Constructions' }).customer;
  f.deliver(f.site.id, 10, D0);
  f.clock(D(3), '10:00');
  const st = f.cmd('statementIssue', { customer: f.acme.id, to: D(2) }).statement;
  assert.throws(
    () => f.cmd('siteDetails', { id: f.site.id, customer: null }),
    /has an issued statement: its customer stays/,
  );
  f.collect(f.site.id, 10, D(3));
  f.clock(D(4), '10:00');
  f.cmd('siteDetails', { id: f.site.id, customer: beta.id }); // D3 was the collection day: nothing waits for Acme
  assert.throws(
    () => f.cmd('statementReverse', { statement: st.id, reason: 'wrong rate' }),
    /Bondi now bills to Beta Constructions: ST-000001 \(Acme Builders\) stays\. Move the site back to Acme Builders first/,
  );
  f.cmd('siteDetails', { id: f.site.id, customer: f.acme.id });
  assert.equal(f.cmd('statementReverse', { statement: st.id, reason: 'wrong rate' }).statement.number, 'ST-000002');
});

test('an opening lot 450 days back: the first statement, the unbilled figure, Today, the customers card and Needs you all work', (t) => {
  const f = billingFixture(t);
  f.clock(D0, '10:00');
  f.cmd('openingLot', { site: f.site.id, product: f.product.id, quantity: 5, onHireSince: D(-450) });
  const p = f.sim.statementPreview({ customer: f.acme.id });
  assert.equal(p.to, D(-1));
  assert.equal(p.sites[0].from, D(-450));
  assert.equal(p.sites[0].lines[0].pieceDays, 450 * 5);
  assert.equal(p.canIssue, true);
  assert.equal(f.sim.unbilledView().amount, 451 * 5 * 100);
  assert.equal(f.sim.todayView().business.money.unbilled.amount, 451 * 5 * 100);
  assert.equal(f.sim.customersView().customers[0].exposure.amount, 451 * 5 * 100);
  assert.ok(f.sim.needsYou().items.some((i) => i.kind === 'UNBILLED'));
  assert.equal(f.cmd('statementIssue', { customer: f.acme.id }).statement.subtotal, 450 * 5 * 100);
  assert.throws(
    () => f.sim.hire({ site: f.site.id, from: D(-450), to: D0 }),
    /at most 400 days/,
    'the screen keeps its limit',
  );
});

test('a statement runs to yesterday by default and never to today while gear is out, so a collection later in the day is never billed', (t) => {
  const f = billingFixture(t);
  f.deliver(f.site.id, 10, D0);
  f.clock(D(5), '09:00');
  assert.throws(
    () => f.cmd('statementIssue', { customer: f.acme.id, to: D(5) }),
    (e) =>
      e.code === 'TO_TODAY' &&
      /Bondi still has gear on hire: a statement runs up to yesterday \(Sat 17 Oct\)/.test(e.message),
  );
  const st = f.cmd('statementIssue', { customer: f.acme.id }).statement;
  assert.equal(st.to, D(4));
  assert.equal(st.sites[0].lines[0].pieceDays, 50);
  f.collect(f.site.id, 10, D(5)); // 13:30 the same day
  f.clock(D(6), '09:00');
  assert.equal(f.statement(f.site.id, D0, D(6)).pieceDays, 50, 'the collection day is not charged');
  assert.equal(f.sim.statementPreview({ customer: f.acme.id }).empty, true, 'nothing over-billed, nothing left');
  assert.deepEqual(f.sim.statementDrift(), [], 'the billed period reads the same');
  // with the gear all back, a statement to today is fine (nothing is out to be collected)
  const g = billingFixture(t);
  g.deliver(g.site.id, 10, D0);
  g.collect(g.site.id, 10, D(3));
  g.clock(D(3), '15:00');
  assert.equal(g.cmd('statementIssue', { customer: g.acme.id, to: D(3) }).statement.sites[0].lines[0].pieceDays, 30);
});

test('an open off-hire window blocks the statement past the stop day and offers the day before the call; once the window closes or the gear is collected the reading settles', (t) => {
  const f = billingFixture(t);
  f.cmd('hireRate', { product: f.product.id, day: 100, minDays: 14 });
  f.deliver(f.site.id, 10, D0);
  f.clock(D(10), '10:00');
  const r = f.cmd('offHireRequested', { site: f.site.id, when: D(10), whoCalled: 'Mick' });
  f.clock(D(12), '10:00');
  const p = f.sim.statementPreview({ customer: f.acme.id, to: D(12) });
  assert.equal(p.canIssue, false);
  assert.equal(p.whyCode, 'PICKUP_OPEN');
  assert.match(
    p.why,
    /Pickup P-1 at Bondi is not collected yet: hire from Fri 23 Oct is not settled .* up to Thu 22 Oct, the day before the call/,
  );
  assert.equal(p.suggestedTo, D(9));
  assert.throws(
    () => f.cmd('statementIssue', { customer: f.acme.id, to: D(12) }),
    (e) => e.code === 'PICKUP_OPEN' && e.detail.suggestedTo === D(9),
  );
  const st = f.cmd('statementIssue', { customer: f.acme.id, to: D(9) }).statement;
  assert.equal(st.sites[0].lines[0].pieceDays, 100);
  assert.deepEqual(st.sites[0].lines[0].offHire, [], 'a statement to the day before the call says nothing about it');
  assert.equal(st.sites[0].lines[0].topUp, null);
  // nobody collects; the window (7 days) closes on D17: hire runs again from D10, the issued statement reads the same
  f.clock(D(20), '10:00');
  const p2 = f.sim.statementPreview({ customer: f.acme.id });
  assert.equal(p2.canIssue, true);
  assert.equal(p2.sites[0].from, D(10));
  assert.equal(p2.sites[0].lines[0].pieceDays, 100, 'D10..D19');
  assert.deepEqual(f.sim.statementDrift(), []);
  // collected on D25: the line says hire ran to collection; the minimum (14 days) was met, no top-up
  f.collectOrder(r.order.id, D(25));
  f.clock(D(26), '10:00');
  const p3 = f.sim.statementPreview({ customer: f.acme.id });
  assert.equal(p3.sites[0].lines[0].pieceDays, 150);
  assert.match(p3.sites[0].lines[0].offHire[0].words, /hire ran to collection/);
  assert.equal(p3.sites[0].lines[0].topUp, null);
  assert.equal(f.cmd('statementIssue', { customer: f.acme.id }).statement.subtotal, 15000);
});

test('a billed period that reads differently later (a notice recorded late) is offered as a worked-out adjustment on Needs you and the issued list', (t) => {
  const f = billingFixture(t);
  f.deliver(f.site.id, 10, D0);
  f.clock(D(9), '10:00');
  const st = f.cmd('statementIssue', { customer: f.acme.id, to: D(8) }).statement;
  assert.equal(st.sites[0].lines[0].pieceDays, 90);
  f.cmd('offHireRequested', { site: f.site.id, when: D(5), whoCalled: 'Mick' }); // the builder says he called on D5
  const oh = f.sim.offHiresView().offHires[0];
  f.collectOrder(oh.order, D(10));
  f.clock(D(11), '10:00');
  assert.equal(f.sim.statementPreview({ customer: f.acme.id }).empty, true, 'nothing after D8 to bill');
  const drift = f.sim.statementDrift();
  assert.equal(drift.length, 1);
  assert.equal(drift[0].number, 'ST-000001');
  assert.equal(drift[0].billed, 9000);
  assert.equal(drift[0].now, 5000, 'hire stopped on D5 by the rule');
  assert.equal(drift[0].delta, -4000);
  assert.match(
    drift[0].words,
    /ST-000001 \(Acme Builders\): hire Tue 13 Oct – Wed 21 Oct now reads \$50\.00 ex GST, billed \$90\.00: an adjustment of -\$40\.00 would square it/,
  );
  const item = f.sim.needsYou().items.find((i) => i.kind === 'BILLED_CHANGED');
  assert.ok(item);
  assert.deepEqual(
    [item.action.label, item.action.view, item.action.statement, item.action.amount],
    ['Add the adjustment', 'HIRE', st.id, -4000],
  );
  assert.equal(f.sim.statementsView().statements[0].drift.delta, -4000);
  // the office's operations manager sees no money item; the owner records the adjustment and the item goes
  const gm = member(f, 'GENERAL_MANAGER');
  assert.ok(!gm.sim.needsYou().items.some((i) => i.kind === 'BILLED_CHANGED'));
  // a goodwill credit against the same statement is not the hire re-read: the item stays
  f.cmd('adjustmentAdd', { customer: f.acme.id, statement: st.id, amount: -500, description: 'Goodwill', reason: 'x' });
  assert.equal(f.sim.statementDrift()[0].delta, -4000);
  f.cmd('adjustmentAdd', {
    customer: f.acme.id,
    statement: st.id,
    amount: -4000,
    description: item.action.description,
    reason: 'Off-hire called Sun 18 Oct, recorded late',
    hire: true,
  });
  assert.deepEqual(f.sim.statementDrift(), []);
  assert.ok(!f.sim.needsYou().items.some((i) => i.kind === 'BILLED_CHANGED'));
  assert.equal(f.sim.statementsView().statements[0].drift, null);
  assert.equal(f.sim.statementPreview({ customer: f.acme.id }).subtotal, -4500, 'both credits ride the next statement');
});

test('the Hire overview keeps counting the gear while an off-hire window is open; only the money reads the rule', (t) => {
  const f = billingFixture(t);
  f.deliver(f.site.id, 10, D0);
  f.clock(D(5), '10:00');
  f.cmd('offHireRequested', { site: f.site.id, when: D(5), whoCalled: 'Mick' });
  f.clock(D(6), '10:00');
  const h = f.sim.hire({}),
    s = h.sites.find((x) => x.id === f.site.id);
  assert.equal(s.pieces, 10);
  assert.equal(s.since, D0);
  assert.equal(h.totals.pieces, 10);
  assert.equal(h.totals.sites, 1);
  assert.deepEqual(h.check, { rebuilt: 10, actual: 10, ok: true });
  assert.equal(s.accrued, 5000, 'D0..D4: hire stopped on the off-hire day');
  assert.deepEqual(s.pickup, { pickup: 'P-1', when: D(5), who: 'Mick', stoppedOn: D(5) });
  assert.equal(f.sim.unbilledView().customers[0].sites[0].pieces, 10);
});

test('an opening lot dated before the site’s last statement is refused unless the office says it knows', (t) => {
  const f = billingFixture(t);
  f.deliver(f.site.id, 10, D0);
  f.clock(D(6), '10:00');
  f.cmd('statementIssue', { customer: f.acme.id, to: D(5) });
  assert.throws(
    () => f.cmd('openingLot', { site: f.site.id, product: f.product.id, quantity: 20, onHireSince: D(-30) }),
    /Bondi is billed up to Sun 18 Oct on ST-000001: a lot on hire since Sun 13 Sep would never be billed for the days up to then/,
  );
  const r = f.cmd('openingLot', {
    site: f.site.id,
    product: f.product.id,
    quantity: 20,
    onHireSince: D(-30),
    beforeBilled: true,
  });
  assert.match(r.message, /on hire at Bondi since Sun 13 Sep 2026\. Its hire up to Sun 18 Oct needs an adjustment/);
  assert.ok(f.cmd('openingLot', { site: f.site.id, product: f.product.id, quantity: 1, onHireSince: D(6) }).lot);
});

test('the same on-hire or stock sheet twice is skipped unless asked for again; a removed site’s name is not made twice', (t) => {
  const f = billingFixture(t);
  f.clock(D0, '10:00');
  const rows = [{ Site: 'Bondi', Part: f.product.name, Qty: '40', Since: '3/9/2026', Customer: 'Acme Builders' }];
  f.cmd('goLiveImport', { kind: 'onHire', rows });
  const pv = f.sim.goLivePreview({ kind: 'onHire', rows });
  assert.equal(pv.ok, true);
  assert.equal(pv.rows[0].plan.action, 'skip');
  assert.match(pv.rows[0].plan.words, /40 already on record since Thu 3 Sep 2026\. Tick "add these again"/);
  assert.equal(f.cmd('goLiveImport', { kind: 'onHire', rows }).made.length, 0);
  assert.equal(f.sim.hire({}).sites.find((s) => s.id === f.site.id).pieces, 40, 'not doubled');
  assert.equal(f.cmd('goLiveImport', { kind: 'onHire', rows, again: true }).made.length, 1, 'asked for again');
  const stock = [{ Part: f.product.name, Qty: '20' }],
    before = f.sim.containers().reduce((n, x) => n + f.sim.repo.quantity(x.id, f.product.id), 0);
  f.cmd('goLiveImport', { kind: 'stock', rows: stock });
  assert.equal(f.sim.goLivePreview({ kind: 'stock', rows: stock }).rows[0].plan.action, 'skip');
  f.cmd('goLiveImport', { kind: 'stock', rows: stock });
  assert.equal(
    f.sim.containers().reduce((n, x) => n + f.sim.repo.quantity(x.id, f.product.id), 0),
    before + 20,
    'once',
  );
  // a removed site
  const coogee = f.cmd('gameSite', { name: 'Coogee', customer: f.acme.id }).site;
  f.cmd('archive', { id: coogee.id, reason: 'done' });
  const sp = f.sim.goLivePreview({ kind: 'sites', rows: [{ Site: 'Coogee', Customer: 'Acme Builders' }] });
  assert.equal(sp.rows[0].plan.action, 'skip');
  assert.match(sp.rows[0].plan.words, /Coogee is a removed site: open it again from Client sites/);
  assert.equal(f.cmd('goLiveImport', { kind: 'sites', rows: [{ Site: 'Coogee' }] }).made.length, 0);
  assert.equal(f.sim.repo.all('site').filter((s) => s.name === 'Coogee').length, 1);
  const op = f.sim.goLivePreview({
    kind: 'onHire',
    rows: [{ Site: 'Coogee', Part: f.product.name, Qty: '1', Since: '1/9/2026' }],
  });
  assert.match(op.rows[0].problems[0], /Coogee is a removed site/);
});

test('GST line by line: the statement, the MYOB file and the invoice Xero raises agree; a credit larger than the hire has a way through', (t) => {
  const f = billingFixture(t);
  f.cmd('hireSettings', { xeroAccountCode: '200', myobAccountNumber: '4-1000' });
  f.clock(D0, '10:00');
  for (let i = 0; i < 3; i++)
    f.cmd('adjustmentAdd', { customer: f.acme.id, amount: 1005, description: 'Extra ' + i, reason: 'agreed' });
  const st = f.cmd('statementIssue', { customer: f.acme.id }).statement;
  assert.equal(lineGst(1005), 101);
  assert.equal(lineGst(-1005), -101);
  assert.deepEqual([st.subtotal, st.gst, st.total], [3015, 303, 3318]);
  const m = f.sim.accountingFile({ format: 'myob', month: D0.slice(0, 7) });
  assert.deepEqual(
    m.body
      .split('\r\n')
      .slice(1)
      .filter(Boolean)
      .map((r) => r.split('\t')[23]),
    ['1.01', '1.01', '1.01'],
  );
  assert.equal(m.gst, 303);
  const x = f.sim.accountingFile({ format: 'xero', month: D0.slice(0, 7) });
  assert.equal(x.body.split('\r\n').filter(Boolean).length, 4);
  // a credit larger than the hire: refused with the way through (the hire first, the credit on its own)
  const g = billingFixture(t);
  g.deliver(g.site.id, 3, D0);
  g.clock(D(3), '10:00');
  g.cmd('adjustmentAdd', { customer: g.acme.id, amount: -5005, description: 'Credit', reason: 'goodwill' });
  const p = g.sim.statementPreview({ customer: g.acme.id });
  assert.equal(p.canIssue, false);
  assert.equal(p.whyCode, 'MIXED_CREDIT');
  assert.match(p.why, /The credit is larger than the hire \(-\$41\.05 ex GST\)/);
  assert.throws(
    () => g.cmd('statementIssue', { customer: g.acme.id }),
    (e) => e.code === 'MIXED_CREDIT',
  );
  const p2 = g.sim.statementPreview({ customer: g.acme.id, adjustments: '0' });
  assert.equal(p2.canIssue, true);
  assert.equal(p2.heldAdjustments, 1);
  const hire = g.cmd('statementIssue', { customer: g.acme.id, withAdjustments: false }).statement;
  assert.deepEqual([hire.subtotal, hire.gst, hire.adjustments.length], [900, 90, 0]);
  const credit = g.cmd('statementIssue', { customer: g.acme.id }).statement;
  assert.deepEqual([credit.number, credit.subtotal, credit.gst, credit.total], ['ST-000002', -5005, -501, -5506]);
});

test('a customer with money owing is not removed; a removed customer stays on the parallel run', (t) => {
  const f = billingFixture(t);
  f.deliver(f.site.id, 10, D0);
  f.collect(f.site.id, 10, D(5));
  f.clock(D(6), '10:00');
  f.cmd('archive', { id: f.site.id, reason: 'job done' });
  assert.throws(
    () => f.cmd('customerRemove', { id: f.acme.id, reason: 'gone bust' }),
    /Acme Builders has \$50\.00 unbilled: issue the last statement first/,
  );
  f.cmd('statementIssue', { customer: f.acme.id });
  f.cmd('customerRemove', { id: f.acme.id, reason: 'gone bust' });
  const pr = f.sim.parallelRun({ from: D0, to: D(5), invoiced: [{ customer: f.acme.id, amount: 5000 }] });
  assert.deepEqual(
    pr.rows.map((r) => [r.name, r.removed, r.app, r.difference]),
    [['Acme Builders', true, 5000, 0]],
  );
  assert.equal(f.sim.customersView().removed[0].exposure.amount, 0);
});

test('the one-time link keeps names to 120 characters and leaves the billing email for the owner', (t) => {
  const f = billingFixture(t);
  const long = 'X'.repeat(150);
  const s2 = f.cmd('gameSite', { name: 'Coogee' }).site;
  f.cmd('siteDetails', { id: s2.id, client: long, email: 'ap@builder.test' });
  const r = f.cmd('customerLinkSites', {});
  assert.equal(r.created.length, 1);
  const c = f.sim.repo.get(r.created[0].id, 'customer');
  assert.equal(c.name.length, 120);
  assert.equal(c.billingEmail, null);
});

test('an off-hire with a bring-back already open asks only for the rest, or is that bring-back; a pickup day already gone is overdue at once', (t) => {
  const f = billingFixture(t);
  f.deliver(f.site.id, 10, D0);
  f.clock(D(3), '10:00');
  const b = f.cmd('bringBackCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 4 }] }).order;
  const r = f.cmd('offHireRequested', { site: f.site.id, when: D(3), whoCalled: 'Mick' });
  assert.equal(r.order.label, 'B-2');
  assert.equal(r.order.lines[0].requested, 6, '10 on record, 4 already on B-1');
  assert.equal(r.offHire.pieces, 10);
  assert.match(r.message, /Pickup B-2 for Fri 16 Oct \(B-1 already holds the rest\)/);
  f.cmd('orderCancel', { id: b.id, reason: 'x' });
  const g = billingFixture(t);
  g.deliver(g.site.id, 10, D0);
  g.clock(D(3), '10:00');
  const all = g.cmd('bringBackCreate', { site: g.site.id, lines: [{ product: g.product.id, quantity: 10 }] }).order;
  const r2 = g.cmd('offHireRequested', { site: g.site.id, when: D(3), whoCalled: 'Mick' });
  assert.equal(r2.order.id, all.id);
  assert.match(r2.message, /Pickup B-1 already holds everything on record: it is the pickup/);
  assert.equal(g.sim.repo.all('order').length, 2, 'the send and the one bring-back');
  // Monday's paperwork: the call was last week, the pickup was Friday
  const h = billingFixture(t);
  h.deliver(h.site.id, 10, D0);
  h.clock(D(5), '10:00');
  assert.throws(
    () => h.cmd('offHireRequested', { site: h.site.id, when: D(3), whoCalled: 'Mick', pickupDay: D(2) }),
    /before the off-hire day/,
  );
  const r3 = h.cmd('offHireRequested', { site: h.site.id, when: D(1), whoCalled: 'Mick', pickupDay: D(3) });
  assert.equal(r3.offHire.pickupDay, D(3));
  assert.equal(r3.offHire.overdue, true);
  assert.equal(r3.order.neededOn, D(5), 'the bring-back itself is for today at the earliest');
  assert.match(r3.message, /already overdue/);
  assert.ok(h.sim.needsYou().items.some((i) => i.kind === 'OFF_HIRE_OVERDUE'));
});

test('prices are the owner’s: accounts reads money and issues statements but sets no rate', (t) => {
  const f = billingFixture(t);
  const acc = member(f, 'ACCOUNTS', 'Pat');
  assert.throws(
    () => acc.cmd('hireRate', { product: f.product.id, day: 200 }),
    (e) => e.status === 403,
  );
  assert.throws(
    () => acc.cmd('hireSiteRate', { site: f.site.id, product: f.product.id, day: 200 }),
    (e) => e.status === 403,
  );
  assert.ok(acc.sim.hire({}).rates.length, 'reads them');
  const gm = member(f, 'GENERAL_MANAGER');
  assert.throws(
    () => gm.cmd('hireRate', { product: f.product.id, day: 200 }),
    (e) => e.status === 403,
  );
});

test('the statement says what moved and what the top-up covers; a same-day return is a line for nothing; the locked text carries the year, the company time and a reversal’s reason', (t) => {
  const f = billingFixture(t);
  f.cmd('hireRate', { product: f.product.id, day: 30, minDays: 28 });
  f.cmd('hireSettings', { xeroAccountCode: '200' });
  f.cmd('openingLot', { site: f.site.id, product: f.product.id, quantity: 30, onHireSince: D(-17) });
  f.deliver(f.site.id, 24, D0);
  f.collect(f.site.id, 54, D0);
  f.clock(D(1), '10:15');
  const p = f.sim.statementPreview({ customer: f.acme.id });
  const l = p.sites[0].lines[0];
  assert.deepEqual(l.moved, { in: 24, out: 54, sameDay: 24 });
  assert.deepEqual([l.start, l.end, l.pieceDays, l.amount], [30, 0, 17 * 30, 17 * 30 * 30]);
  assert.deepEqual(
    l.topUp.parts.map((x) => [x.q, x.days]),
    [
      [24, 28],
      [30, 11],
    ],
  );
  assert.equal(l.topUp.pieceDays, 24 * 28 + 30 * 11);
  const st = f.cmd('statementIssue', { customer: f.acme.id }).statement;
  const text = f.sim.statementReprint(st.id).text;
  assert.match(text, /30 at start · 24 in · 54 out \(24 same-day return\) · 0 at end · 510 piece-days/);
  assert.match(
    text,
    /minimum hire top-up: 24 × 28 days \+ 30 × 11 days short of the 28-day minimum · 1002 piece-days · \$300\.60/,
  );
  assert.match(text, /^Issued Wed 14 Oct 2026 · due Wed 28 Oct 2026$/m);
  assert.match(text, /^Period Sat 26 Sep 2026 to Tue 13 Oct 2026$/m);
  assert.match(text, /^Issued by Tee · Wed 14 Oct 2026 10:15 \(Australia\/Sydney\)$/m);
  assert.doesNotMatch(text, /T\d\d:\d\d:\d\d/, 'no raw timestamp');
  const x = f.sim.accountingFile({ format: 'xero', month: D(1).slice(0, 7) });
  assert.match(x.body, /minimum hire top-up: 24 × 28 days \+ 30 × 11 days short of the 28-day minimum/);
  assert.match(x.body, /30 at start · 24 in · 54 out/);
  // a same-day return with no minimum: a line for nothing, and nothing to issue on its own
  const g = billingFixture(t);
  g.deliver(g.site.id, 20, D0);
  g.collect(g.site.id, 20, D0);
  g.clock(D(1), '10:00');
  const q = g.sim.statementPreview({ customer: g.acme.id });
  const z = q.sites[0].lines[0];
  assert.deepEqual([z.zero, z.amount, z.pieceDays, z.moved.sameDay], [true, 0, 0, 20]);
  assert.equal(q.empty, true);
  assert.equal(q.whyCode, 'NOTHING_TO_BILL');
  // the reversal's reason on the document and in the list; the list says which file a statement is in
  const rv = f.cmd('statementReverse', { statement: st.id, reason: 'Wrong PO, reissue next week' }).statement;
  assert.match(f.sim.statementReprint(rv.id).text, /^Reverses ST-000001: Wrong PO, reissue next week$/m);
  const rows = f.sim.statementsView().statements;
  assert.equal(rows[0].reason, 'Wrong PO, reissue next week');
  assert.deepEqual(
    rows[1].exports.map((e) => [e.format, e.words, e.on]),
    [['XERO', 'Xero', D(1)]],
  );
  assert.equal(f.sim.hireSettingsView().updatedOn, D0);
  assert.equal(hireDollars(-234520), '-$2,345.20');
  assert.match(f.sim.siteAccount(f.site.id).summary, /^on hire at go-live 30 · sent 24 · back 54/);
});
