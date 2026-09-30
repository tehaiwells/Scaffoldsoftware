import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Phase 1A part 4 (ADR 0011) on the pages people use: a customer is added on Client sites, a site is made billing to it, gear goes out
// (the driver's taps) and an opening lot is added on the site card, the builder calls it off on the site card (a pickup number), the
// gear is collected, the Hire page previews the customer's statement and issues it (locked, numbered), the owner sets the Xero code and
// downloads the file, a reprint is byte-identical; then a second customer and its on-hire list come in through the go-live screens and
// get their first statement from the lot's own date.
const key = () => 'e2e-' + Date.now() + '-' + Math.random().toString(36).slice(2);
const addDays = (day, n) => {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
test('customer → site → send → deliver → opening lot → off-hire → collect → issue → Xero file → identical reprint; go-live import → first statement', async ({
  page,
}) => {
  test.setTimeout(300000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const api = async (path, data) => {
    const r = data
      ? await page.request.post('/api/' + path, { data, headers: { 'Idempotency-Key': key() } })
      : await page.request.get('/api/' + path);
    expect(r.ok(), path + ': ' + (await r.text())).toBe(true);
    return r.json();
  };
  const cmd = (a, d) => api('commands/' + a, d);
  expect(
    (
      await page.request.post('/api/register', {
        data: {
          companyName: 'Tee Scaffolding',
          name: 'Tee',
          email: `billing-ui-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
          password: 'Local-demo-test-2026!',
          systems: ['quickstage'],
          mode: 'LIVE',
        },
      })
    ).status(),
  ).toBe(200);
  const { yard } = await cmd('gameStart', { size: 'S' });
  await cmd('gameCatalogue', {});
  const product = (await api('state')).products.find((p) => p.unitWeight > 0 && !p.retired && p.packQuantity == null);
  await cmd('gameAddStock', { lines: [{ product: product.id, quantity: 40 }] });
  await cmd('hireRate', { product: product.id, day: 100 });
  const truck = await cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: yard.id, payload: 12500000 });
  const dave = (await cmd('teamAdd', { name: 'Dave', role: 'DRIVER' })).person;
  const today = (await api('trips')).today;

  // ---- Client sites: the customer, then the site billing to it
  await page.goto('/?view=SITES');
  await expect(page.getByRole('heading', { level: 1, name: 'Client sites', exact: true })).toBeVisible({
    timeout: 45000,
  });
  const custCard = page.locator('#lb-customers');
  await expect(custCard).toContainText('No customers yet', { timeout: 30000 });
  await custCard.getByRole('button', { name: '+ Customer', exact: true }).click();
  const cf = custCard.locator('[data-lb-form="customer"]');
  await cf.locator('input[name=name]').fill('Acme Builders');
  await cf.locator('input[name=abn]').fill('53 004 085 616');
  await cf.locator('input[name=billingEmail]').fill('ap@acme.test');
  await cf.locator('input[name=termsDays]').fill('14');
  await cf.getByRole('button', { name: 'Add customer', exact: true }).click();
  await expect(custCard).toContainText('ABN 53 004 085 616 · 14 days terms · ap@acme.test', { timeout: 30000 });
  await expect(custCard).toContainText('No open site');
  const acme = (await api('customers')).customers[0];
  // Create a site: the customer picker and the PO are in the form of a real yard
  await page.locator('summary').filter({ hasText: 'Create a site' }).click();
  const sf = page.locator('form#site');
  await sf.locator('input[name=name]').fill('Bondi');
  await sf.locator('input[name=address]').fill('1 Campbell Parade, Bondi');
  await sf.locator('select[name=customer]').selectOption({ label: 'Acme Builders' });
  await sf.locator('input[name=po]').fill('PO-77');
  await sf.getByRole('button', { name: 'Create site', exact: true }).click();
  const siteCard = page.locator('[data-site-panel]').filter({ hasText: 'Bondi' }).first();
  await expect(siteCard).toContainText('Bills to', { timeout: 30000 });
  await expect(siteCard).toContainText('Acme Builders');
  await expect(siteCard).toContainText('PO PO-77');
  await expect(custCard).toContainText('1 site: Bondi (PO PO-77)', { timeout: 30000 });
  const site = (await api('state')).sites.find((s) => s.name === 'Bondi');
  expect(site.customer).toBe(acme.id);

  // ---- send and deliver (the driver's taps), then an opening lot on the site card: 5 pieces since 10 days ago
  const order = (await cmd('orderCreate', { site: site.id, lines: [{ product: product.id, quantity: 12 }] })).order;
  const book = async (orders) => {
    let r = await page.request.post('/api/commands/tripBook', {
      data: { orders, truck: truck.id, driver: dave.id },
      headers: { 'Idempotency-Key': key() },
    });
    if (r.status() === 409 && /nearly over|has passed/.test((await r.json()).error))
      r = await page.request.post('/api/commands/tripBook', {
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
  await page.goto('/?view=SITES');
  await expect(siteCard).toContainText('Bills to', { timeout: 45000 });
  await siteCard.getByRole('button', { name: 'Already on hire here? Add an opening lot', exact: true }).click();
  const lot = siteCard.locator('[data-lb-form="openingLot"]');
  await lot.locator('select[name=product]').selectOption(product.id);
  await lot.locator('input[name=quantity]').fill('5');
  await lot.locator('input[name=onHireSince]').fill(addDays(today, -10));
  await lot.getByRole('button', { name: 'Add the lot', exact: true }).click();
  await expect(lot).toHaveCount(0, { timeout: 30000 });
  await expect(
    page
      .locator('#toast, .toast, [role=status]')
      .filter({ hasText: '5 × ' + product.name })
      .first(),
  ).toBeVisible({
    timeout: 30000,
  });

  // ---- the builder called it off yesterday: the site card gives it a pickup number
  await siteCard.getByRole('button', { name: 'Off-hire called…', exact: true }).click();
  const off = siteCard.locator('[data-lb-form="offHire"]');
  await off.locator('input[name=when]').fill(addDays(today, -1));
  await off.locator('input[name=whoCalled]').fill('Mick');
  await off.getByRole('button', { name: 'Record the off-hire', exact: true }).click();
  await expect(siteCard).toContainText('P-1', { timeout: 30000 });
  await expect(siteCard).toContainText('by Mick · pickup B-1');
  const offHires = (await api('off-hire')).offHires;
  expect(offHires[0].label).toBe('P-1');
  const coll = await book([offHires[0].order]);
  await cmd('tripCollected', { trip: coll.id });
  await cmd('tripReturned', { trip: coll.id });

  // ---- Hire: the customer's preview, then Issue → locked and numbered; the rule's words on the line
  await page.goto('/?view=HIRE');
  await expect(page.getByRole('heading', { level: 1, name: 'Hire', exact: true })).toBeVisible({ timeout: 45000 });
  const st = page.locator('#lb-statements');
  await expect(st).toContainText('Choose a customer', { timeout: 45000 });
  await st.locator('[data-lb-cust]').selectOption(acme.id);
  await expect(st).toContainText('Preview', { timeout: 30000 });
  await expect(st).toContainText('Off-hire called');
  await expect(st).toContainText('by Mick (pickup P-1)');
  await expect(st).toContainText('Company rule: hire stops on the off-hire day');
  await expect(st).toContainText('$45.00'); // the lot: 5 pieces × 9 days at $1.00; today’s send came back the same day
  await expect(st).toContainText('$49.50');
  await expect(st).toContainText('Statement — your accounting package issues the tax invoice.');
  await st.getByRole('button', { name: 'Issue statement', exact: true }).click();
  await expect(st).toContainText('ST-000001 issued', { timeout: 30000 });
  await expect(st.locator('.lb-st').first()).toContainText('ST-000001');
  await expect(st.locator('.lb-st').first()).toContainText('Locked');
  await expect(st.locator('.lb-st').first()).toContainText('$49.50');
  const issued = (await api('statements')).statements[0];
  expect(issued.number).toBe('ST-000001');
  // the Xero file needs the owner's code first: the page says so and the button is off; the settings card takes it
  await expect(st).toContainText('Xero: sales account code not set');
  await expect(st.locator('[data-lb-fmt="xero"]')).toBeDisabled();
  const settings = page.locator('#lb-settings');
  await settings.locator('input[name=xeroAccountCode]').fill('200');
  await settings.locator('input[name=myobAccountNumber]').fill('4-1000');
  await settings.getByRole('button', { name: 'Save hire settings', exact: true }).click();
  await expect(st.locator('[data-lb-fmt="xero"]')).toBeEnabled({ timeout: 30000 });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    st.locator('[data-lb-fmt="xero"]').click(),
  ]);
  expect(download.suggestedFilename()).toBe('scaffold-xero-' + today.slice(0, 7) + '.csv');
  const lines = readFileSync(await download.path(), 'utf8')
    .split('\r\n')
    .filter(Boolean);
  expect(lines[0]).toMatch(/^"\*ContactName","EmailAddress"/);
  expect(lines[1]).toContain('"Acme Builders"');
  expect(lines[1]).toContain('"ST-000001"');
  expect(lines[1]).toContain('"45.00"');
  expect(lines[1]).toContain('"200"');
  await expect(st).toContainText('When Xero asks, the amounts are Tax Exclusive', { timeout: 30000 });
  // the reprint: the same bytes twice, and the same after a rate change dated tomorrow
  const print1 = await (await page.request.get('/api/statement.txt?id=' + issued.id)).text();
  expect(print1).toMatch(/HIRE STATEMENT ST-000001/);
  await cmd('hireRate', { product: product.id, day: 200, from: addDays(today, 1) });
  // the Reprint link on the locked row is the stored bytes (a file the browser saves): fetched again, identical
  await expect(st.locator('.lb-st').first().getByRole('link', { name: 'Reprint', exact: true })).toHaveAttribute(
    'href',
    '/api/statement.txt?id=' + issued.id,
  );
  const print2 = await (await page.request.get('/api/statement.txt?id=' + issued.id)).text();
  expect(print2).toBe(print1);
  // the statement is on Today's business card as nothing unbilled
  expect((await api('today')).business.money.toInvoiceWords).toBe('Nothing unbilled');

  // ---- go-live: a second customer and its on-hire list through the screens; a wrong row is refused in words
  const gl = page.locator('#lb-golive');
  await gl.scrollIntoViewIfNeeded();
  await gl.locator('[data-lb-text]').fill('Name\tTerms\nHarbour Homes\t30');
  await gl.getByRole('button', { name: 'Check the rows', exact: true }).click();
  await expect(gl.locator('.lb-check')).toContainText('Harbour Homes', { timeout: 30000 });
  await gl.getByRole('button', { name: 'Bring them in', exact: true }).click();
  await expect(gl.locator('.lb-done')).toContainText('1 record brought in from the customers list', { timeout: 30000 });
  await gl.locator('[data-lb-kind="sites"]').click();
  await gl.locator('[data-lb-text]').fill('Site\tCustomer\tPO\nManly\tHarbour Homes\tHH-1');
  await gl.getByRole('button', { name: 'Check the rows', exact: true }).click();
  await expect(gl.locator('.lb-check.ok')).toBeVisible({ timeout: 30000 });
  await gl.getByRole('button', { name: 'Bring them in', exact: true }).click();
  await expect(gl.locator('.lb-done')).toContainText('sites list', { timeout: 30000 });
  await gl.locator('[data-lb-kind="onHire"]').click();
  await gl.locator('[data-lb-text]').fill('Site\tPart\tQty\tSince\nManly\t' + product.name + '\t8\tlast month');
  await gl.getByRole('button', { name: 'Check the rows', exact: true }).click();
  await expect(gl.locator('.lb-check.bad')).toContainText('not understood', { timeout: 30000 });
  await expect(gl.getByRole('button', { name: 'Bring them in', exact: true })).toBeDisabled();
  const since = addDays(today, -20);
  await gl.locator('[data-lb-text]').fill('Site\tPart\tQty\tSince\nManly\t' + product.name + '\t8\t' + since);
  await gl.getByRole('button', { name: 'Check the rows', exact: true }).click();
  await expect(gl.locator('.lb-check.ok')).toBeVisible({ timeout: 30000 });
  await gl.getByRole('button', { name: 'Bring them in', exact: true }).click();
  await expect(gl.locator('.lb-done')).toContainText('onHire list', { timeout: 30000 });
  const hh = (await api('customers')).customers.find((c) => c.name === 'Harbour Homes');
  await st.locator('[data-lb-cust]').selectOption(hh.id);
  await expect(st).toContainText('Manly', { timeout: 30000 });
  await expect(st).toContainText('$168.00'); // 8 pieces × 21 days at $1.00 (the new rate starts tomorrow)
  await st.getByRole('button', { name: 'Issue statement', exact: true }).click();
  await expect(st).toContainText('ST-000002 issued', { timeout: 30000 });
  const second = (await api('statements')).statements.find((s) => s.number === 'ST-000002');
  expect(second.from).toBe(since);
  expect(second.subtotal).toBe(21 * 8 * 100);
  expect(errors).toEqual([]);
});
