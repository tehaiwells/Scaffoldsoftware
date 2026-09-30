process.env.TZ = 'Australia/Sydney';
// Billing on screen (ADR 0011, Phase 1A part 4): the pages' pure render functions fed with the server's own views of a real yard driven
// only by commands (never a tick). Customers on Client sites (with the one-time link), the site card's billing block (bills to, off-hire
// with its pickup number, an opening lot), the Hire page's statement per customer (preview, Issue, the rule's words, the locked list with
// Reprint / Adjust / Reverse), the accounting file's "not set" state, the owner's hire settings, the go-live import screens with a refused
// row, the parallel run, the pasted-sheet parser, Needs you's new kinds, the Accounts role, and the Practice yard untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Simulation } from '../src/simulation.js';
import { addDays } from '../src/domain/schedule.js';
import {
  lbCustomersHTML,
  lbPickHTML,
  lbSiteHTML,
  lbStatementsHTML,
  lbStatementBodyHTML,
  lbSettingsHTML,
  lbGoLiveHTML,
  lbParallelHTML,
  lbParseSheet,
  lbMoney,
  lbCents,
  lbDay,
  __lb,
} from '../public/live-billing.js';
import { LT_KIND_WORDS, ltNeedsHTML } from '../public/live-today.js';
import { liveFixture, D0 } from './helpers/live-fixture.js';
const D = (n) => addDays(D0, n);
// A real yard with a day rate of $1.00 a piece, a customer for Bondi, a delivery, an opening lot, an off-hire and its collection.
function yard(t) {
  const f = liveFixture(t);
  f.cmd('hireRate', { product: f.product.id, day: 100 });
  f.acme = f.cmd('customerSave', {
    name: 'Acme Builders',
    abn: '53 004 085 616',
    billingEmail: 'ap@acme.test',
    termsDays: 14,
  }).customer;
  f.cmd('siteDetails', { id: f.site.id, customer: f.acme.id, po: 'PO-77' });
  f.deliver = (site, n, day) => {
    f.clock(day, '08:00');
    const o = f.cmd('orderCreate', { site, lines: [{ product: f.product.id, quantity: n }] }).order;
    const trip = f.cmd('tripBook', { orders: [o.id], truck: f.truck.id, driver: f.team.Dave.id }).trip;
    f.clock(day, '09:00');
    f.cmd('tripLoaded', { trip: trip.id });
    f.cmd('tripDelivered', { trip: trip.id, receivedBy: 'J. Smith' });
    f.cmd('tripReturned', { trip: trip.id });
    return trip;
  };
  return f;
}
function member(f, role, name = role) {
  const made = f.auth.invite(f.user, { email: randomUUID() + '@example.com', roles: [role] });
  const token = f.auth.acceptInvitation({ token: made.token, name, password: 'demonstration-password' });
  const sim = new Simulation(f.db, f.auth.authenticate(token));
  return { sim, cmd: (a, i = {}, key = randomUUID()) => sim.execute(a, i, key) };
}
const opts = { ops: true, finance: true, manage: true };

test('money, days and the pasted sheet', () => {
  assert.equal(lbMoney(123456), '$1,234.56');
  assert.equal(lbMoney(-4050), '-$40.50');
  assert.equal(lbMoney(null), '–');
  assert.equal(lbCents('120.00'), 12000);
  assert.equal(lbCents('-40.5'), -4050);
  assert.equal(lbCents('$1,200'), 120000);
  assert.equal(lbCents(''), null);
  assert.ok(Number.isNaN(lbCents('abc')));
  assert.equal(lbDay('2026-10-18'), 'Sun 18 Oct');
  assert.equal(lbDay('nope'), '');
  // tabs from a spreadsheet, a CRLF, a BOM; commas with quoted cells
  const tabs = lbParseSheet('﻿Name\tTerms\tPO\r\nAcme Builders\t14\tPO-77\r\nHarbour Homes\t30\t\r\n');
  assert.deepEqual(tabs.headers, ['Name', 'Terms', 'PO']);
  assert.deepEqual(tabs.rows, [
    { Name: 'Acme Builders', Terms: '14', PO: 'PO-77' },
    { Name: 'Harbour Homes', Terms: '30', PO: '' },
  ]);
  const csv = lbParseSheet(
    'Site,Customer,Address\n"Bondi","Acme Builders","1 Campbell Parade, Bondi"\nManly,"Harbour ""HH"" Homes",\n',
  );
  assert.deepEqual(csv.rows, [
    { Site: 'Bondi', Customer: 'Acme Builders', Address: '1 Campbell Parade, Bondi' },
    { Site: 'Manly', Customer: 'Harbour "HH" Homes', Address: '' },
  ]);
  assert.deepEqual(lbParseSheet('  \n'), { headers: [], rows: [] });
});

