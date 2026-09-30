import { test, expect } from '@playwright/test';
// Phase 1A part 2 (ADR 0009), on the pages people use: the office sends an exact number from the board and books a truck and driver; the
// office makes the driver's phone link on Your team; the driver's phone (375 px) opens it and taps Loaded & left, then Delivered with a
// name; the board shows the truck at the site from those taps; the truck page's docket says asked, sent and delivered; hire starts on the
// delivered day.
const key = () => 'e2e-' + Date.now() + '-' + Math.random().toString(36).slice(2);
const bar = (page) => page.getByRole('navigation', { name: 'What do you want to do?' });
const office = async (page, tile) => {
  await page.getByRole('button', { name: 'Office', exact: true }).first().click();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: tile, exact: true })
    .click();
};
test('the board orders exact pieces, the phone confirms the trip, the board, the docket and hire follow', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240000);
  const api = async (path, data) => {
    const r = data
      ? await page.request.post('/api/' + path, { data, headers: { 'Idempotency-Key': key() } })
      : await page.request.get('/api/' + path);
    expect(r.ok(), path + ': ' + (await r.text())).toBe(true);
    return r.json();
  };
  const cmd = (a, d) => api('commands/' + a, d);
  // a real yard with a yard, two parts that come in packs, a site, a truck and a driver (set up through the API: the flow is the point)
  expect(
    (
      await page.request.post('/api/register', {
        data: {
          companyName: 'Tee Scaffolding',
          name: 'Tee',
          email: `trips-ui-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
          password: 'Local-demo-test-2026!',
          systems: ['quickstage'],
          mode: 'LIVE',
        },
      })
    ).status(),
  ).toBe(200);
  const { yard } = await cmd('gameStart', { size: 'S' });
  await cmd('gameCatalogue', {});
  const products = (await api('state')).products.filter((p) => p.unitWeight > 0 && !p.retired);
  const ledger = products.find((p) => /ledger/i.test(p.name)) ?? products[0];
  await cmd('override', {
    product: ledger.id,
    unitWeight: ledger.unitWeight,
    packQuantity: 25,
    reason: 'Supplier bundles',
  });
  await cmd('gameAddStock', { lines: [{ product: ledger.id, quantity: 100 }] });
  const site = (await cmd('gameSite', { name: 'Bondi', address: '1 Campbell Parade, Bondi' })).site;
  const truck = await cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: yard.id, payload: 12500000 });
  const dave = (await cmd('teamAdd', { name: 'Dave', role: 'DRIVER', mobile: '0412 345 678' })).person;

  // the board: Send, the site, the part, exactly 13 typed (packs of 25 are a hint, never a gate)
  await page.goto('/');
  await expect(bar(page)).toBeVisible({ timeout: 45000 });
  await bar(page).getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('radio', { name: 'Bondi' }).click();
  await page.locator(`[data-gm-slot="${ledger.id}"]`).click();
  const amount = page.getByRole('spinbutton', { name: /Amount of/ });
  await amount.fill('13');
  await expect(page.locator('[data-gm-words]')).toHaveText('13 pieces'); // the words follow the typing
  await amount.press('Tab');
  await expect(amount).toHaveValue('13');
  await expect(page.locator('.gm-pack-hint')).toContainText('Comes in packs of 25 · 13 is kept exactly');
  await page.getByRole('button', { name: 'Order for Bondi' }).click();
  // held exactly; a truck and a driver, a day and a time
  const book = page.locator('.gm-book');
  await expect(book).toContainText('O-1 for Bondi');
  await expect(book).toContainText('13 × ' + ledger.name + ' · held exactly');
  await book.locator('select[name="driver"]').selectOption(dave.id);
  await expect(book.locator('select[name="time"]')).toBeVisible();
  await book.getByRole('button', { name: 'Book the truck' }).click();
  await expect(
    page.locator('.gm-pop').filter({ hasText: /^Trip 1: T-01 with Dave to Bondi on .* at \d+:\d\d [ap]m\.$/ }),
  ).toBeVisible({
    timeout: 20000,
  });
  const order = (await api('trips')).orders.find((o) => o.label === 'O-1');
  expect(order.lines[0]).toMatchObject({ requested: 13, held: 13 });

  // the office makes Dave's phone link on Workers, Your team: Copy link, Text it, and how phones reach this computer
  await office(page, 'Workers');
  await page.locator(`[data-lo-link="${dave.id}"]`).click();
  const box = page.locator('.lo-link-box');
  await expect(box.getByRole('button', { name: 'Copy link' })).toBeVisible({ timeout: 20000 });
  await expect(box.getByRole('link', { name: 'Text it' })).toHaveAttribute('href', /^sms:\+61412345678\?&body=/);
  await expect(box.locator('.lo-reach')).toContainText(/Wi-Fi sharing|anywhere|Wi-Fi can open/);
  const link = await box.locator('.lo-link-url').inputValue();
  expect(link).toMatch(/\/crew#t=[0-9a-f]{64}$/);

  // Dave's phone: opens the link once (the link leaves the address bar), sees his trip, taps Loaded & left, then Delivered with a name
  const phoneCtx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const phone = await phoneCtx.newPage();
  const errors = [];
  phone.on('pageerror', (e) => errors.push(e.message));
  await phone.goto(new URL(new URL(link).pathname + new URL(link).hash, baseURL).href);
  await expect(phone.getByRole('heading', { name: 'My trips, Dave' })).toBeVisible({ timeout: 30000 });
  await expect.poll(() => phone.evaluate(() => location.hash)).toBe('');
  await expect(phone.locator('.cr-card')).toContainText('To Bondi');
  await phone.getByRole('button', { name: 'Loaded & left', exact: true }).click();
  await expect(phone.locator('input[data-cr-q]')).toHaveValue('13');
  await phone.locator('.cr-confirm button[type=submit]').click();
  await expect(phone.locator('.cr-done')).toContainText(/Loaded & left \d\d:\d\d/, { timeout: 20000 });
  await expect(phone.getByRole('button', { name: 'Came back, not delivered' })).toBeVisible();
  await phone.getByRole('button', { name: 'Delivered', exact: true }).click();
  await expect(phone.locator('input[name=receivedBy]')).toHaveValue(''); // never filled in for the driver
  await expect(phone.locator('input[name=receivedBy]')).toHaveAttribute('required', '');
  await phone.locator('input[name=receivedBy]').fill('J. Smith');
  await phone.locator('.cr-confirm button[type=submit]').click();
  await expect(phone.getByRole('heading', { name: 'Done' })).toBeVisible({ timeout: 20000 });
  await expect(phone.locator('.cr-one')).toContainText(/Delivered \d\d:\d\d · J\. Smith/);
  // no signal: the page itself still opens (a service worker keeps it), with the trips as last seen
  await phone.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await phone.reload();
  await expect(phone.getByRole('heading', { name: 'My trips, Dave' })).toBeVisible({ timeout: 30000 });
  await phoneCtx.setOffline(true);
  await phone.reload();
  await expect(phone.getByRole('heading', { name: 'My trips, Dave' })).toBeVisible({ timeout: 30000 });
  await expect(phone.locator('.cr-bar.off')).toContainText('No signal');
  await phoneCtx.setOffline(false);
  expect(errors).toEqual([]);

  // the board: T-01 at Bondi, from the driver's taps (nothing invented)
  await page.goto('/');
  await expect(bar(page)).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.gm-trip').filter({ hasText: 'T-01 at Bondi' })).toContainText(
    /Delivered \d\d:\d\d · received by J\. Smith/,
    { timeout: 30000 },
  );
  const board = (await api('state')).liveBoard;
  expect(board.trucks[0]).toMatchObject({ state: 'AT_SITE', place: site.id });
  expect(board.sites[site.id].pieces).toBe(13);

  // the truck page: the docket, asked against sent and delivered, and who confirmed each step
  await office(page, 'Big trucks');
  const card = page.locator('.lo-trip').filter({ hasText: 'Trip 1' });
  await expect(card).toContainText('Delivered', { timeout: 30000 });
  const row = card.locator('.lo-docket tbody tr').first();
  await expect(row.locator('td')).toHaveText(['13', '13', '13']);
  await expect(card.locator('.lo-steps')).toContainText('received by J. Smith');
  await expect(card.locator('.lo-steps')).toContainText('confirmed by Dave');

  // hire runs from the delivered day, by the driver's confirmed time
  const hire = await api('hire?site=' + site.id);
  expect(hire.statement.onHireNow).toBe(13);
  expect(hire.statement.pieceDays).toBe(13);
  const trip = (await api('trips')).trips.find((t) => t.label === 'Trip 1');
  expect(trip.steps.DELIVERED.kind).toBe('PERSON');
  expect(trip.truck).toBe(truck.id);
  await phoneCtx.close();
});
