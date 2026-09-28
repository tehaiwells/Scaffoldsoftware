import {test,expect} from '@playwright/test';
import {createCompany,firstYard,office} from './workflow.js';
// The crew phone view: tap a worker on the Workers page, give orders with the big buttons, keep the page open through polls, fit a phone, and open straight from the link.
const api=(page,path,data)=>page.evaluate(async([path,data])=>{const res=await fetch('/api/'+path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify(data)});const v=await res.json();if(!res.ok)throw new Error(v.error);return v;},[path,data]);
test('a worker opens on the crew phone view, takes orders there and the link opens it again',async({page})=>{
  await page.goto('/');
  await page.getByRole('textbox',{name:'Company name',exact:true}).fill('Crew DEMO');await page.getByRole('textbox',{name:'Your name',exact:true}).fill('Test Owner');
  await page.getByRole('textbox',{name:'Email',exact:true}).fill(`crew-${Date.now()}@example.test`);await page.getByRole('textbox',{name:'Password',exact:true}).fill('Local-demo-test-2026!');
  await createCompany(page);
  await firstYard(page);
  const yard=(await api(page,'state')).yards[0];
  await api(page,'commands/resources',{location:yard.id,workers:3,machines:1,capacity:1500000,stepMs:300,speed:3000,jobs:false});
  await api(page,'commands/createJob',{yard:yard.id,category:'YARD',title:'Sweep the loading zone',where:{kind:'loading'},priority:7,seconds:60});
  const crew=(await api(page,'state')).resources.filter(r=>r.type==='WORKER'&&r.location===yard.id);
  await page.setViewportSize({width:375,height:812});
  await office(page,'Workers').click();
  // The phone's own Back button returns to Workers; the card's Phone view button opens the crew page again.
  await page.getByRole('button',{name:`Open ${crew[0].name} on the crew phone view`}).click();
  await expect(page.getByRole('heading',{level:1,name:crew[0].name,exact:true})).toBeVisible({timeout:15000});
  await page.goBack();await expect(page.getByRole('heading',{level:1,name:'Workers',exact:true})).toBeVisible({timeout:15000});
  await page.getByRole('button',{name:`Phone view for ${crew[0].name}`}).click();
  await expect(page.getByRole('heading',{level:1,name:crew[0].name,exact:true})).toBeVisible({timeout:15000});
  await expect(page).toHaveURL(new RegExp('\\?view=CREW&worker='+crew[0].id+'$'));
  for(const name of ['Now','Orders','Likely next',/^Done today/])await expect(page.getByRole('heading',{level:2,name})).toBeVisible();
  await expect(page.locator('.cw-map svg.yard-svg')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  // Hold here, then back to automatic: the pill follows and the buttons swap.
  await page.locator('[data-cw-cmd="HOLD"]').click();await expect(page.locator('.cw-pill')).toHaveText('On hold',{timeout:15000});await expect(page.locator('[data-cw-cmd="HOLD"]')).toBeDisabled();
  await page.locator('[data-cw-cmd="AUTO"]').click();await expect(page.locator('.cw-pill')).not.toHaveText('On hold',{timeout:15000});
  // The Assign menu stays open through the 1 s poll, and assigning a job shows it under Now.
  await page.locator('[data-cw-menu="assign"]').click();await expect(page.locator('#cw-menu')).toBeVisible();{const polled=()=>page.waitForResponse(r=>new URL(r.url()).pathname==='/api/state',{timeout:15000});await polled();await polled();}await expect(page.locator('#cw-menu')).toBeVisible();
  await page.locator('#cw-menu [data-cw-assign]').filter({hasText:'Sweep the loading zone'}).click();
  await expect(page.locator('.cw-now .cw-big')).toHaveText(/Sweep the loading zone/,{timeout:15000});
  // Next worker, then the link opens the first worker again after a reload.
  await page.getByRole('button',{name:`Next worker: ${crew[1].name}`}).click();await expect(page.getByRole('heading',{level:1,name:crew[1].name,exact:true})).toBeVisible();
  await page.goto('/?view=CREW&worker='+crew[0].id);await expect(page.getByRole('heading',{level:1,name:crew[0].name,exact:true})).toBeVisible({timeout:45000});
  await office(page,'Workers').click();await expect(page.getByRole('heading',{level:1,name:'Workers',exact:true})).toBeVisible();await expect(page).toHaveURL(/\/$/);
});