test('Customers on Client sites: the card, the picker, the one-time link, remove with a reason, and who sees what', (t) => {
  const f = yard(t);
  const coogee = f.cmd('site', { name: 'Coogee', address: '4 Arden St', client: 'Harbour Homes' }); // a free-text client, no customer yet
  __lb.reset();
  let v = f.sim.customersView();
  let html = lbCustomersHTML(v, opts);
  assert.match(html, /<b>Acme Builders<\/b>/);
  assert.match(html, /ABN 53 004 085 616 · 14 days terms · ap@acme.test/);
  assert.match(html, /1 site: Bondi \(PO PO-77\)/);
  assert.match(html, /Nothing unbilled/);
  assert.match(html, /data-lb-act="customerEdit"/);
  assert.match(html, /1 site with a client name but no customer: Coogee \(Harbour Homes\)/);
  assert.match(html, /data-lb-act="link">Link client names to customers/);
  // an operations manager keeps customers but sees no money; a supervisor sees neither the buttons nor the money
  html = lbCustomersHTML(v, { ops: true, finance: false, manage: true });
  assert.ok(!html.includes('unbilled') && html.includes('data-lb-act="customerEdit"'));
  html = lbCustomersHTML(v, { ops: false, finance: false, manage: false });
  assert.ok(!html.includes('data-lb-act') && !html.includes('unbilled'));
  // the picker
  html = lbPickHTML(v, f.acme.id);
  assert.match(
    html,
    /<select name="customer"><option value="">No customer yet<\/option><option value="[^"]+" selected>Acme Builders<\/option>/,
  );
  assert.match(lbPickHTML(null, null), /Loading customers…/);
  // the link makes Harbour Homes and links Coogee; the notice goes
  const linked = f.cmd('customerLinkSites', {});
  assert.equal(linked.created[0].name, 'Harbour Homes');
  v = f.sim.customersView();
  html = lbCustomersHTML(v, opts);
  assert.ok(!html.includes('Link client names'));
  assert.match(html, /<b>Harbour Homes<\/b>/);
  // the open forms: a new customer, a change, a removal with its reason
  __lb.open('customer', '');
  html = lbCustomersHTML(v, opts);
  assert.match(html, /data-lb-form="customer"><p class="lb-form-title">New customer/);
  assert.match(html, /name="abn"[^>]*placeholder="11 digits, checked"/);
  __lb.open('customerRemove', f.acme.id);
  html = lbCustomersHTML(v, opts);
  assert.match(html, /Remove Acme Builders<\/p>.*name="reason"/s);
  __lb.open(null);
  // removed customers are kept with the reason and can come back
  const hh = v.customers.find((c) => c.name === 'Harbour Homes');
  assert.throws(() => f.cmd('customerRemove', { id: hh.id, reason: 'Went bust' }), /Coogee still links/);
  f.cmd('archive', { id: coogee.id, reason: 'never used' });
  f.cmd('customerRemove', { id: hh.id, reason: 'Went bust' });
  html = lbCustomersHTML(f.sim.customersView(), opts);
  assert.match(html, /1 removed customer/);
  assert.match(html, /Harbour Homes<\/b><small>Removed .*: Went bust/);
  assert.match(html, /data-lb-act="customerRestore"/);
});

