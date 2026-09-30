import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
// Phase 1A part 5 (owner brief 30 September 2026, the CREW half) on the pages people use, in a real yard: +1 worker on Workers (Kev, a yard
// worker with a phone and an email; Sam onsite at Bondi), Kev rostered three days by tapping the grid, the day-before ask on Kev's phone
// (Confirm turns the day green in the office), a gear list yard→Bondi with Kev and Sam on it (P1 each), both phones tapping Got the list,
// Packed and ready and Truck loaded, Task progress ticking live with "N of M done", the office ticking a plain task for Kev, and the
// Pre-start sheet printed with Kev, Sam and the lines. CI runs on UTC: the company's zone is picked so that its clock reads 3 pm now, which
// is when tomorrow's roster ask goes out at once and a list can still be booked for today.
const key = () => 'e2e-' + Date.now() + '-' + Math.random().toString(36).slice(2);
const shots = process.env.CREW_SHOTS ? process.env.CREW_SHOTS : null;
if (shots) mkdirSync(shots, { recursive: true });
const shot = async (page, name) => {
  if (!shots) return;
  await page.screenshot({ path: join(shots, name + '.png'), fullPage: true });
};
// A zone where the wall clock reads 15:xx right now (Etc/GMT zones count the other way: Etc/GMT-10 is UTC+10).
function zoneAt3pm() {
  const h = new Date().getUTCHours();
  let o = (15 - h + 24) % 24;
  if (o > 14) o -= 24;
  return o === 0 ? 'Etc/UTC' : o > 0 ? 'Etc/GMT-' + o : 'Etc/GMT+' + -o;
}
test('Workers: +1 worker and the roster; the day-before ask on the phone; a gear list task for two phones; Task progress ticks; Pre-start prints', async ({
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
  const zone = zoneAt3pm();
  expect(
    (
      await page.request.post('/api/register', {
        data: {
          companyName: 'Tee Scaffolding',
          name: 'Tee',
          email: `crew-ui-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
          password: 'Local-demo-test-2026!',
          systems: ['quickstage'],
          mode: 'LIVE',
          timeZone: zone,
        },
      })
    ).status(),
  ).toBe(200);
  const { yard } = await cmd('gameStart', { size: 'S' });
  await cmd('gameCatalogue', {});
  const products = (await api('state')).products.filter((p) => p.unitWeight > 0 && !p.retired);
  const part = products.find((p) => p.packQuantity == null) ?? products[0];
  await cmd('gameAddStock', { lines: [{ product: part.id, quantity: 600 }] });
  const site = (await cmd('gameSite', { name: 'Bondi', address: '1 Campbell Parade, Bondi' })).site;
  await cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: yard.id, payload: 12500000 });
  await cmd('teamAdd', { name: 'Dave', role: 'DRIVER' });
  const plan = await api('plan');
  expect(plan.timeZone).toBe(zone);
  const nowHm = new Date(plan.now).toLocaleTimeString('en-AU', { hour12: false, timeZone: zone }).slice(0, 5);
  expect(nowHm >= '15:00' && nowHm < '16:00', 'the company clock reads 3 pm: ' + nowHm + ' in ' + zone).toBe(true);
  const today = plan.today,
    tomorrow = plan.tomorrow,
    addDays = (d, n) => {
      const x = new Date(d + 'T12:00:00Z');
      x.setUTCDate(x.getUTCDate() + n);
      return x.toISOString().slice(0, 10);
    };
  const errors = [];
  page.on('pageerror', (e) => errors.push('office: ' + e.message));

  // ---- Workers: +1 worker (Kev, a yard worker with a phone and an email), then Sam (onsite at Bondi)
  await page.goto('/?view=WORKERS');
  await expect(page.locator('.office-bar .ob-title')).toHaveText('Workers', { timeout: 45000 });
  await expect(page.locator('#tm-team')).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: '+1 worker', exact: true }).click();
  const add = page.locator('[data-rs-add]');
  await add.locator('input[name=name]').fill('Kev');
  await add.locator('select[name=job]').selectOption('YARD');
  await add.locator('input[name=mobile]').fill('0412 000 111');
  await add.locator('input[name=email]').fill('kev@example.test');
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Kev is in your team as a yard worker.' })).toBeVisible({
    timeout: 20000,
  });
  const kevRow = page.locator('.tm-row').filter({ has: page.locator('input[data-tm-field=name][value="Kev"]') });
  await expect(kevRow).toBeVisible({ timeout: 20000 });
  // the roster opens under the new row; three days from tomorrow, tapped one by one
  const grid = page.locator('.rs-panel');
  await expect(grid).toBeVisible({ timeout: 20000 });
  const days = [tomorrow, addDays(tomorrow, 1), addDays(tomorrow, 2)];
  for (const d of days) {
    const cell = grid.locator(`[data-rs-day="${d}"]`);
    if (!(await cell.count())) await grid.locator('[data-rs-month]').last().click(); // the next month's grid
    await grid.locator(`[data-rs-day="${d}"]`).click();
    await expect(grid.locator(`[data-rs-day="${d}"]`)).toHaveClass(/st-rostered/, { timeout: 20000 });
  }
  await shot(page, 'workers-roster-1280');
  const kev = (await api('team')).people.find((p) => p.name === 'Kev');
  expect(kev.jobWords).toBe('Yard worker');
  expect(kev.email).toBe('kev@example.test');
  await page.getByRole('button', { name: '+1 worker', exact: true }).click();
  await add.locator('input[name=name]').fill('Sam');
  await add.locator('select[name=job]').selectOption('ONSITE');
  await add.locator('select[name=where]').selectOption({ label: 'Bondi' });
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Sam is in your team as an onsite worker at Bondi.' }),
  ).toBeVisible({
    timeout: 20000,
  });
  const sam = (await api('team')).people.find((p) => p.name === 'Sam');
  // the day-before ask went out at once (it is after 3 pm): one ROSTER message to Kev about tomorrow
  const kevRoster = await api('roster?person=' + kev.id + '&from=' + today + '&to=' + addDays(today, 14));
  expect(kevRoster.days.filter((d) => d.status === 'ROSTERED').map((d) => d.day)).toEqual(days);
  expect(kevRoster.days.find((d) => d.day === tomorrow).answer).toBe('WAITING');

  // ---- Kev's phone: Confirm tomorrow; the office's grid turns the day green by itself
  const phones = [];
  const phoneOf = async (person) => {
    const made = await api('crew-links', { person: person.id });
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    phones.push(ctx);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(person.name + ': ' + e.message));
    await p.goto(new URL(new URL(made.link).pathname + new URL(made.link).hash, baseURL).href);
    return p;
  };
  const kPhone = await phoneOf(kev);
  await expect(kPhone.getByRole('heading', { name: 'My day, Kev' })).toBeVisible({ timeout: 30000 });
  await expect(kPhone.locator('.cr-askcard')).toContainText('You’re on tomorrow');
  await shot(kPhone, 'phone-roster-ask-375');
  await kPhone.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(kPhone.locator('.cr-askcard')).toContainText('Confirmed', { timeout: 20000 });
  await page
    .getByRole('button', { name: /^Roster/ })
    .first()
    .click(); // Kev's row (the first worker row)
  await expect(page.locator(`.rs-panel [data-rs-day="${tomorrow}"]`)).toHaveClass(/st-confirmed/, { timeout: 30000 });
  await expect
    .poll(async () => (await api('roster?person=' + kev.id + '&from=' + tomorrow + '&to=' + tomorrow)).days[0].status)
    .toBe('CONFIRMED');

  // ---- a gear list yard→Bondi today with Kev and Sam on it (P1 each): one command makes the list and their task (ADR 0011)
  const made = await cmd('gearListCreate', {
    from: { kind: 'yard' },
    to: { kind: 'site', id: site.id },
    day: today,
    time: '16:30',
    lines: [{ product: part.id, quantity: 24 }],
    workers: [
      { person: kev.id, priority: 1 },
      { person: sam.id, priority: 1 },
    ],
  });
  const list = made.item,
    task = made.task;
  expect(list.name).toBe('Bondi gear');
  expect(made.message).toContain('Kev and Sam are on it.');
  expect(task.name).toBe('Bondi gear');
  expect(task.workers.map((w) => w.name + ' P' + w.priority)).toEqual(['Kev P1', 'Sam P1']);

  // ---- Task progress: the two workers, empty boxes, 0 of 1 done (it polls every second)
  await page.goto('/?view=PROGRESS');
  await expect(page.locator('.office-bar .ob-title')).toHaveText('Task progress', { timeout: 45000 });
  await expect(page.locator('.tp-summary')).toContainText('0 of 1 done', { timeout: 30000 });
  const kevPanel = page
      .locator('.tp-worker')
      .filter({ has: page.getByRole('heading', { level: 2, name: 'Kev', exact: true }) }),
    samPanel = page
      .locator('.tp-worker')
      .filter({ has: page.getByRole('heading', { level: 2, name: 'Sam', exact: true }) });
  await expect(kevPanel).toContainText('P1 Bondi gear');
  await expect(kevPanel.locator('.tp-box.on')).toHaveCount(0);

  // ---- the phones: Kev Got the list, Packed and ready; Sam Got the list, Truck loaded
  await kPhone.getByRole('button', { name: 'Check for new asks', exact: true }).click();
  await expect(kPhone.locator('.cr-task.is-now')).toContainText('P1 · Bondi gear', { timeout: 30000 });
  await expect(kPhone.locator('.cr-task.is-now')).toContainText('24');
  await shot(kPhone, 'phone-task-now-375');
  await kPhone.getByRole('button', { name: 'Got the list', exact: true }).click();
  await expect(kPhone.locator('.cr-task.is-now .cr-task-steps')).toContainText('Got the list', { timeout: 20000 });
  await expect(kevPanel.locator('.tp-box.on')).toHaveCount(1, { timeout: 20000 }); // the office sees the tick
  await kPhone.getByRole('button', { name: 'Packed and ready', exact: true }).click();
  await expect(kPhone.locator('.cr-task.is-now .cr-task-steps .cr-done')).toHaveCount(2, { timeout: 20000 });
  await expect(kevPanel.locator('.tp-box.on')).toHaveCount(2, { timeout: 20000 });
  const sPhone = await phoneOf(sam);
  await expect(sPhone.getByRole('heading', { name: 'My day, Sam' })).toBeVisible({ timeout: 30000 });
  await expect(sPhone.locator('.cr-task.is-now')).toContainText('P1 · Bondi gear');
  await sPhone.getByRole('button', { name: 'Got the list', exact: true }).click();
  await expect(sPhone.getByRole('button', { name: 'Truck loaded', exact: true })).toBeVisible({ timeout: 20000 });
  await sPhone.getByRole('button', { name: 'Truck loaded', exact: true }).click();
  await expect(sPhone.locator('.cr-task')).toContainText('Done', { timeout: 20000 });
  await expect(page.locator('.tp-summary')).toContainText('1 of 1 done', { timeout: 20000 });
  await expect(kevPanel.locator('.tp-task')).toHaveClass(/is-done/);
  await expect(samPanel.locator('.tp-box.on')).toHaveCount(3);
  const t2 = (await api('tasks?day=' + today)).workers.find((w) => w.name === 'Sam').tasks[0];
  expect(t2.status).toBe('DONE');
  expect(t2.steps.LOADED.kind).toBe('PERSON');
  expect(t2.workers.find((w) => w.name === 'Kev').steps.RECEIVED.kind).toBe('PERSON');

  // ---- the office: + Task (a plain job for Kev, P2), then ticks it for him ("phoned it in")
  await page.getByRole('button', { name: '+ Task', exact: true }).first().click();
  const form = page.locator('[data-tp-form]');
  await form.locator('input[name=name]').fill('Sweep the racks');
  await form.locator(`[data-tp-pri="${kev.id}"][data-n="2"]`).click();
  await form.getByRole('button', { name: 'Add the task', exact: true }).click();
  await expect(kevPanel).toContainText('P2 Sweep the racks', { timeout: 20000 });
  await expect(page.locator('.tp-summary')).toContainText('1 of 2 done');
  await kevPanel.locator('[data-tp-tick][data-step="DONE"]').click();
  await expect(page.locator('.tp-confirm')).toContainText('Kev phoned it in?');
  await page.locator('[data-tp-tick-go]').click();
  await expect(page.locator('.tp-summary')).toContainText('2 of 2 done', { timeout: 20000 });
  await shot(page, 'task-progress-1280');
  const plain = (await api('tasks?day=' + today)).workers
    .find((w) => w.name === 'Kev')
    .tasks.find((t) => t.kind === 'PLAIN');
  expect(plain.workers[0].steps.DONE.kind).toBe('ON_BEHALF');

  // ---- Pre-start: the day's sheet, printed (window.print stubbed)
  await page.goto('/?view=PRESTART');
  await expect(page.locator('.office-bar .ob-title')).toHaveText('Pre-start', { timeout: 45000 });
  await expect(page.locator('.ps-preview .ps-sheet')).toBeVisible({ timeout: 30000 });
  await page.evaluate(() => {
    window.__printed = 0;
    window.print = () => window.__printed++;
  });
  await page.getByRole('button', { name: 'Print', exact: true }).click();
  const sheet = page.locator('#pr-host .pr-sheet');
  await expect(sheet).toBeVisible({ timeout: 20000 });
  const text = await sheet.innerText();
  for (const w of [
    'Pre-start',
    'Kev',
    'Sam',
    'P1 Bondi gear',
    'P2 Sweep the racks',
    '24 × ' + part.name,
    'with Sam',
    'Signed',
  ])
    expect(text, w).toContain(w);
  await expect.poll(() => page.evaluate(() => window.__printed)).toBeGreaterThan(0);
  await shot(page, 'prestart-print-1280');
  await page.locator('[data-pr-close]').click();
  await shot(page, 'prestart-1280');
  await page.setViewportSize({ width: 375, height: 812 });
  await shot(page, 'prestart-375');
  await page.goto('/?view=PROGRESS');
  await expect(page.locator('.tp-summary')).toContainText('2 of 2 done', { timeout: 30000 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(0);
  await shot(page, 'task-progress-375');
  await page.goto('/?view=WORKERS');
  await expect(page.locator('#tm-team')).toBeVisible({ timeout: 30000 });
  await page
    .getByRole('button', { name: /^Roster/ })
    .first()
    .click();
  await expect(page.locator('.rs-panel')).toBeVisible({ timeout: 20000 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(0);
  await shot(page, 'workers-roster-375');
  expect(errors).toEqual([]);
  for (const c of phones) await c.close();
});
