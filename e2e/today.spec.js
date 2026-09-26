import {test,expect} from '@playwright/test';
// The Today page as the installed app opens it (/?view=TODAY): the page, its counters, and a phone width without sideways scrolling.
test('the installed app opens on Today, which fits a phone',async({page})=>{
  await page.goto('/');
  await page.getByRole('textbox',{name:'Company name',exact:true}).fill('Today DEMO');await page.getByRole('textbox',{name:'Your name',exact:true}).fill('Test Owner');
  await page.getByRole('textbox',{name:'Email',exact:true}).fill(`today-${Date.now()}@example.test`);await page.getByRole('textbox',{name:'Password',exact:true}).fill('Local-demo-test-2026!');
  await page.getByRole('checkbox',{name:'Quickstage',exact:true}).check();await page.getByRole('button',{name:'Create company',exact:true}).click();
  await page.getByRole('button',{name:'Create yard',exact:true}).click();await expect(page.getByRole('heading',{level:2,name:'Set up your real yard',exact:true})).toBeVisible({timeout:45000});
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href','/manifest.webmanifest');
  await page.goto('/?view=TODAY');await expect(page.getByRole('heading',{level:1,name:'Today',exact:true})).toBeVisible({timeout:45000});
  await expect(page).toHaveURL(/\/\?view=TODAY$/);// kept while Today is open, so 'Add to Home screen' from here opens on Today
  await expect(page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Today',exact:true})).toHaveClass(/current/);
  for(const name of ['Loads due today','Alerts','Trucks now','Crew now','Quick actions'])await expect(page.getByRole('heading',{level:2,name:new RegExp('^'+name)})).toBeVisible();
  await page.setViewportSize({width:375,height:800});
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.locator('[data-td-jump="crew"]').click();await expect(page.locator('#td-crew')).toBeInViewport();
  await page.setViewportSize({width:1280,height:900});await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Home',exact:true}).click();
  await expect(page).toHaveURL(/\/$/);// another page: the address is clean again
});
