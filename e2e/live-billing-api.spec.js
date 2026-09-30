import { test, expect, request as playwrightRequest } from '@playwright/test';
// Phase 1A part 4 (ADR 0011), through the running server only (the pages come with the UI builder): customer -> site -> send ->
// deliver -> off-hire -> collect -> issue statement -> download the Xero file -> reprint identical; and an opening lot brought in at
// go-live producing a first statement from its own date.
const key = () => 'e2e-' + Date.now() + '-' + Math.random().toString(36).slice(2);
const dayOf = (iso) => iso.slice(0, 10);
const addDays = (day, n) => {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
test('customer, site, send, deliver, off-hire, collect, statement, Xero file, identical reprint; an opening lot bills from its date', async ({
  baseURL,
}) => {
  const desk = await playwrightRequest.newContext({ baseURL });
  const cmd = async (action, data) => {
    const r = await desk.post('/api/commands/' + action, { data, headers: { 'Idempotency-Key': key() } });
    expect(r.status(), action + ': ' + (await r.text())).toBe(200);
    return r.json();
  };
  const get = async (path) => {
    const r = await desk.get(path);
    expect(r.status(), path + ': ' + (await r.text())).toBe(200);
    return r.json();
  };
  const reg = await desk.post('/api/register', {
    data: {
      companyName: 'Tee Scaffolding',
      name: 'Tee',
      email: `billing-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'Local-demo-test-2026!',
      systems: ['quickstage'],
      mode: 'LIVE',
    },
  });
  expect(reg.status()).toBe(200);
  const { yard } = await cmd('gameStart', { size: 'S' });
  await cmd('gameCatalogue', {});
  const state = await get('/api/state');
  const product = state.products.find((p) => p.unitWeight > 0 && !p.retired);
  await cmd('gameAddStock', { lines: [{ product: product.id, quantity: 40 }] });
  await cmd('hireRate', { product: product.id, day: 100 });
  const truck = await cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: yard.id });
  const dave = (await cmd('teamAdd', { name: 'Dave', role: 'DRIVER' })).person;
  // the customer, and a site that bills to it (Send's New site takes a customer and a PO)
  const acme = (
    await cmd('customerSave', {
      name: 'Acme Builders',
      abn: '53 004 085 616',
      billingEmail: 'ap@acme.test',
      termsDays: 14,
    })
  ).customer;
  expect(acme.abnText).toBe('53 004 085 616');
  const site = (
    await cmd('gameSite', { name: 'Bondi', address: '1 Campbell Parade, Bondi', customer: acme.id, po: 'PO-77' })
  ).site;
  const customers = await get('/api/customers');
  expect(customers.customers[0].sites.map((s) => [s.name, s.po])).toEqual([['Bondi', 'PO-77']]);
  // today on company time (never the browser's or the test's clock)
  const trips0 = await get('/api/trips');
  const today = trips0.today;
  // send and deliver (the day may be over: then the booking is for tomorrow, the confirmations are recorded now either way)
  const order = (await cmd('orderCreate', { site: site.id, lines: [{ product: product.id, quantity: 12 }] })).order;
  const book = async (orders) => {
    let r = await desk.post('/api/commands/tripBook', {
      data: { orders, truck: truck.id, driver: dave.id },
      headers: { 'Idempotency-Key': key() },
    });
    if (r.status() === 409 && /nearly over|has passed/.test((await r.json()).error))
      r = await desk.post('/api/commands/tripBook', {
        data: { orders, truck: truck.id, driver: dave.id, day: addDays(today, 1) },
        headers: { 'Idempotency-Key': key() },
      });
    expect(r.status(), await r.text()).toBe(200);
    return (await r.json()).trip;
  };
  const out = await book([order.id]);
  await cmd('tripLoaded', { trip: out.id });
  await cmd('tripDelivered', { trip: out.id, receivedBy: 'J. Smith' });
  await cmd('tripReturned', { trip: out.id });
  // an opening lot from 10 days ago on the same site (gear that was already out when the yard went live)
  const lot = (
    await cmd('openingLot', { site: site.id, product: product.id, quantity: 5, onHireSince: addDays(today, -10) })
  ).lot;
  expect(dayOf(lot.occurredAt) <= addDays(today, -9)).toBe(true);
  // the builder called it off yesterday: a pickup number and a bring-back for everything on record, for today
  const off = await cmd('offHireRequested', { site: site.id, when: addDays(today, -1), whoCalled: 'Mick' });
  expect(off.offHire.label).toBe('P-1');
  expect(off.order.lines[0].requested).toBe(17);
  const coll = await book([off.order.id]);
  await cmd('tripCollected', { trip: coll.id });
  await cmd('tripReturned', { trip: coll.id });
  expect((await get('/api/off-hire')).offHires[0].status).toBe('COLLECTED');
  // the preview, then the locked statement: one per customer, sequential, with the rule's words on the line the rule touched
  const preview = await get('/api/statement-preview?customer=' + acme.id);
  expect(preview.canIssue).toBe(true);
  expect(preview.subtotal).toBe(
    9 * 5 * 100,
    'the lot ran from 10 days ago to the day before the off-hire call; today’s send came back the same day',
  );
  const issued = (await cmd('statementIssue', { customer: acme.id })).statement;
  expect(issued.number).toBe('ST-000001');
  expect(issued.subtotal).toBe(4500);
  expect(issued.gst).toBe(450);
  expect(issued.total).toBe(4950);
  expect(issued.sites[0].lines[0].offHire[0].words).toMatch(/Off-hire called .* by Mick \(pickup P-1\)\. Hire stopped/);
  expect(issued.hireStopRule).toMatch(/Company rule: hire stops on the off-hire day/);
  expect(issued.footer).toBe('Statement — your accounting package issues the tax invoice.');
  const again = await desk.post('/api/commands/statementIssue', {
    data: { customer: acme.id },
    headers: { 'Idempotency-Key': key() },
  });
  expect(again.status()).toBe(409);
  expect((await again.json()).code).toBe('ALREADY_ISSUED');
  // the reprint is byte-identical, before and after a rate change dated after the statement
  const print1 = await (await desk.get('/api/statement.txt?id=' + issued.id)).text();
  const rate = await desk.post('/api/commands/hireRate', {
    data: { product: product.id, day: 200 },
    headers: { 'Idempotency-Key': key() },
  });
  expect(rate.status()).toBe(409);
  expect((await rate.json()).code).toBe('BILLED');
  await cmd('hireRate', { product: product.id, day: 200, from: addDays(today, 1) });
  const print2 = await (await desk.get('/api/statement.txt?id=' + issued.id)).text();
  expect(print2).toBe(print1);
  expect(print1).toMatch(/HIRE STATEMENT ST-000001/);
  expect((await get('/api/statement?id=' + issued.id)).total).toBe(4950);
  // the Xero file needs the owner's account code, then carries the statement
  const month = today.slice(0, 7);
  const refused = await desk.get('/api/accounting.csv?format=xero&month=' + month);
  expect(refused.status()).toBe(409);
  await cmd('hireSettings', { xeroAccountCode: '200', myobAccountNumber: '4-1000' });
  const xero = await desk.get('/api/accounting.csv?format=xero&month=' + month);
  expect(xero.status()).toBe(200);
  expect(xero.headers()['content-disposition']).toContain('scaffold-xero-' + month + '.csv');
  const lines = (await xero.text()).split('\r\n').filter(Boolean);
  expect(lines[0]).toMatch(/^"\*ContactName","EmailAddress"/);
  expect(lines[1]).toContain('"Acme Builders"');
  expect(lines[1]).toContain('"ST-000001"');
  expect(lines[1]).toContain('"45.00"');
  expect(lines[1]).toContain('"200"');
  const myob = await desk.get('/api/accounting.csv?format=myob&month=' + month);
  expect(myob.status()).toBe(200);
  expect((await myob.text()).split('\r\n')[0]).toMatch(/^Co\.\/Last Name\tFirst Name/);
  expect((await get('/api/statements')).statements.map((s) => s.number)).toEqual(['ST-000001']);
  expect((await get('/api/statement?id=' + issued.id)).exports.map((e) => e.format)).toEqual(['XERO', 'MYOB']);
  // unbilled: nothing left for Acme after the statement; Today's card reads the same
  const unbilled = await get('/api/unbilled');
  expect(unbilled.amount).toBe(0);
  const todayView = await get('/api/today');
  expect(todayView.business.money.toInvoiceWords).toBe('Nothing unbilled');
  // a second customer brought in at go-live: sites and an on-hire list from a pasted sheet, then its first statement from the lot's date
  const gl = await cmd('goLiveImport', { kind: 'customers', rows: [{ Name: 'Harbour Homes', Terms: '30' }] });
  expect(gl.made.length).toBe(1);
  await cmd('goLiveImport', { kind: 'sites', rows: [{ Site: 'Manly', Customer: 'Harbour Homes', PO: 'HH-1' }] });
  const bad = await desk.post('/api/commands/goLiveImport', {
    data: { kind: 'onHire', rows: [{ Site: 'Manly', Part: product.name, Qty: '8', Since: 'last month' }] },
    headers: { 'Idempotency-Key': key() },
  });
  expect(bad.status()).toBe(409);
  expect((await bad.json()).detail.check.rows[0].problems[0]).toMatch(/not understood/);
  const since = addDays(today, -20);
  await cmd('goLiveImport', { kind: 'onHire', rows: [{ Site: 'Manly', Part: product.name, Qty: '8', Since: since }] });
  // a statement runs to yesterday while the lot is still out (a statement to today is refused while gear is on hire)
  const toToday = await desk.post('/api/commands/statementIssue', {
    data: { customer: gl.made[0].id, to: today },
    headers: { 'Idempotency-Key': key() },
  });
  expect(toToday.status()).toBe(409);
  expect((await toToday.json()).code).toBe('TO_TODAY');
  const first = (await cmd('statementIssue', { customer: gl.made[0].id })).statement;
  expect(first.number).toBe('ST-000002');
  expect(first.sites[0].from).toBe(since);
  expect(first.to).toBe(addDays(today, -1));
  expect(first.sites[0].lines[0].pieceDays).toBe(20 * 8);
  expect(first.subtotal).toBe(20 * 8 * 100, 'priced at the rate of each day: the new rate starts tomorrow');
  expect(first.gst).toBe(1600);
  await desk.dispose();
});
