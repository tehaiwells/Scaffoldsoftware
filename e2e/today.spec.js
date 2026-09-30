import { test, expect } from '@playwright/test';
import { firstYard, office } from './workflow.js';
// The Today page as the installed app opens it (/?view=TODAY): a month calendar and the day panel, no simulation controls, a phone width
// without sideways scrolling; then the owner books a truck, a materials list and workers on a coming day, and the driver says yes on his phone.
const register = async (page, name) => {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Company name', exact: true }).fill(name);
  await page.getByRole('textbox', { name: 'Your name', exact: true }).fill('Test Owner');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(`today-${Date.now()}@example.test`);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill('Local-demo-test-2026!');
  await page.getByRole('button', { name: 'Create company', exact: true }).click();
};
const api = (page, path, data) =>
  page.evaluate(
    async ([path, data]) => {
      const res = await fetch(
        '/api/' + path,
        data === undefined
          ? {}
          : {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
              body: JSON.stringify(data),
            },
      );
      const v = await res.json();
      if (!res.ok) throw new Error(v.error);
      return v;
    },
    [path, data],
  );

test('the installed app opens on Today: a month calendar, the day under it on a phone, no simulation controls', async ({
  page,
}) => {
  await register(page, 'Today DEMO');
  await firstYard(page);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await page.goto('/?view=TODAY');
  await expect(page.getByRole('heading', { level: 1, name: 'Daily activities', exact: true })).toBeVisible({
    timeout: 45000,
  });
  await expect(page).toHaveURL(/\/\?view=TODAY$/); // kept while Today is open, so 'Add to Home screen' from here opens on Today
  await expect(page.locator('.office-bar .ob-title')).toHaveText('Daily activities');
  await expect(page.locator('.gm-tile[data-view="TODAY"]')).toHaveClass(/current/);
  await expect(page.locator('.tdh-cell')).toHaveCount(42);
  await expect(page.locator('.tdh-cell.today')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Previous month' })).toBeVisible();
  await expect(page.getByText('Pause simulation')).toHaveCount(0);
  await expect(page.getByText('SIMULATION / DEMONSTRATION')).toHaveCount(0);
  for (const name of ['Sites today', 'Who’s in today', 'Yesterday & today', 'Paperwork', 'The business'])
    await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
  await page.setViewportSize({ width: 375, height: 800 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(0);
  await page.evaluate(() => scrollTo(0, 0));
  await page.locator('.tdh-cell.today').click();
  await expect(page.locator('#tdh-day')).toBeInViewport();
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('#tdh-day button,#tdh-day a.tdh-btn')]
      .filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44)
      .map((b) => b.textContent.trim()),
  );
  expect(small).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Back to the yard', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'What do you want to do?' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/); // another page: the address is clean again
});

