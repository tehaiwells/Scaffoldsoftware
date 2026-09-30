import { test, expect } from '@playwright/test';
// The real yard's Office, page by page: no simulation-only control is offered (no hand driving, no loading or dispatching, no Schedule or
// Control room, no crew orders, no "+1 worker", no Pause), nothing says people are at the yard or working, and the record keeping that is
// offered works: not one command is refused with 409 anywhere on the walk.
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
      if (!res.ok) throw new Error(path + ': ' + v.error);
      return v;
    },
    [path, data],
  );
async function signUp(page, name) {
  await page.getByRole('textbox', { name: 'Company name', exact: true }).fill(name);
  await page.getByRole('textbox', { name: 'Your name', exact: true }).fill('Tee');
  await page
    .getByRole('textbox', { name: 'Email', exact: true })
    .fill(`live-office-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill('Local-demo-test-2026!');
  await page.getByRole('button', { name: 'Create company', exact: true }).click();
}
// What only the Practice yard has: its buttons and words must not show anywhere in the real yard's Office.
const SIM_BUTTONS = [
  /Dispatch truck/,
  /Unload at current location/,
  /Load selected onto/,
  /Book it on the Schedule/,
  /Create a yard list/,
  /Quick single-line request/,
  /Plan a new layout/,
  /Mount forklift/,
  /Return to work/,
  /Hold position/,
  /(Pause|Resume) simulation/,
  /Add synthetic demo catalogue/,
  /Run it by hand/,
  /Open schedule/,
  /Resume in the Control room/,
];
const SIM_WORDS = [
  'Left-click worker to select',
  'Right-click ground',
  'yard crew busy now',
  'Crew working',
  'Drop a stillage or cage',
  'The yard keeps working while you look',
  'Configure workers & equipment',
  'SIMULATION / DEMONSTRATION',
  'Your yard crew',
];
test('every page of the real yard Office: no simulation controls or invented crew, and nothing is refused', async ({
  page,
}) => {
  test.setTimeout(240000);
  const refused = [];
  page.on('response', async (r) => {
    if (r.request().method() === 'POST' && r.url().includes('/api/commands/') && r.status() === 409)
      refused.push(r.url().split('/api/commands/')[1] + ' ' + (await r.text().catch(() => '')));
  });
  await page.goto('/');
  await signUp(page, 'tee');
  await expect(page.getByRole('heading', { level: 1, name: 'How big is your yard?' })).toBeVisible({ timeout: 45000 });
  await page.locator('[data-gm-size="S"]').click();
  await expect(page.getByRole('navigation', { name: 'What do you want to do?' })).toBeVisible({ timeout: 45000 });
  // the real yard, set up with its record-keeping commands
  await api(page, 'live-company', { name: 'Tee Scaffolding' });
  const { yard } = await api(page, 'commands/gameStart', { size: 'S' });
  await api(page, 'commands/gameCatalogue', {});
  const st = await api(page, 'state?catalogue=');
  const p = st.products.find((x) => x.unitWeight > 0 && x.packQuantity == null);
  await api(page, 'commands/gameAddStock', { lines: [{ product: p.id, quantity: 40 }] });
  await api(page, 'commands/gameSite', { name: 'Bondi', address: '1 Campbell Parade' });
  const typo = (await api(page, 'commands/gameSite', { name: 'Bondii' })).site;
  await api(page, 'commands/quickAdjust', { kind: 'TRUCK', delta: 1, location: yard.id, payload: 12500000 });
  for (const [name, role] of [
    ['Dave', 'DRIVER'],
    ['Kev', 'YARDSMAN'],
    ['Jo', 'SCAFFOLDER'],
  ])
    await api(page, 'commands/teamAdd', { name, role });
  await page.goto('/');
  await expect(page.locator('.gm-top .gm-practice')).toContainText('Live', { timeout: 45000 });
  const openOffice = async () => {
    await page.getByRole('button', { name: 'Office', exact: true }).first().click();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  };
  await openOffice();
  const drawer = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(drawer.locator('..').locator('..')).not.toContainText('The yard keeps working while you look');
  const tiles = (await drawer.locator('button').allInnerTexts()).map((x) => x.trim().split('\n')[0]).filter(Boolean);
  expect(tiles).not.toContain('Control room');
  expect(tiles).not.toContain('Schedule');
  const seen = [];
  for (const tile of tiles) {
    if (tile === 'Account' || /^Yard & sites|^Home$/.test(tile)) continue;
    await page.goto('/');
    await expect(page.locator('.gm-top .gm-practice')).toContainText('Live', { timeout: 45000 });
    await openOffice();
    await drawer.getByRole('button', { name: tile }).first().click();
    await expect(page.locator('.office-bar')).toBeVisible({ timeout: 45000 });
    await page.waitForTimeout(1200);
    const view = page.locator('#app');
    const buttons = await page.evaluate(() =>
      [...document.querySelectorAll('#app button, #app [role=button]')]
        .filter((b) => b.getClientRects().length)
        .map((b) =>
          String(b.innerText || b.textContent || b.getAttribute('aria-label') || '')
            .replace(/\s+/g, ' ')
            .trim(),
        ),
    );
    for (const re of SIM_BUTTONS)
      expect(
        buttons.filter((b) => re.test(b)),
        tile + ': ' + re,
      ).toEqual([]);
    const text = await view.innerText();
    for (const w of SIM_WORDS) expect(text.includes(w), tile + ': "' + w + '"').toBe(false);
    await expect(
      page.locator('#app [data-view="SCHEDULE"]:visible, #app [data-view="CONTROL"]:not(.ob-back):visible'),
      tile + ': a way into the Schedule or Control room',
    ).toHaveCount(0);
    seen.push(tile);
  }
  expect(seen).toEqual(
    expect.arrayContaining([
      'Daily activities',
      'Gear list',
      'Workers',
      'Task progress',
      'Pre-start',
      'Stock ledger',
      'Client sites',
      'Big trucks',
    ]),
  );
  // record keeping on the way: remove the mistyped site from Client sites, add a forklift on Equipment
  await page.goto('/');
  await openOffice();
  await drawer.getByRole('button', { name: 'Client sites' }).first().click();
  await page.locator(`[data-sf-remove="${typo.id}"]`).click();
  await expect(page.locator(`[data-site-panel="${typo.id}"]`)).toHaveCount(0, { timeout: 30000 });
  const s2 = await api(page, 'state?page=0');
  expect(s2.sites.some((x) => x.id === typo.id && x.status === 'ACTIVE')).toBe(false);
  expect(refused, 'no command refused on the walk').toEqual([]);
});
