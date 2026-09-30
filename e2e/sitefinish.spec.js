import { test, expect } from '@playwright/test';
import { office } from './workflow.js';
// Remove site: Undo a new site from its pop; Remove under a site tile (a practice site goes at once, with Undo); Remove site in the site window of a
// site with scaffold on it asks once, brings everything home by itself and the site goes; the Office removes a site and opens a removed one again.
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
const state = (page) => api(page, 'state?page=0');
async function signUp(page, name) {
  await page.getByRole('textbox', { name: 'Company name', exact: true }).fill(name);
  await page.getByRole('textbox', { name: 'Your name', exact: true }).fill('Test Owner');
  await page
    .getByRole('textbox', { name: 'Email', exact: true })
    .fill(`remove-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill('Local-demo-test-2026!');
  await page.getByRole('button', { name: 'Create company', exact: true }).click();
}
// Tap a site on the map (its ground), fitting the map first when it is off screen.
async function tapSite(page, id) {
  for (let i = 0; i < 6; i++) {
    const box = await page.evaluate((id) => {
      const g = document.querySelector('[data-wm-site="' + id + '"] .wm-site-ground');
      if (!g) return null;
      const r = g.getBoundingClientRect(),
        v = document.querySelector('.gm-board').getBoundingClientRect(),
        x = r.x + r.width / 2,
        y = r.y + r.height / 2;
      return x > v.left + 20 && x < v.right - 20 && y > v.top + 60 && y < v.bottom - 150 ? { x, y } : null;
    }, id);
    if (box) {
      await page.mouse.click(box.x, box.y);
      return;
    }
    await page.locator('[data-gm-cam="fit"]').click();
    await page.waitForTimeout(1200);
  }
  throw new Error('the site is not on the screen');
}
// A new site from the Send window (the first Send with no site names one by itself; otherwise + New site).
async function newSite(page, name) {
  const box = page.getByRole('textbox', { name: 'Site name' });
  if (
    !(await page
      .locator('[data-gm-newsite]')
      .isVisible()
      .catch(() => false))
  )
    await page
      .getByRole('navigation', { name: 'What do you want to do?' })
      .getByRole('button', { name: 'Send', exact: true })
      .click();
  if (!(await box.isVisible({ timeout: 1500 }).catch(() => false))) await page.locator('[data-gm-newsite]').click();
  await box.fill(name);
  await page.getByRole('button', { name: 'Open site', exact: true }).click();
  await expect(page.getByRole('radio', { name })).toHaveAttribute('aria-checked', 'true', { timeout: 20000 });
}
test('Remove site: undo a new site, remove a practice site from its tile and undo that, remove a site with scaffold on it, and the Office', async ({
  page,
}) => {
  test.setTimeout(300000);
  // nothing on these windows may break the content security policy (an inline style attribute would be dropped by the browser)
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      window.__csp.push(e.violatedDirective + ' at ' + e.sourceFile + ':' + e.lineNumber),
    );
  });
  await page.goto('/');
  await signUp(page, 'Remove DEMO');
  await expect(page.getByRole('heading', { level: 1, name: 'How big is your yard?' })).toBeVisible({ timeout: 45000 });
  await page.locator('[data-gm-size="S"]').click();
  const bar = page.getByRole('navigation', { name: 'What do you want to do?' });
  await expect(bar).toBeVisible({ timeout: 45000 });
  const yard = (await state(page)).yards[0];
  await api(page, 'commands/resources', { location: yard.id, workers: 4, machines: 2, stepMs: 120, speed: 20000 });
  await api(page, 'commands/gameCatalogue', { systems: ['quickstage'] });
  const std = (await state(page)).products.find((p) => p.name === 'Kwikstage standard 3.0 m'),
    Q = std.packQuantity > 0 ? std.packQuantity * 2 : 100;
  await api(page, 'commands/gameAddStock', { lines: [{ product: std.id, quantity: Q }] });
  await expect(page.locator('[data-gm-slot="' + std.id + '"]')).toBeVisible({ timeout: 20000 });
  // a new site: a calm pop with Undo; Undo takes it away again
  await newSite(page, 'Wrong St');
  const undo = page.locator('.sf-pop').filter({ hasText: 'Wrong St added' });
  await expect(undo).toBeVisible();
  await undo.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.gm-pop').filter({ hasText: 'Wrong St removed' })).toBeVisible({ timeout: 20000 });
  await expect.poll(async () => (await state(page)).sites.length).toBe(0);
  // a practice site: Remove right under its tile, next to + New site; it goes at once, and Undo brings it back
  await newSite(page, 'Practice');
  await page.getByRole('button', { name: 'Remove Practice' }).click();
  const gone = page.locator('.sf-pop').filter({ hasText: 'Practice removed' });
  await expect(gone).toBeVisible({ timeout: 20000 });
  await expect.poll(async () => (await state(page)).sites.filter((s) => s.status === 'ACTIVE').length).toBe(0);
  await expect(page.getByRole('radio', { name: 'Practice' })).toHaveCount(0);
  await gone.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.gm-pop').filter({ hasText: 'Practice is back' })).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('radio', { name: 'Practice' })).toBeVisible();
  // the new-site window lists the sites already on the map, each with Remove
  await page.locator('[data-gm-newsite]').click();
  await expect(page.locator('.sf-nw').getByText('Practice')).toBeVisible();
  await expect(page.locator('.sf-nw').getByRole('button', { name: 'Remove Practice' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Site name' }).fill('George St');
  await page.getByRole('button', { name: 'Open site', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'George St' })).toHaveAttribute('aria-checked', 'true', {
    timeout: 20000,
  });
  await page.keyboard.press('Escape');
  const site = (await state(page)).sites.find((s) => s.name === 'George St');
  await api(page, 'commands/gameSend', { site: site.id, lines: [{ product: std.id, quantity: Q }] });
  await expect
    .poll(
      async () => {
        const s = await state(page);
        return s.trucks.every((t) => !t.game) && (s.stock?.[site.id]?.pieces ?? 0) > 0;
      },
      { timeout: 150000 },
    )
    .toBe(true);
  // scaffold on the site: Remove site in its window asks once, in place
  await tapSite(page, site.id);
  const win = page.locator('[data-gm-win]');
  await expect(win.getByRole('heading', { name: 'George St' })).toBeVisible();
  await win.getByRole('button', { name: 'Remove site' }).click();
  await expect(
    win.getByText('George St still has scaffold on it. Bring it all back and remove the site?'),
  ).toBeVisible();
  await expect(win.getByRole('button', { name: 'Keep it' })).toBeVisible();
  await win.getByRole('button', { name: 'Bring it back and remove' }).click();
  await expect(win.getByText('Removing — bringing it all home')).toBeVisible({ timeout: 20000 });
  await expect(win.getByRole('button', { name: 'Keep it' })).toBeVisible();
  // the site's tag on the map says it too
  await expect
    .poll(() => page.getByText('Removing — bringing it all home').count(), { timeout: 20000 })
    .toBeGreaterThanOrEqual(2);
  await expect(page.locator('.gm-pop').filter({ hasText: 'George St is finished and removed.' })).toBeVisible({
    timeout: 180000,
  });
  const done = await state(page);
  expect(done.sites.find((s) => s.id === site.id).status).toBe('ARCHIVED');
  expect(done.register.find((r) => r.product === std.id).yard).toBe(Q);
  await expect(page.locator('[data-wm-site="' + site.id + '"]')).toHaveCount(0, { timeout: 20000 });
  // the Office, Client sites: Remove site on a site card, and Removed / finished sites with Open again
  await office(page, 'Client sites').click();
  const prac = (await state(page)).sites.find((s) => s.name === 'Practice' && s.status === 'ACTIVE');
  await page
    .locator('#si-site-' + prac.id)
    .getByRole('button', { name: 'Remove site' })
    .click();
  await expect
    .poll(async () => (await state(page)).sites.some((s) => s.id === prac.id), { timeout: 20000 })
    .toBe(false);
  // the Office has its Undo too: the very same site comes back
  const pop = page.locator('.sf-float .sf-pop').filter({ hasText: 'Practice removed' });
  await expect(pop).toBeVisible();
  await pop.getByRole('button', { name: 'Undo' }).click();
  await expect
    .poll(async () => (await state(page)).sites.find((s) => s.id === prac.id)?.status, { timeout: 20000 })
    .toBe('ACTIVE');
  await expect(page.locator('#si-site-' + prac.id).getByRole('button', { name: 'Remove site' })).toBeVisible({
    timeout: 20000,
  });
  await page
    .locator('#si-site-' + prac.id)
    .getByRole('button', { name: 'Remove site' })
    .click();
  await expect
    .poll(async () => (await state(page)).sites.some((s) => s.id === prac.id), { timeout: 20000 })
    .toBe(false);
  const list = page.locator('#si-finished');
  await expect(list.getByRole('heading', { name: 'Removed / finished sites' })).toBeVisible();
  await list.getByRole('button', { name: 'Open again' }).click();
  await expect
    .poll(async () => (await state(page)).sites.find((s) => s.id === site.id).status, { timeout: 20000 })
    .toBe('ACTIVE');
  await page.getByRole('button', { name: 'Back to the yard', exact: true }).click();
  await expect(bar).toBeVisible();
  await expect(page.locator('[data-wm-site="' + site.id + '"]')).toHaveCount(1, { timeout: 20000 });
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
});