test('a truck, a materials list and workers booked on a coming day; the driver says yes on his phone; a renamed worker shows on Today', async ({
  page,
}) => {
  test.setTimeout(180000);
  await register(page, 'Planner DEMO');
  await page.locator('[data-gm-size="S"]').click();
  await expect(page.getByRole('navigation', { name: 'What do you want to do?' })).toBeVisible({ timeout: 45000 });
  await api(page, 'commands/gameCatalogue', { systems: ['quickstage'] });
  const s = await api(page, 'state?page=0');
  const part = s.products.find((p) => p.system === 'quickstage' && p.unitWeight > 0 && /standard/i.test(p.name));
  await api(page, 'commands/gameAddStock', { lines: [{ product: part.id, quantity: 200 }] });
  await api(page, 'commands/gameSite', { name: 'Bondi' });
  for (const n of ['Kai', 'Ella']) await api(page, 'commands/teamAdd', { name: n, role: 'SCAFFOLDER' });
  // the demo answers by itself; switch that off in the Control room so the answers here are ours
  await office(page, 'Home').click();
  const sw = page.locator('#tdh-replies');
  await expect(sw).toContainText('On');
  await sw.click();
  await expect(sw).toContainText('Off');
  await page.goto('/?view=TODAY');
  await expect(page.getByRole('heading', { level: 1, name: 'Daily activities', exact: true })).toBeVisible({
    timeout: 45000,
  });
  const day = await page.evaluate(() => {
    const t = document.querySelector('.tdh-cell.today').dataset.tdhDay,
      [y, m] = t.split('-').map(Number),
      n = new Date(Date.UTC(y, m, 15));
    return n.toISOString().slice(0, 10);
  });
  await page.getByRole('button', { name: 'Next month' }).click();
  await page.locator(`.tdh-cell[data-tdh-day="${day}"]`).click();
  await expect(page.locator('#tdh-day h2')).toContainText('15');
  // the truck, with Dave (the page adds two demo drivers the first time)
  await page.getByRole('button', { name: /^\+ Truck/ }).click();
  const form = page.locator('[data-tdh-form="TRUCK"]');
  await expect(form.locator('select[name=driver] option', { hasText: 'Dave' })).toHaveCount(1, { timeout: 20000 });
  await form.locator('select[name=driver]').selectOption({ label: 'Dave' });
  await form.locator('.tdh-go').click();
  const cell = page.locator(`.tdh-cell[data-tdh-day="${day}"]`);
  await expect(cell.locator('.tdh-chip.tone-truck')).toContainText('Dave');
  await expect(cell.locator('.tdh-flag.amber')).toHaveCount(1);
  const truck = page.locator('.tdh-item.tone-truck');
  await expect(truck).toContainText('Waiting for Dave to answer');
  // Dave's own phone view: I'll be there
  await truck.locator('[data-cw-driver]').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dave' })).toBeVisible();
  await page.locator('[data-cw-yes]').click();
  await expect(page.locator('.cw-said.a-yes')).toBeVisible();
  await page.goto('/?view=TODAY');
  await page.locator(`.tdh-cell[data-tdh-day="${day}"]`).click(); // the chosen day is remembered in this tab
  await expect(page.locator('.tdh-item.tone-truck')).toContainText('Dave said yes');
  await expect(page.locator(`.tdh-cell[data-tdh-day="${day}"] .tdh-flag`)).toHaveCount(0);
  // the gear list (ADR 0011): picked in the parts window, from the yard to Bondi, on Dave's truck that day
  await page.getByRole('button', { name: /^\+ Gear list/ }).click();
  await page.locator('[data-tdh-pick]').click();
  await page.locator(`.tdh-layer [data-pp-slot="${part.id}"]`).click();
  await page.locator('.tdh-layer [data-pp-done]').click();
  await expect(page.locator('.tdh-layer')).toHaveCount(0);
  await expect(page.locator('[data-tdh-form="GEAR"] select[name=driver]')).toContainText('Dave');
  await page.locator('[data-tdh-form="GEAR"] .tdh-go').click();
  await expect(cell.locator('.tdh-chip.tone-mat')).toContainText('Bondi gear');
  await expect(page.locator('.tdh-item.tone-mat')).toContainText('the yard → Bondi');
  await expect(page.locator('.tdh-item.tone-mat .gl-step')).toHaveCount(5);
  // workers: two, to Bondi; each is asked the day before and must say yes
  await page.getByRole('button', { name: /^\+ Workers/ }).click();
  await page.locator('[data-tdh-form="WORKERS"] .tdh-go').click();
  await expect(page.locator('.tdh-item.tone-crew')).toContainText('Message goes the day before at 3 pm');
  await expect(cell.locator('.tdh-chip.tone-crew')).toContainText('→ Bondi');
  // the team: rename a yard hand in the Office, the name shows on Today
  await office(page, 'Workers').click();
  const name = page.locator('#tm-team [data-tm-field="name"]').first();
  await expect(name).toBeVisible({ timeout: 20000 });
  await name.fill('Jack');
  await name.press('Tab');
  await expect(page.locator('#message')).toContainText('is now Jack');
  await page.goto('/?view=TODAY');
  await expect(page.locator('#tdh-who')).toContainText('Jack');
});