test('the site card: bills to, the off-hire notice with its pickup number, an opening lot; the forms', (t) => {
  const f = yard(t);
  __lb.reset();
  const site = f.sim.repo.get(f.site.id, 'site'),
    customers = f.sim.customersView(),
    products = f.sim.snapshot().products;
  let html = lbSiteHTML(site, { customers, offHires: f.sim.offHiresView(), ops: true, today: D0, products });
  assert.match(html, /Bills to<\/span><b>Acme Builders<\/b><small>PO PO-77<\/small>/);
  assert.match(html, /data-lb-act="offHire"[^>]*>Off-hire called…/);
  assert.match(html, /Already on hire here\? Add an opening lot/);
  // a site with no customer says so, plainly
  const other = f.cmd('gameSite', { name: 'Coogee' }).site;
  html = lbSiteHTML(other, { customers, offHires: null, ops: true, today: D0, products });
  assert.match(html, /<i>No customer yet<\/i><small>Set it under Edit site details<\/small>/);
  // the opening-lot form offers the customer only when the site has none
  __lb.open('openingLot', other.id);
  html = lbSiteHTML(other, { customers, offHires: null, ops: true, today: D0, products });
  assert.match(html, /data-lb-form="openingLot"/);
  assert.match(html, /<select name="product" required>/);
  assert.match(html, /name="onHireSince" type="date"[^>]*max="2026-10-13"/);
  assert.match(html, /<select name="customer">/);
  __lb.open('openingLot', f.site.id);
  html = lbSiteHTML(site, { customers, offHires: null, ops: true, today: D0, products });
  assert.ok(!html.includes('<select name="customer">'), 'Bondi already bills to Acme');
  // the off-hire form, its days bounded by today
  __lb.open('offHire', f.site.id, { when: D0, pickupDay: D0 });
  html = lbSiteHTML(site, { customers, offHires: null, ops: true, today: D0, products });
  assert.match(html, /name="when" type="date" value="2026-10-13"[^>]*max="2026-10-13"/);
  assert.match(html, /name="pickupDay" type="date" value="2026-10-13"[^>]*min="2026-10-13"/);
  assert.match(html, /Record the off-hire/);
  __lb.open(null);
  // the builder calls it off: the card shows the pickup number and the bring-back; once collected, the collection day
  f.deliver(f.site.id, 12, D(1));
  f.clock(D(3), '10:00');
  const off = f.cmd('offHireRequested', { site: f.site.id, when: D(3), whoCalled: 'Mick' });
  html = lbSiteHTML(site, { customers, offHires: f.sim.offHiresView(), ops: true, today: D(3), products });
  assert.match(
    html,
    /Off-hire<\/span><b>P-1<\/b><small>called Fri 16 Oct by Mick · pickup B-1 for Fri 16 Oct<\/small>/,
  );
  assert.ok(!html.includes('Off-hire called…'), 'one pickup at a time');
  f.clock(D(4), '10:00');
  html = lbSiteHTML(site, { customers, offHires: f.sim.offHiresView(), ops: true, today: D(4), products });
  assert.match(html, /is-late/);
  assert.match(html, /not collected yet/);
  const trip = f.cmd('tripBook', { orders: [off.order.id], truck: f.truck.id, driver: f.team.Dave.id }).trip;
  f.clock(D(4), '13:00');
  f.cmd('tripCollected', { trip: trip.id });
  f.cmd('tripReturned', { trip: trip.id });
  html = lbSiteHTML(site, { customers, offHires: f.sim.offHiresView(), ops: true, today: D(4), products });
  assert.match(html, /P-1<\/b><small>called Fri 16 Oct by Mick · collected Sat 17 Oct/);
  assert.match(html, /Off-hire called…/);
  // a supervisor's card: no buttons
  html = lbSiteHTML(site, { customers, offHires: null, ops: false, today: D(4), products });
  assert.ok(!html.includes('data-lb-act'));
});

