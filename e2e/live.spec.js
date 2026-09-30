import { test, expect } from '@playwright/test';
// Phase 1A part 1: the owner keeps his Practice yard and starts his real yard from Account. The real yard's board says "Live" (with Send
// and Bring back since part 2), and its Office has no Control room or Schedule; the chip switches between the two yards with two big choices.
async function signUp(page, name) {
  await page.getByRole('textbox', { name: 'Company name', exact: true }).fill(name);
  await page.getByRole('textbox', { name: 'Your name', exact: true }).fill('Tee');
  await page
    .getByRole('textbox', { name: 'Email', exact: true })
    .fill(`live-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill('Local-demo-test-2026!');
  await page.getByRole('button', { name: 'Create company', exact: true }).click();
}
const bar = (page) => page.getByRole('navigation', { name: 'What do you want to do?' });
const chip = (page) => page.locator('.gm-top .gm-practice');
test('start the real yard from Account, see the LIVE board and Office, and switch between the two yards', async ({
  page,
}) => {
  test.setTimeout(180000);
  await page.goto('/');
  await signUp(page, 'tee');
  await expect(page.getByRole('heading', { level: 1, name: 'How big is your yard?' })).toBeVisible({ timeout: 45000 });
  await page.locator('[data-gm-size="S"]').click();
  await expect(bar(page)).toBeVisible({ timeout: 45000 });
  await expect(chip(page)).toContainText('Practice');
  await expect(page.locator('[data-gm-switch]')).toHaveCount(0); // one company: no switcher
  // Account: "Start your real yard"
  await page.getByRole('button', { name: 'Office', exact: true }).first().click();
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  const card = page.locator('#start-live');
  await expect(card.getByRole('heading', { name: 'Start your real yard' })).toBeVisible({ timeout: 45000 });
  await card.getByRole('textbox', { name: 'Your company’s name' }).fill('Tee Scaffolding');
  await card.getByRole('button', { name: 'Start my real yard' }).click();
  // the real yard: its first step is the yard size, with the Live chip
  await expect(page.getByRole('heading', { level: 1, name: 'How big is your yard?' })).toBeVisible({ timeout: 45000 });
  await expect(chip(page)).toContainText('Live');
  await page.locator('[data-gm-size="S"]').click();
  await expect(bar(page)).toBeVisible({ timeout: 45000 });
  await expect(bar(page).getByRole('button', { name: 'Add stock', exact: true })).toBeVisible();
  // part 2: Send and Bring back make exact orders in the real yard (people confirm each step: live-trips-ui.spec.js)
  for (const name of ['Send', 'Bring back'])
    await expect(bar(page).getByRole('button', { name, exact: true })).toBeVisible();
  // the Office: no Control room, no Schedule; the pages that keep records are there
  await page.getByRole('button', { name: 'Office', exact: true }).first().click();
  const tiles = page.getByRole('navigation', { name: 'Main navigation' });
  for (const name of ['Control room', 'Schedule'])
    await expect(tiles.getByRole('button', { name, exact: true })).toHaveCount(0);
  for (const name of ['Daily activities', 'Stock ledger', 'Client sites', 'Workers', 'Task progress', 'Pre-start'])
    await expect(tiles.getByRole('button', { name, exact: true })).toBeVisible();
  await tiles.getByRole('button', { name: 'Stock ledger', exact: true }).click();
  await expect(page.locator('.live-banner')).toContainText('Live · your real yard');
  await expect(page.locator('.simulation-banner:not(.live-banner)')).toHaveCount(0);
  await page.getByRole('button', { name: /Back to the yard/ }).click();
  await expect(bar(page)).toBeVisible({ timeout: 45000 });
  // the chip: two big choices; the Practice yard is as it was
  await page.locator('[data-gm-switch]').click();
  const practice = page.locator('.gm-switch-pop .sy-choice.is-practice');
  await expect(practice).toContainText('Practice yard');
  await expect(page.locator('.gm-switch-pop .sy-choice.is-live')).toContainText('You are here');
  await practice.click();
  await expect(chip(page)).toContainText('Practice', { timeout: 45000 });
  await expect(bar(page).getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  await page.locator('[data-gm-switch]').click();
  await page.locator('.gm-switch-pop .sy-choice.is-live').click();
  await expect(chip(page)).toContainText('Live', { timeout: 45000 });
});
