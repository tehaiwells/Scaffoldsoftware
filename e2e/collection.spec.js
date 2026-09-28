import {test,expect} from '@playwright/test';
import {setupDemo,deliverDemo,office} from './workflow.js';
// Scheduled returns: after a delivery, the site's stock is booked for collection on the site card, loaded by the site crane onto the truck that is
// still parked there, sent back to the yard and unloaded; the collection ends as RETURNED and shows on the Schedule as a return card.
test('a collection brings the site stock back: booked on the site card, loaded by the crane, sent to the yard, returned',async({page})=>{
  await page.goto('/');await setupDemo(page,`collect-${Date.now()}@example.test`);await deliverDemo(page);
  const block=page.locator('.rt-block').first(),status=block.locator('.rt-status').first();
  await block.locator('summary').filter({hasText:'Book a collection'}).click();
  await block.getByRole('button',{name:'Today',exact:true}).click();
  await block.getByRole('combobox',{name:'Truck',exact:true}).selectOption({label:'T-01 (here now)'});
  await block.getByRole('button',{name:'Book collection',exact:true}).click();
  await expect(status).toHaveText('BOOKED');
  await office(page,'Schedule').click();
  await expect(page.locator('.sch-card.rt-card').first()).toBeVisible();
  await office(page,'Client sites').click();
  await block.getByRole('button',{name:'Load collection onto T-01',exact:true}).click();
  await expect(status).toHaveText('LOADING');
  const send=block.getByRole('button',{name:'Send T-01 back to the yard',exact:true});
  await expect(send).toBeVisible({timeout:90000});await send.click();
  await expect(status).toHaveText(/ON THE WAY|RETURNED/);
  await office(page,'Truck 12.5 tonne').click();
  const unload=page.getByRole('button',{name:'Unload T-01 at the yard',exact:true});
  // The yard crew may start unloading by itself (yard jobs); otherwise the collection card offers the unload.
  await expect.poll(async()=>await unload.isVisible()?'unload':await page.getByText('The crew is unloading it',{exact:false}).count()?'crew':await page.locator('.rt-truck').count()?'on the way':'off the truck',{timeout:90000,intervals:[250]}).not.toBe('on the way');
  if(await unload.isVisible())await unload.click();
  await office(page,'Client sites').click();
  await expect(status).toHaveText('RETURNED',{timeout:90000});
});