test('the Hire page: the statement per customer from preview to locked, the rule on the line, the file, the settings; Accounts sees money only', (t) => {
  const f = yard(t);
  __lb.reset();
  f.cmd('openingLot', { site: f.site.id, product: f.product.id, quantity: 5, onHireSince: D(-10) });
  f.deliver(f.site.id, 12, D(1));
  f.clock(D(3), '10:00');
  const off = f.cmd('offHireRequested', { site: f.site.id, when: D(3), whoCalled: 'Mick' });
  const trip = f.cmd('tripBook', { orders: [off.order.id], truck: f.truck.id, driver: f.team.Dave.id }).trip;
  f.clock(D(4), '13:00');
  f.cmd('tripCollected', { trip: trip.id });
  f.cmd('tripReturned', { trip: trip.id });
  const customers = f.sim.customersView(),
    settings = f.sim.hireSettingsView(),
    today = D(4);
  // no customer chosen yet: the page says what to do; then the preview with Issue for someone who may issue
  let html = lbStatementsHTML({
    customers,
    statements: f.sim.statementsView(),
    preview: null,
    settings,
    today,
    issue: true,
    owner: true,
  });
  assert.match(html, /Choose a customer: everything unbilled at its sites since the last statement shows here/);
  assert.match(html, /Acme Builders · \$\d+\.\d\d unbilled<\/option>/);
  assert.match(html, /Nothing issued yet/);
  assert.match(html, /Xero: sales account code not set\. MYOB: income account number not set\./);
  assert.match(html, /data-lb-fmt="xero" disabled/);
  __lb.set('cust', f.acme.id);
  const preview = f.sim.statementPreview({ customer: f.acme.id });
  html = lbStatementsHTML({
    customers,
    statements: f.sim.statementsView(),
    preview,
    settings,
    today,
    issue: true,
    owner: true,
  });
  assert.match(html, /<span class="lb-badge">Preview<\/span><b>Acme Builders<\/b>/);
  assert.match(html, /Off-hire called Fri 16 Oct by Mick \(pickup P-1\)\. Hire stopped Fri 16 Oct/);
  assert.match(html, /Company rule: hire stops on the off-hire day/);
  assert.match(html, /Statement — your accounting package issues the tax invoice\./);
  assert.match(html, /Due .*\(14-day terms\)/);
  assert.match(html, /data-lb-act="issue"[^>]*>Issue statement/);
  assert.match(html, /Total inc GST<\/small><b>\$\d/);
  // an accounts person without statements.manage (none such: ACCOUNTS has it) — a viewer with finance only sees no Issue
  html = lbStatementsHTML({
    customers,
    statements: f.sim.statementsView(),
    preview,
    settings,
    today,
    issue: false,
    owner: false,
  });
  assert.ok(!html.includes('data-lb-act="issue"'));
  assert.ok(!html.includes('Download for Xero'));
  // an unpriced part blocks the issue with the reason
  const blocked = {
    ...preview,
    canIssue: false,
    why: 'No rate yet for Ledger 2.4 m. Set the rate first: a statement never goes out incomplete.',
  };
  html = lbStatementsHTML({
    customers,
    statements: f.sim.statementsView(),
    preview: blocked,
    settings,
    today,
    issue: true,
    owner: true,
  });
  assert.match(html, /is-blocked/);
  assert.match(html, /<p class="lb-why">No rate yet for Ledger 2\.4 m\./);
  assert.ok(!html.includes('data-lb-act="issue"'));
  // issued: the locked list with Reprint for everyone, Adjust and Reverse for the owner only; the exports once downloaded
  const st = f.cmd('statementIssue', { customer: f.acme.id }).statement;
  assert.equal(st.number, 'ST-000001');
  __lb.set('issued', st);
  html = lbStatementsHTML({
    customers: f.sim.customersView(),
    statements: f.sim.statementsView(),
    preview: null,
    settings,
    today,
    issue: true,
    owner: true,
  });
  assert.match(html, /<b>ST-000001 issued<\/b>/);
  assert.match(html, /href="\/api\/statement\.txt\?id=[^"]+" target="_blank"[^>]*>Reprint<\/a>/);
  assert.match(html, /<b>ST-000001<\/b><span class="lb-badge lock"[^>]*>Locked<\/span>/);
  assert.match(html, /issued Sat 17 Oct by Tee/);
  assert.match(html, /data-lb-act="adjust"/);
  assert.match(html, /data-lb-act="reverse"/);
  html = lbStatementsHTML({
    customers,
    statements: f.sim.statementsView(),
    preview: null,
    settings,
    today,
    issue: true,
    owner: false,
  });
  assert.ok(
    html.includes('Reprint') && !html.includes('data-lb-act="adjust"') && !html.includes('data-lb-act="reverse"'),
  );
  // the adjustment and reversal forms
  __lb.set('issued', null);
  __lb.open('adjust', st.id);
  html = lbStatementsHTML({
    customers,
    statements: f.sim.statementsView(),
    preview: null,
    settings,
    today,
    issue: true,
    owner: true,
  });
  assert.match(
    html,
    /data-lb-form="adjust" data-lb-id="[^"]+" data-lb-cust-id="[^"]+"><p class="lb-form-title">Adjustment after ST-000001/,
  );
  assert.match(html, /Amount ex GST \(\$, minus for a credit\)/);
  __lb.open('reverse', st.id);
  html = lbStatementsHTML({
    customers,
    statements: f.sim.statementsView(),
    preview: null,
    settings,
    today,
    issue: true,
    owner: true,
  });
  assert.match(html, /Reverse ST-000001<\/p>/);
  __lb.open(null);
  // a reversed statement and its reversal wear their badges
  f.cmd('statementReverse', { statement: st.id, reason: 'Wrong PO' });
  html = lbStatementsHTML({
    customers,
    statements: f.sim.statementsView(),
    preview: null,
    settings,
    today,
    issue: true,
    owner: true,
  });
  assert.match(html, /<b>ST-000002<\/b>.*reverses ST-000001/);
  assert.match(html, /<b>ST-000001<\/b>.*reversed by ST-000002/s);
  assert.equal((html.match(/data-lb-act="reverse"/g) ?? []).length, 0, 'neither can be reversed again');
  // the stored body renders the same lines as the preview did
  const body = lbStatementBodyHTML(f.sim.statementGet(st.id));
  assert.match(body, /Bondi<\/b>/);
  assert.match(body, /pickup P-1/);
  assert.match(body, /Bondi subtotal/);
  // once the owner sets the codes the buttons come alive, and the file words show after a download
  f.cmd('hireSettings', { xeroAccountCode: '200', myobAccountNumber: '4-1000' });
  const ready = f.sim.hireSettingsView();
  html = lbStatementsHTML({
    customers,
    statements: f.sim.statementsView(),
    preview: null,
    settings: ready,
    today,
    issue: true,
    owner: true,
  });
  assert.match(html, /data-lb-fmt="xero">Download for Xero/);
  assert.match(html, /data-lb-fmt="myob">Download for MYOB/);
  assert.ok(!html.includes('not set'));
  __lb.set('file', {
    name: 'scaffold-xero-2026-10.csv',
    statements: ['ST-000001', 'ST-000002'],
    total: 0,
    words: 'When Xero asks, the amounts are Tax Exclusive and the dates are DD/MM/YYYY.',
  });
  html = lbStatementsHTML({
    customers,
    statements: f.sim.statementsView(),
    preview: null,
    settings: ready,
    today,
    issue: true,
    owner: true,
  });
  assert.match(
    html,
    /scaffold-xero-2026-10\.csv<\/b> saved: 2 statements, \$0\.00 inc GST\. When Xero asks, the amounts are Tax Exclusive/,
  );
  __lb.set('file', {
    err: 'Set the Xero sales account code in Hire settings first (the account your sales go to in Xero).',
  });
  html = lbStatementsHTML({
    customers,
    statements: f.sim.statementsView(),
    preview: null,
    settings,
    today,
    issue: true,
    owner: true,
  });
  assert.match(html, /Set the Xero sales account code in Hire settings first/);
  // the settings card: the owner's, with the rule in words and 'not set' placeholders; nobody else gets it
  html = lbSettingsHTML(settings, { owner: true });
  assert.match(html, /name="stopRule" value="OFF_HIRE_DAY" checked/);
  assert.match(html, /name="collectWithinDays"[^>]*value="7"/);
  assert.match(html, /Now: Company rule: hire stops on the off-hire day/);
  assert.match(html, /name="xeroAccountCode"[^>]*placeholder="not set"/);
  assert.match(html, /name="retentionYears"[^>]*value="7"/);
  assert.equal(lbSettingsHTML(settings, { owner: false }), '');
  html = lbSettingsHTML(ready, { owner: true });
  assert.match(html, /name="xeroAccountCode"[^>]*value="200"/);
  // Accounts: the statement views answer; operations do not
  const acc = member(f, 'ACCOUNTS', 'Pat');
  assert.equal(acc.sim.statementsView().statements.length, 2);
  assert.ok(acc.sim.customersView().customers[0].exposure, 'sees the money');
  assert.throws(() => acc.sim.offHiresView(), /not allow/);
  assert.throws(() => acc.cmd('offHireRequested', { site: f.site.id, when: today, whoCalled: 'Mick' }), /not allow/);
  const sup = member(f, 'SUPERVISOR', 'Sam');
  assert.throws(() => sup.sim.statementsView(), /owner and accounts/);
});

