import { test, expect } from '@playwright/test';
import { firstYard } from './workflow.js';
// A gear list in the Practice yard (ADR 0011): the same form and the same card, but the simulated crew packs and the truck autopilot drives:
// the dots fill by themselves and no step button is offered. Booked for now (the current half hour) while the yard's day is on; outside
// it, for tomorrow, and only the calendar and the empty dots are checked.
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
test('a gear list in the Practice yard: the crew packs, the truck drives, the dots fill by themselves, no buttons', async ({
  page,
}) => {
  test.setTimeout(240000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Company name', exact: true }).fill('Gear DEMO');
  await page.getByRole('textbox', { name: 'Your name', exact: true }).fill('Test Owner');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(`gear-demo-${Date.now()}@example.test`);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill('Local-demo-test-2026!');
  await page.getByRole('button', { name: 'Create company', exact: true }).click();
  await firstYard(page);
  const yard = (await api(page, 'state')).yards[0];
  // a quick yard (as the crew phone test runs it): the forklift and the trucks move fast, yard jobs off so the office packs at once
  await api(page, 'commands/resources', {
    location: yard.id,
    workers: 3,
    machines: 1,
    capacity: 1500000,
    stepMs: 300,
    speed: 3000,
    jobs: false,
  });
  await api(page, 'commands/quickAdjust', { kind: 'TRUCK', delta: 1, location: yard.id, payload: 12500000 }); // T-01
  await api(page, 'commands/gameCatalogue', { systems: ['quickstage'] });
  const s = await api(page, 'state?page=0');
  const part = s.products.find((p) => p.system === 'quickstage' && p.unitWeight > 0 && /standard/i.test(p.name));
  await api(page, 'commands/gameAddStock', { lines: [{ product: part.id, quantity: 200 }] });
  const site = (await api(page, 'commands/gameSite', { name: 'Bondi' })).site;
  const dave = (await api(page, 'commands/teamAdd', { name: 'Dave', role: 'DRIVER' })).person;
  await api(page, 'commands/planReplies', { on: false }); // the answers here are ours, not the demo's
  const plan = await api(page, 'plan');
  const now = new Date(plan.now),
    hm = String(now.getHours()).padStart(2, '0') + ':' + (now.getMinutes() < 30 ? '00' : '30'),
    onNow = hm >= '06:00' && hm <= '16:30',
    day = onNow ? plan.today : plan.tomorrow;
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
  await form.locator('input[name=name]').fill('Bondi gear');
  await form.locator('[data-tdh-pick]').click();
  await page.locator(`.tdh-layer [data-pp-slot="${part.id}"]`).click();
  await page.locator('.tdh-layer [data-pp-done]').click();
  await expect(page.locator('.tdh-layer')).toHaveCount(0);
  if (onNow) await form.locator('select[name=time]').selectOption(hm);
  await form.locator('select[name=driver]').selectOption({ label: 'Dave' });
  await expect(form.locator('select[name=truck] option', { hasText: 'Hire in a big truck' })).toHaveCount(1); // the Practice yard offers hire
  await form.locator('.tdh-go').click();
  await expect(cell.locator('.tdh-chip.tone-mat')).toContainText('Bondi gear', { timeout: 20000 });
  const card = page.locator('.tdh-item.tone-mat');
  await expect(card).toContainText('the yard → Bondi');
  await expect(card.locator('.gl-step')).toHaveCount(5);
  await expect(card.locator('.gl-truck')).toContainText('Dave');
  await expect(card.locator('.lo-btn')).toHaveCount(0); // the engine does the steps: no buttons
  await expect(card.locator('.gl-arrive')).toHaveCount(0);
  // the office answers the truck's ask for Dave (the demo's own answers are off)
  const asks = (await api(page, 'person?kind=driver&id=' + dave.id)).messages.filter((m) => m.canAnswer);
  for (const m of asks) await api(page, 'commands/messageAnswer', { id: m.id, yes: true, via: 'OFFICE' });
  if (!onNow) {
    expect(errors).toEqual([]);
    return;
  }
  // the yard's day is on: the crew packs it, T-01 loads, drives, unloads at Bondi: the dots fill one by one, by the yard
  await expect(card.locator('.gl-step.done')).toHaveCount(5, { timeout: 150000 });
  await expect(card).toContainText('Delivered');
  await expect(card.locator('.gl-step.done small').first()).toContainText('the yard'); // the engine's marks
  const item = (await api(page, 'plan?month=' + day.slice(0, 7))).items.find((i) => i.gear);
  expect(item.status).toBe('DONE');
  expect(item.chain.every((c) => c.done && c.kind === 'ENGINE')).toBe(true);
  expect(errors).toEqual([]);
});
