import {test,expect} from '@playwright/test';
import {office} from './workflow.js';
// The game board, as a new owner meets it: sign up, pick a yard size, load the parts list, add stock, send it to a new site with one button,
// watch it delivered, bring it back, and find the Office pages behind the Office door with a way back to the yard.
const api=(page,path,data)=>page.evaluate(async([path,data])=>{const res=await fetch('/api/'+path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify(data)});const v=await res.json();if(!res.ok)throw new Error(v.error);return v;},[path,data]);
test('sign up, choose a yard size, add stock, send it to a site, see it delivered and bring it back',async({page})=>{
  test.setTimeout(240000);
  await page.goto('/');
  await page.getByRole('textbox',{name:'Company name',exact:true}).fill('Game DEMO');await page.getByRole('textbox',{name:'Your name',exact:true}).fill('Test Owner');
  await page.getByRole('textbox',{name:'Email',exact:true}).fill(`game-${Date.now()}@example.test`);await page.getByRole('textbox',{name:'Password',exact:true}).fill('Local-demo-test-2026!');
  await page.getByRole('checkbox',{name:'Quickstage',exact:true}).check();await page.getByRole('button',{name:'Create company',exact:true}).click();
  // one tap for the yard: the board opens with the first hint
  await expect(page.getByRole('heading',{level:1,name:'How big is your yard?'})).toBeVisible({timeout:45000});
  await page.locator('[data-gm-size="S"]').click();
  const bar=page.getByRole('navigation',{name:'What do you want to do?'});await expect(bar).toBeVisible({timeout:45000});
  for(const name of ['Send','Bring back','Add stock'])await expect(bar.getByRole('button',{name,exact:true})).toBeVisible();
  await expect(page.locator('.gm-hint-dock .gm-bubble')).toContainText('Load your scaffold parts list');
  const yard=(await api(page,'state?page=0')).yards[0];await api(page,'commands/resources',{location:yard.id,workers:4,machines:2,stepMs:120,speed:20000});
  await page.locator('.gm-hint-dock').getByRole('button',{name:'Load my parts list'}).click();
  await expect(page.locator('.gm-pop').filter({hasText:'added to your parts list'})).toBeVisible({timeout:20000});
  // Add stock: the button, a slot, Add to the yard
  const s0=await api(page,'state?page=0'),std=s0.products.find(p=>p.name==='Kwikstage standard 3.0 m');
  await bar.getByRole('button',{name:'Add stock',exact:true}).click();await page.locator('[data-gm-tab="frame"]').click();
  await page.locator(`[data-gm-slot="${std.id}"]`).click();await expect(page.locator(`[data-gm-slot="${std.id}"]`)).toHaveClass(/picked/);
  await page.getByRole('button',{name:'Add to the yard'}).click();
  await expect(page.locator('.gm-pop').filter({hasText:'Added to the yard!'})).toBeVisible({timeout:20000});
  await expect.poll(async()=>(await api(page,'state?page=0')).register.find(r=>r.product===std.id)?.yard??0).toBeGreaterThan(0);
  const added=(await api(page,'state?page=0')).register.find(r=>r.product===std.id).yard;
  await expect(page.locator(`[data-gm-slot="${std.id}"] .gm-n`)).toHaveText(String(added));
  // Send: a new site the first time, a slot, one big button; the crew loads, the truck drives, the crane unloads, and it says Delivered
  await bar.getByRole('button',{name:'Send',exact:true}).click();
  await page.getByRole('textbox',{name:'Site name'}).fill('George St');await page.getByRole('button',{name:'Add site',exact:true}).click();
  await expect(page.getByRole('radio',{name:'George St'})).toHaveAttribute('aria-checked','true',{timeout:20000});
  await page.locator(`[data-gm-slot="${std.id}"]`).click();
  await page.getByRole('button',{name:'Send to George St'}).click();
  await expect(page.locator('.gm-pop').filter({hasText:'loading for George St'})).toBeVisible({timeout:20000});
  await expect(page.locator('.gm-pop').filter({hasText:'Delivered to George St!'})).toBeVisible({timeout:150000});
  const site=(await api(page,'state?page=0')).sites.find(x=>x.name==='George St');
  await expect.poll(async()=>(await api(page,'state?page=0')).stock?.[site.id]?.pieces??0,{timeout:30000}).toBe(added);
  // the site's inventory: the same grid, with what is on site
  await expect.poll(async()=>(await api(page,'state?page=0')).trucks.every(t=>!t.game),{timeout:120000}).toBe(true);
  await bar.getByRole('button',{name:'Bring back',exact:true}).click();
  await expect(page.locator(`[data-gm-slot="${std.id}"] .gm-n`)).toHaveText(String(added));
  await page.getByRole('button',{name:'Bring everything back'}).click();
  await expect(page.locator('.gm-pop').filter({hasText:'is back from George St!'})).toBeVisible({timeout:180000});
  await expect.poll(async()=>(await api(page,'state?page=0')).register.find(r=>r.product===std.id)?.yard??0,{timeout:60000}).toBe(added);
  // the Office: a drawer of pages, each with a big way back to the game
  await office(page,'Schedule').click();await expect(page.getByRole('heading',{level:1,name:'Load schedule',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Back to the yard',exact:true}).click();await expect(bar).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
test('the game board fits a phone: map on top, thumb buttons at the bottom, the stock as a bottom sheet',async({page})=>{
  await page.setViewportSize({width:375,height:812});await page.goto('/');
  await page.getByRole('textbox',{name:'Company name',exact:true}).fill('Phone DEMO');await page.getByRole('textbox',{name:'Your name',exact:true}).fill('Test Owner');
  await page.getByRole('textbox',{name:'Email',exact:true}).fill(`phone-${Date.now()}@example.test`);await page.getByRole('textbox',{name:'Password',exact:true}).fill('Local-demo-test-2026!');
  await page.getByRole('checkbox',{name:'Quickstage',exact:true}).check();await page.getByRole('button',{name:'Create company',exact:true}).click();
  await page.locator('[data-gm-size="M"]').click();const bar=page.getByRole('navigation',{name:'What do you want to do?'});await expect(bar).toBeVisible({timeout:45000});
  const box=await bar.boundingBox();expect(box.y+box.height).toBeGreaterThan(800);expect(box.width).toBeLessThanOrEqual(375);
  for(const name of ['Send','Bring back','Add stock','Stock']){const b=await bar.getByRole('button',{name,exact:true}).boundingBox();expect(b.height).toBeGreaterThanOrEqual(64);expect(b.x+b.width).toBeLessThanOrEqual(376);}
  await expect(page.locator('.gm-dock')).not.toBeInViewport();await bar.getByRole('button',{name:'Stock',exact:true}).click();await expect(page.locator('.gm-win')).toBeInViewport();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
