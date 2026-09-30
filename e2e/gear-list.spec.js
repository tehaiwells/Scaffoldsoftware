import { test, expect } from '@playwright/test';
// A gear list in a real yard (ADR 0012), on the pages people use: on Daily activities the office confirms "Bondi gear" yard -> Bondi with the
// parts, a date and time, T-01 and Dave in one tap; the chip is on the calendar with its time; the card shows the five empty dots; Dave's
// phone (375 px) gets the day-before ask when there is time for one, then taps Arrived at yard; the yard packs; Dave taps Loaded & left,
// Arrived at Bondi and Delivered with a name; the dots fill one by one and the Dispatch lanes show the arrival dots.
const key = () => 'e2e-' + Date.now() + '-' + Math.random().toString(36).slice(2);
test('a gear list yard -> site: one tap books it all; the driver taps each step on his phone; the dots fill', async ({
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
  const phones = [],
    errors = [];
  page.on('pageerror', (e) => errors.push('office: ' + e.message));
  // a real yard: a part, stock, Bondi, T-01, Dave (driver) and Kev (yard hand), set up through the API
  expect(
    (
      await page.request.post('/api/register', {
        data: {
          companyName: 'Tee Scaffolding',
          name: 'Tee',
          email: `gear-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
          password: 'Local-demo-test-2026!',
          systems: ['quickstage'],
          mode: 'LIVE',
        },
      })
    ).status(),
  ).toBe(200);
  const { yard } = await cmd('gameStart', { size: 'S' });
  await cmd('gameCatalogue', {});
  const part = (await api('state')).products.find((p) => p.unitWeight > 0 && !p.retired && p.packQuantity == null);
  await cmd('gameAddStock', { lines: [{ product: part.id, quantity: 60 }] });
  const site = (await cmd('gameSite', { name: 'Bondi', address: '1 Campbell Parade, Bondi' })).site;
  await cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: yard.id, payload: 12500000 });
  const dave = (await cmd('teamAdd', { name: 'Dave', role: 'DRIVER', mobile: '0412 345 678' })).person;
  const kev = (await cmd('teamAdd', { name: 'Kev', role: 'YARDSMAN' })).person;
  // the day: today while it is not nearly over (company time, from the server), else tomorrow
  const trips = await api('trips');
  const day = trips.dayOver || trips.now >= '16:00' ? nextDay(trips.today) : trips.today;

  // ---- Daily activities: + Gear list
  await page.goto('/?view=TODAY');
  await expect(page.getByRole('heading', { level: 1, name: 'Daily activities', exact: true })).toBeVisible({
    timeout: 45000,
  });
  const cell = page.locator(`.tdh-cell[data-tdh-day="${day}"]`);
  if (!(await cell.count())) await page.getByRole('button', { name: 'Next month' }).click();
  await cell.click();
  await page.getByRole('button', { name: /^\+ Gear list/ }).click();
  const form = page.locator('[data-tdh-form="GEAR"]');
  await expect(form).toBeVisible();
  await expect(form.locator('[data-gl-place="from:yard"]')).toHaveAttribute('aria-pressed', 'true'); // from the yard
  await expect(form.locator('select[name=toSite]')).toContainText('Bondi'); // to Bondi
  await expect(form.locator('input[name=name]')).toHaveAttribute('placeholder', 'Bondi gear');
  await form.locator('[data-tdh-pick]').click();
  await page.locator(`.tdh-layer [data-pp-slot="${part.id}"]`).click();
  await page.locator('.tdh-layer [data-pp-num]').fill('12');
  await page.locator('.tdh-layer [data-pp-num]').press('Enter');
  await page.locator('.tdh-layer [data-pp-done]').click();
  await expect(page.locator('.tdh-layer')).toHaveCount(0);
  await expect(form.locator('select[name=truck]')).toContainText('T-01');
  await form.locator('select[name=driver]').selectOption({ label: 'Dave' });
  await expect(form.locator('.tdh-go')).toContainText('Confirm Bondi gear');
  await form.locator('.tdh-go').click();
  // the chip on the calendar with its time; the card: from -> to, the truck and driver, five empty dots, the exact order
  await expect(cell.locator('.tdh-chip.tone-mat')).toContainText('Bondi gear', { timeout: 20000 });
  await expect(cell.locator('.tdh-chip.tone-mat')).toContainText(/\d+:\d\d [ap]m/);
  const card = page.locator('.tdh-item.tone-mat');
  await expect(card).toContainText('the yard → Bondi');
  await expect(card).toContainText('O-1');
  await expect(card.locator('.gl-truck')).toContainText('T-01');
  await expect(card.locator('.gl-truck')).toContainText('Dave');
  await expect(card.locator('.gl-step')).toHaveCount(5);
  await expect(card.locator('.gl-step.done')).toHaveCount(0);
  await expect(card.locator('.gl-step').nth(4)).toContainText('Landed');
  const plan = await api('plan?month=' + day.slice(0, 7));
  const item = plan.items.find((i) => i.gear && i.day === day);
  expect(item.name).toBe('Bondi gear');
  expect(item.truckItem.driverName).toBe('Dave');
  const trip = (await api('trips?day=' + day)).trips.find((t) => t.label === 'Trip 1');
  expect(trip.state).toBe('BOOKED');

  // ---- Dave's phone: the day-before ask when there is time for one; then Arrived at yard
  const phoneOf = async (person) => {
    const made = await api('crew-links', { person: person.id });
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    phones.push(ctx);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(person.name + ': ' + e.message));
    await p.goto(new URL(new URL(made.link).pathname + new URL(made.link).hash, baseURL).href);
    return p;
  };
  const dPhone = await phoneOf(dave);
  await expect(dPhone.getByRole('heading', { name: 'My trips, Dave' })).toBeVisible({ timeout: 30000 });
  // the driver's one ask: the list's READY when it is for tomorrow and past 3 pm, else (a list for today) the booking's own
  await dPhone.getByRole('button', { name: 'I’ll be there', exact: true }).first().click();
  const ready = dPhone.locator('.cr-askcard', { hasText: 'Ready for tomorrow?' });
  if (await ready.count()) await expect(ready).toContainText('You said yes, see you there', { timeout: 20000 });
  await expect(dPhone.getByRole('button', { name: 'I’ll be there', exact: true })).toHaveCount(0, { timeout: 20000 });
  const tripCard = dPhone.locator('.cr-card:not(.cr-askcard)').first();
  await expect(tripCard).toContainText('To Bondi');
  await tripCard.getByRole('button', { name: 'Arrived at yard', exact: true }).click();
  await expect(tripCard.locator('.cr-steps')).toContainText(/Arrived at yard \d\d:\d\d/, { timeout: 20000 });
  await expect
    .poll(async () => (await api('trips?day=' + day)).trips.find((t) => t.id === trip.id).steps?.ARRIVED_PICKUP?.kind, {
      timeout: 20000,
    })
    .toBe('PERSON');
  // the office: the first dot filled, the lanes show At yard
  await page.reload();
  await cell.click();
  await expect(card.locator('.gl-step.done')).toHaveCount(1, { timeout: 30000 });
  await expect(card.locator('.gl-step.done')).toContainText('Arrived at yard');
  await page.locator('[data-lt-mode="lanes"]').click();
  const lane = page.locator('.lt-lane').first();
  await expect(lane.locator('.lt-trip .lt-dot.dot-arrived')).toHaveCount(1, { timeout: 30000 });
  await expect(lane.locator('.lt-trip')).toContainText('At yard');
  await page.locator('[data-lt-mode="day"]').click();

  // ---- the yard packs (Kev's phone), Dave taps Loaded & left, Arrived at Bondi, Delivered with a name
  const kPhone = await phoneOf(kev);
  await expect(kPhone.getByRole('heading', { name: 'My day, Kev' })).toBeVisible({ timeout: 30000 });
  await kPhone.getByRole('button', { name: 'Packed', exact: true }).click();
  await kPhone.locator('[data-cr-pack-form] button[type=submit]').click();
  await expect(kPhone.locator('.cr-state')).toContainText('Packed', { timeout: 20000 });
  await expect
    .poll(async () => (await api('trips?day=' + day)).trips.find((t) => t.id === trip.id).state, { timeout: 20000 })
    .toBe('PACKED');
  await dPhone.reload();
  await expect(dPhone.getByRole('heading', { name: 'My trips, Dave' })).toBeVisible({ timeout: 30000 });
  await dPhone.getByRole('button', { name: 'Loaded & left', exact: true }).click();
  await expect(dPhone.locator('input[data-cr-q]')).toHaveValue('12');
  await dPhone.locator('.cr-confirm button[type=submit]').click();
  await expect(dPhone.locator('.cr-steps')).toContainText(/Loaded & left \d\d:\d\d/, { timeout: 20000 });
  await expect(dPhone.getByRole('button', { name: 'Arrived at Bondi', exact: true })).toBeVisible({ timeout: 20000 });
  await dPhone.getByRole('button', { name: 'Arrived at Bondi', exact: true }).click();
  await expect(dPhone.locator('.cr-steps')).toContainText(/Arrived at Bondi \d\d:\d\d/, { timeout: 20000 });
  await expect
    .poll(async () => (await api('trips?day=' + day)).trips.find((t) => t.id === trip.id).steps?.ARRIVED_DROP?.kind, {
      timeout: 20000,
    })
    .toBe('PERSON');
  // the lanes: At site, between Loaded and Delivered
  await page.reload();
  await cell.click();
  await page.locator('[data-lt-mode="lanes"]').click();
  await expect(page.locator('.lt-lane').first().locator('.lt-trip .lt-dot.dot-atsite')).toHaveCount(1, {
    timeout: 30000,
  });
  await page.locator('[data-lt-mode="day"]').click();
  await dPhone.getByRole('button', { name: 'Delivered', exact: true }).click();
  await dPhone.locator('input[name=receivedBy]').fill('J. Smith');
  await dPhone.locator('.cr-confirm button[type=submit]').click();
  await expect(dPhone.locator('.cr-one')).toContainText(/Delivered \d\d:\d\d · J\. Smith/, { timeout: 20000 });
  // the card: all five dots filled, the list done; the arrivals are on record as the driver's own taps
  await page.reload();
  await cell.click();
  await expect(card.locator('.gl-step.done')).toHaveCount(5, { timeout: 30000 });
  await expect(card).toContainText('Done');
  const done = (await api('trips?day=' + day)).trips.find((t) => t.id === trip.id);
  expect(done.state).toBe('DELIVERED');
  expect(done.chain.map((c) => c.done)).toEqual([true, true, true, true, true]);
  expect(done.chain[0].kind).toBe('PERSON');
  expect(done.chain[3].kind).toBe('PERSON');
  expect(errors).toEqual([]);
  for (const c of phones) await c.close();
});
// The parts picker of a site -> site list counts the site the gear comes from, never the yard's stock: the corner numbers are what is at
// Bondi now, and the words say so.
test('the picker for a site -> site list counts the first site', async ({ page }) => {
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
          email: `gear-move-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
          password: 'Local-demo-test-2026!',
          systems: ['quickstage'],
          mode: 'LIVE',
        },
      })
    ).status(),
  ).toBe(200);
  const { yard } = await cmd('gameStart', { size: 'S' });
  await cmd('gameCatalogue', {});
  const part = (await api('state')).products.find((p) => p.unitWeight > 0 && !p.retired && p.packQuantity == null);
  await cmd('gameAddStock', { lines: [{ product: part.id, quantity: 60 }] });
  await cmd('gameSite', { name: 'Bondi', address: '1 Campbell Parade, Bondi' });
  await cmd('gameSite', { name: 'Manly', address: '2 The Corso, Manly' });
  await cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: yard.id, payload: 12500000 });
  const trips = await api('trips');
  const day = nextDay(nextDay(trips.today));
  await page.goto('/?view=TODAY');
  await expect(page.getByRole('heading', { level: 1, name: 'Daily activities', exact: true })).toBeVisible({
    timeout: 45000,
  });
  const cell = page.locator(`.tdh-cell[data-tdh-day="${day}"]`);
  if (!(await cell.count())) await page.getByRole('button', { name: 'Next month' }).click();
  await cell.click();
  await page.getByRole('button', { name: /^\+ Gear list/ }).click();
  const form = page.locator('[data-tdh-form="GEAR"]');
  await expect(form).toBeVisible();
  await form.locator('[data-gl-place="from:site"]').click();
  await form.locator('select[name=fromSite]').selectOption({ label: 'Bondi' });
  await form.locator('[data-gl-place="to:site"]').click();
  await form.locator('select[name=toSite]').selectOption({ label: 'Manly' });
  await expect(form.locator('input[name=name]')).toHaveAttribute('placeholder', 'Manly gear');
  await form.locator('[data-tdh-pick]').click();
  const layer = page.locator('.tdh-layer');
  await expect(layer).toContainText('free at Bondi now');
  await expect(layer).not.toContainText('in the yard now');
  await layer.locator(`[data-pp-slot="${part.id}"]`).click();
  await expect(layer.locator('[data-pp-words]')).toContainText('0 free at Bondi now'); // nothing is at Bondi yet
});
function nextDay(day) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
