import {test,expect} from '@playwright/test';
import {office} from './workflow.js';
// Two audit bugs re-run in a real browser (Phase 0): Account's "Open the Materials list" used to land back on the board, and the browser's
// Back on an Office page used to leave the app. Back now returns to the yard board; the button Back to the yard and Back agree.
// One sign-up only (the server allows 10 sign-ups or sign-ins a minute, and the shape specs before this one use most of them).
async function signUp(page){
  await page.getByRole('textbox',{name:'Company name',exact:true}).fill('Nav DEMO');await page.getByRole('textbox',{name:'Your name',exact:true}).fill('Test Owner');
  await page.getByRole('textbox',{name:'Email',exact:true}).fill(`nav-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`);await page.getByRole('textbox',{name:'Password',exact:true}).fill('Local-demo-test-2026!');
  await page.getByRole('button',{name:'Create company',exact:true}).click();
}
const board=page=>page.getByRole('navigation',{name:'What do you want to do?'});
const title=page=>page.locator('.ob-title');

test('Account "Open the Materials list" opens it; browser Back on an Office page returns to the yard board; Back to the yard needs no second Back',async({page})=>{
  await page.goto('/');await signUp(page);await page.locator('[data-gm-size="S"]').click({timeout:45000});await expect(board(page)).toBeVisible({timeout:45000});
  // Account > Open the Materials list: the Materials catalogue, at Import materials
  await office(page,'Account').click();await page.getByRole('button',{name:'Open the Materials list',exact:true}).click();
  await expect(title(page)).toHaveText('Materials catalogue',{timeout:20000});await expect(page.locator('#mi-import')).toBeInViewport();
  await page.getByRole('button',{name:'Back to the yard',exact:true}).first().click();await expect(board(page)).toBeVisible();
  // Back from an Office page (after moving between two of them) lands on the board, still in the app
  await office(page,'Stock').click();await expect(title(page)).toHaveText('Stock ledger');
  await office(page,'Hire').click();await expect(title(page)).toHaveText('Hire');
  await page.goBack();await expect(board(page)).toBeVisible();expect(page.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  // the button and the browser agree: Today, Back to the yard, Forward, Back
  await office(page,'Today').click();await expect(title(page)).toHaveText('Today');await expect(page).toHaveURL(/\?view=TODAY$/);
  await page.getByRole('button',{name:'Back to the yard',exact:true}).first().click();await expect(board(page)).toBeVisible();await expect(page).not.toHaveURL(/view=/);
  await page.goForward();await expect(title(page)).toHaveText('Today');await page.goBack();await expect(board(page)).toBeVisible();
});