test('go-live on screen: the lists, a refused row explained, what came in; the parallel run', (t) => {
  const f = yard(t);
  __lb.reset();
  assert.equal(lbGoLiveHTML({ owner: false }), '');
  let html = lbGoLiveHTML({ owner: true });
  assert.match(html, /data-lb-kind="customers" aria-pressed="true">Customers/);
  assert.match(html, /data-lb-kind="onHire" aria-pressed="false">On hire/);
  assert.match(html, /Columns for customers: Name, ABN, email, address, terms, PO/);
  assert.match(html, /data-lb-act="glImport" disabled/);
  // the check of a pasted sheet with a wrong date: the page shows the server's row-by-row answer and keeps Bring them in off
  const rows = lbParseSheet(
    'Site\tPart\tQty\tSince\nBondi\t' +
      f.product.name +
      '\t8\tlast month\nBondi\t' +
      f.product.name +
      '\t4\t13/09/2026',
  ).rows;
  const check = f.sim.goLivePreview({ kind: 'onHire', rows });
  assert.equal(check.ok, false);
  __lb.golive({ kind: 'onHire', text: 'x', rows, check });
  html = lbGoLiveHTML({ owner: true });
  assert.match(html, /<div class="lb-check bad">/);
  assert.match(html, /<li class="bad"><b>1<\/b><span>.*<em>.*not understood/);
  assert.match(html, /<li class="ok"><b>2<\/b>/);
  assert.match(html, /data-lb-act="glImport" disabled/);
  // a clean sheet: Bring them in is on; what came in is said
  const good = lbParseSheet('Name\tTerms\nHarbour Homes\t30').rows;
  __lb.golive({
    kind: 'customers',
    rows: good,
    check: f.sim.goLivePreview({ kind: 'customers', rows: good }),
    result: null,
  });
  html = lbGoLiveHTML({ owner: true });
  assert.match(html, /<div class="lb-check ok">/);
  assert.match(html, /<li class="ok"><b>1<\/b><span>Harbour Homes · 30-day terms \(new\)<\/span>/);
  assert.match(html, /data-lb-act="glImport">Bring them in/);
  const r = f.cmd('goLiveImport', { kind: 'customers', rows: good });
  __lb.golive({ check: null, result: r });
  html = lbGoLiveHTML({ owner: true });
  assert.match(
    html,
    /<p class="lb-done" role="status"><b>1 record brought in from the customers list\.<\/b> Harbour Homes/,
  );
  // the parallel run: the app's figure beside the typed one, the difference coloured
  f.cmd('openingLot', { site: f.site.id, product: f.product.id, quantity: 10, onHireSince: D(-10) });
  f.clock(D0, '17:00');
  const pr = f.sim.parallelRun({ from: D(-10), to: D0, invoiced: [{ customer: f.acme.id, amount: 10000 }] });
  __lb.prun({ from: D(-10), to: D0, typed: { [f.acme.id]: '100.00' }, result: pr });
  html = lbParallelHTML();
  assert.match(html, /<b>Acme Builders<\/b><small>1 site<\/small><\/td><td class="num">\$110\.00<\/td>/);
  assert.match(html, /data-lb-typed="[^"]+"[^>]*value="100\.00"/);
  assert.match(html, /<td class="num is-over"><b>\$10\.00<\/b><small>\+10%<\/small>/);
  assert.match(html, /Work it out again/);
});

