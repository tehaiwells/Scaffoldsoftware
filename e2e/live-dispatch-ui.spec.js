import { test, expect } from '@playwright/test';
// Phase 1A part 3 (ADR 0010) on the pages people use: the office books a day on Today (a truck with Dave, a list on it, Lee and Jo to
// Bondi); Dave says yes on his phone, Kev packs on hers with the counts, Jo can't make it and Lee can, each on their own phone; the
// Dispatch lanes show the dots; a bring-back comes back short, is counted and every missing piece gets an outcome on the trip card;
// the site's one finish question; Needs you shows on the board and on Today, and clears when a thing is put aside with a reason.
const key = () => 'e2e-' + Date.now() + '-' + Math.random().toString(36).slice(2);
test('Today as a dispatch tool: the phones answer and pack, the lanes follow, a short return is sorted, Needs you shows and clears', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300000);
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
          email: `dispatch-ui-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
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
  const part = products.find((p) => p.packQuantity == null) ?? products[0];
  await cmd('gameAddStock', { lines: [{ product: part.id, quantity: 600 }], unitCost: 3500, supplier: 'Acme' });
  const site = (await cmd('gameSite', { name: 'Bondi', address: '1 Campbell Parade, Bondi' })).site;
  await cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: yard.id, payload: 12500000 });
  const dave = (await cmd('teamAdd', { name: 'Dave', role: 'DRIVER', mobile: '0412 345 678' })).person;
  const kev = (await cmd('teamAdd', { name: 'Kev', role: 'YARDSMAN' })).person;
  const lee = (await cmd('teamAdd', { name: 'Lee', role: 'LEADING_HAND' })).person;
  const jo = (await cmd('teamAdd', { name: 'Jo', role: 'SCAFFOLDER' })).person;
  // the day to book: today while it is open, else tomorrow (either way everyone is asked at once)
  const plan = await api('plan');
  const nowHm = new Date(plan.now).toLocaleTimeString('en-AU', { hour12: false, timeZone: plan.timeZone }).slice(0, 5);
  const day = nowHm < '16:00' ? plan.today : plan.tomorrow;
  // one phone each: its own browser context, so each sign-in is that person's alone
  const phones = [];
  const errors = [];
  const phoneOf = async (person) => {
    const made = await api('crew-links', { person: person.id });
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    phones.push(ctx);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(person.name + ': ' + e.message));
    await p.goto(new URL(new URL(made.link).pathname + new URL(made.link).hash, baseURL).href);
    return p;
  };

  // ---- the office books the day on Today
  await page.goto('/?view=TODAY');
  await expect(page.getByRole('heading', { level: 1, name: 'Daily activities', exact: true })).toBeVisible({
    timeout: 45000,
  });
  await expect(page.locator('#lt-needs')).toBeVisible({ timeout: 30000 }); // the Needs-you card is there, quiet
  await expect(page.locator('#lt-needs')).toContainText('Nothing needs you');
  const cell = page.locator(`.tdh-cell[data-tdh-day="${day}"]`);
  await cell.click();
  await page.getByRole('button', { name: /^\+ Truck/ }).click();
  const tform = page.locator('[data-tdh-form="TRUCK"]');
  await tform.locator('select[name=driver]').selectOption({ label: 'Dave' });
  await expect(tform.locator('.tdh-draft')).toBeVisible(); // Just a draft for now: offered, not ticked
  await tform.locator('.tdh-go').click();
  const truck = page.locator('.tdh-item.tone-truck');
  await expect(truck).toContainText('Waiting for Dave to answer', { timeout: 20000 });
  await page.getByRole('button', { name: /^\+ Materials/ }).click();
  await page.locator('[data-tdh-pick]').click();
  await page.locator(`.tdh-layer [data-pp-slot="${part.id}"]`).click();
  // a real yard's picker keeps the number typed (exact pieces): 24, not a whole stillage
  await page.locator('.tdh-layer [data-pp-num]').fill('24');
  await page.locator('.tdh-layer [data-pp-num]').press('Enter');
  await expect(page.locator('.tdh-layer [data-pp-words]')).toContainText('24 pieces');
  await page.locator('.tdh-layer [data-pp-done]').click();
  await expect(page.locator('.tdh-layer')).toHaveCount(0);
  await expect(page.locator('[data-tdh-form="MATERIALS"] select[name=truckPlan]')).toContainText('Dave');
  await page.locator('[data-tdh-form="MATERIALS"] .tdh-go').click();
  await expect(page.locator('.tdh-item.tone-mat')).toContainText('O-1', { timeout: 20000 }); // its exact order, held
  await page.getByRole('button', { name: /^\+ Workers/ }).click();
  const wform = page.locator('[data-tdh-form="WORKERS"]');
  await wform.locator('select[name=who]').selectOption('PICK');
  await wform.locator('h3').click(); // focus leaves the select: the page draws the people to pick
  await expect(wform.locator('.tdh-who')).toBeVisible({ timeout: 20000 });
  await wform.locator(`[data-tdh-person="${lee.id}"]`).check();
  await wform.locator(`[data-tdh-person="${jo.id}"]`).check();
  await wform.locator('.tdh-go').click();
  const crew = page.locator('.tdh-item.tone-crew');
  await expect(crew).toContainText('0 of 2 said yes', { timeout: 20000 });
  const trips = await api('trips?day=' + day);
  const trip = trips.trips.find((t) => t.label === 'Trip 1');
  expect(trip.state).toBe('BOOKED');
  const asked = trip.lines[0].asked; // what the picker put on the list (exactly 24): all of it is delivered below
  expect(asked).toBe(24);

  // ---- the phones: Dave says yes, Jo can't make it (Crook), Lee can, Kev packs with the counts
  const dPhone = await phoneOf(dave);
  await expect(dPhone.getByRole('heading', { name: 'My trips, Dave' })).toBeVisible({ timeout: 30000 });
  await dPhone.getByRole('button', { name: 'I’ll be there', exact: true }).click();
  await expect(dPhone.locator('.cr-askcard')).toContainText('You said yes, see you there', { timeout: 20000 });
  const jPhone = await phoneOf(jo);
  await expect(jPhone.getByRole('heading', { name: 'My day, Jo' })).toBeVisible({ timeout: 30000 });
  await jPhone.getByRole('button', { name: 'Can’t make it', exact: true }).click();
  await jPhone.locator('[data-cr-reason="Crook"]').click();
  await jPhone.locator('[data-cr-ask-form] button[type=submit]').click();
  await expect(jPhone.locator('.cr-askcard')).toContainText("You said you can't make it", { timeout: 20000 });
  const lPhone = await phoneOf(lee);
  await expect(lPhone.getByRole('heading', { name: 'My day, Lee' })).toBeVisible({ timeout: 30000 });
  await lPhone.getByRole('button', { name: 'I’ll be there', exact: true }).click();
  await expect(lPhone.locator('.cr-askcard')).toContainText('You said yes, see you there', { timeout: 20000 });
  const kPhone = await phoneOf(kev);
  await expect(kPhone.getByRole('heading', { name: 'My day, Kev' })).toBeVisible({ timeout: 30000 });
  await expect(kPhone.locator('.cr-card')).toContainText('Trip 1 for Bondi');
  await kPhone.getByRole('button', { name: 'Packed', exact: true }).click();
  await expect(kPhone.locator('input[data-cr-q]')).toHaveValue(String(trip.lines[0].asked));
  await kPhone.locator('[data-cr-pack-form] button[type=submit]').click();
  await expect(kPhone.locator('.cr-state')).toContainText('Packed', { timeout: 20000 });
  await expect
    .poll(async () => (await api('trips?day=' + day)).trips.find((t) => t.id === trip.id).state, { timeout: 20000 })
    .toBe('PACKED');
  expect(errors).toEqual([]);

  // ---- Today follows the phones: the person's own yes, the reason, the packed list; the lanes and their dots
  await page.goto('/?view=TODAY');
  await cell.click();
  await expect(page.locator('.tdh-item.tone-truck')).toContainText('Said yes on their phone', { timeout: 30000 });
  await expect(page.locator('.tdh-item.tone-crew')).toContainText('Can’t make it: Crook');
  await expect(page.locator('.tdh-item.tone-crew')).toContainText('1 of 2 said yes');
  await expect(page.locator('.lo-trip').first()).toContainText('Packed', { timeout: 30000 });
  await expect(page.locator('.lo-trip').first().locator('.lo-docket')).toContainText('packed'); // the yard's count, on the docket
  await expect(page.locator('.tdh-item.tone-mat')).toContainText('Packed by Kev');
  await page.locator('[data-lt-mode="lanes"]').click();
  const lane = page.locator('.lt-lane').first();
  await expect(lane).toBeVisible({ timeout: 30000 });
  await expect(lane).toContainText('T-01');
  await expect(lane).toContainText('Said yes');
  await expect(lane.locator('.lt-trip .lt-dot.dot-packed')).toHaveCount(1);
  await expect(page.locator('.lt-people-grid')).toContainText('1 of 2 said yes');
  await expect(page.locator('.lt-people-grid')).toContainText('Packed, waiting for the truck');
  await page.locator('[data-lt-mode="day"]').click();
  await expect(page.locator('#tdh-day')).toBeVisible();

  // ---- the driver delivers and comes back; a bring-back comes back 2 short: counted, then sorted on the trip card
  const tap = async (p, action, data) => {
    const r = await p.request.post('/api/crew/commands/' + action, { data, headers: { 'Idempotency-Key': key() } });
    expect(r.ok(), action + ': ' + (await r.text())).toBe(true);
    return r.json();
  };
  await tap(dPhone, 'tripLoaded', { trip: trip.id });
  await tap(dPhone, 'tripDelivered', { trip: trip.id, receivedBy: 'J. Smith' });
  await tap(dPhone, 'tripReturned', { trip: trip.id });
  const back = (await cmd('bringBackCreate', { site: site.id, lines: [{ product: part.id, quantity: 12 }] })).order;
  const tb = (await api('plan?month=' + day.slice(0, 7))).items.find((i) => i.type === 'TRUCK' && i.day === day);
  const coll = (await cmd('tripBook', { orders: [back.id], truckPlan: tb.id })).trip;
  await tap(dPhone, 'tripCollected', { trip: coll.id });
  await tap(dPhone, 'tripReturned', { trip: coll.id, lines: [{ product: part.id, quantity: 10 }] });
  await page.goto('/?view=TODAY');
  await cell.click();
  const card = page.locator(`[data-lo-trip="${coll.id}"]`);
  await expect(card).toContainText('2 pieces not back', { timeout: 30000 });
  await card.locator('[data-lr-resolve]').click();
  const form = card.locator('[data-lr-resolve-form]');
  await expect(form).toBeVisible();
  await form.locator('[data-lr-f="quantity"]').first().fill('1');
  await form.locator('[data-lr-f="quantity"]').first().press('Tab');
  await form.locator('[data-lr-split]').click(); // the other piece, its own line (Lost by default)
  await expect(form.locator('.lr-line')).toHaveCount(2);
  await expect(form.locator('.lr-line').nth(1).locator('[data-lr-f="unitValue"]')).toHaveAttribute(
    'placeholder',
    'No replacement value set',
  ); // never charged silently: the value is typed
  await form.locator('.lr-line').nth(1).locator('[data-lr-f="unitValue"]').fill('42.50');
  await form.locator('.lr-line').nth(1).locator('[data-lr-f="reason"]').fill('Fell off');
  await form.locator('button[type=submit]').click();
  await expect(card).toContainText(/Sorted: 1 × .* still on site · 1 × .* lost · charged \$42\.50/, { timeout: 30000 });
  const account = await api('site-account?site=' + site.id);
  expect([account.sent, account.back, account.onSite, account.charged, account.unaccounted]).toEqual([
    asked,
    10,
    asked - 12 + 1,
    1,
    0,
  ]);
  expect(account.charges[0].amount).toBe(4250);

  // ---- the site's one question on Client sites: sent · back · missing, kept open as Still looking
  await page.goto('/');
  await page.getByRole('button', { name: 'Office', exact: true }).first().click();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Client sites' }).click();
  const finish = page.locator(`[data-lr-finish="${site.id}"]`);
  // an active site's card says what is on record; the question comes on "Finish this site…"
  await expect(finish).toContainText('on site (hire running)', { timeout: 30000 });
  await expect(finish).not.toContainText('missing');
  await finish.locator('[data-lr-finish-ask]').click();
  await expect(finish).toContainText('sent ' + asked + ' · back 10 · ' + (asked - 11) + ' missing', { timeout: 30000 });
  await finish.locator('[data-lr-finish-go="STILL_LOOKING"]').click();
  await finish.locator('[data-lr-finish-form] button[type=submit]').click();
  await expect(finish).toContainText('Still looking since', { timeout: 30000 });

  // ---- Needs you: on the board's chip and Today's card; put one aside with a reason and it goes
  let needs = await api('needs-you');
  expect(needs.items.map((i) => i.kind)).toContain('RETURN_SHORT');
  expect(needs.items.map((i) => i.kind)).toContain('UNPRICED_ON_HIRE');
  await page.goto('/');
  await expect(page.locator('.gm-needs')).toContainText('Needs you · ' + needs.count, { timeout: 45000 });
  await page.locator('.gm-needs').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Daily activities', exact: true })).toBeVisible({
    timeout: 45000,
  });
  const needCard = page.locator('#lt-needs');
  await expect(needCard).toContainText('Needs you · ' + needs.count, { timeout: 30000 });
  await expect(needCard.locator('.lt-need')).toHaveCount(needs.count);
  const first = needCard.locator('.lt-need').first();
  await first.locator('[data-lt-dismiss]').click();
  await first.locator('input[name=reason]').fill('Sorted on the phone');
  await first.locator('[data-lt-dismiss-form] button[type=submit]').click();
  await expect(needCard.locator('.lt-need')).toHaveCount(needs.count - 1, { timeout: 30000 });
  needs = await api('needs-you');
  expect(needs.dismissed).toBe(1);
  expect(errors).toEqual([]);
  for (const c of phones) await c.close();
});