test('Needs you says the two new kinds in a few words; the Practice yard renders none of this', (t) => {
  assert.equal(LT_KIND_WORDS.OFF_HIRE_OVERDUE, 'Pickup overdue');
  assert.equal(LT_KIND_WORDS.UNBILLED, 'Unbilled');
  const html = ltNeedsHTML(
    {
      count: 2,
      cap: 5,
      items: [
        {
          id: 'a',
          kind: 'OFF_HIRE_OVERDUE',
          since: '2026-10-12',
          words: 'Pickup P-1 at Bondi was for Mon 12 Oct',
          action: { label: 'Book the pickup', view: 'TODAY', order: 'o1' },
        },
        {
          id: 'b',
          kind: 'UNBILLED',
          since: '2026-09-01',
          words: 'Acme Builders: unbilled since 1 Sep',
          action: { label: 'Issue the statement', view: 'HIRE', customer: 'c1' },
        },
      ],
    },
    { ops: true, today: '2026-10-13' },
  );
  assert.match(html, /Pickup overdue · since yesterday/);
  assert.match(html, /Unbilled · for 42 days/);
  assert.match(html, /Book the pickup/);
  assert.match(html, /Issue the statement/);
  // the Practice yard: the server's customers view is empty and the site card's block has nothing to say
  const f = liveFixture(t);
  const demo = new Simulation(f.db, f.owner);
  assert.deepEqual(demo.customersView(), { live: false, customers: [], removed: [], unlinkedSites: [] });
  assert.throws(() => demo.execute('customerSave', { name: 'X' }, randomUUID()), /real yard|Practice/i);
});
