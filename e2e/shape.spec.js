import {test,expect} from '@playwright/test';
// The yard shape editor and the one-click stillage turn, end to end. Each test starts a fresh company, so it opens on the first-run editor.
const button=(p,name)=>p.getByRole('button',{name,exact:true});
const width=p=>p.getByRole('spinbutton',{name:'Width (m)',exact:true});
const save=p=>p.getByRole('button',{name:/^Save yard/});
async function cmd(p,name,data){const res=await p.request.post('/api/commands/'+name,{data,headers:{'Idempotency-Key':crypto.randomUUID()}});const body=await res.json();if(!res.ok())throw new Error(body.error);return body;}
const snapshot=async p=>(await p.request.get('/api/state')).json();
async function register(p){
  await p.goto('/');await p.getByLabel('Company name').fill('Shape editor DEMO');await p.getByLabel('Your name').fill('Test Owner');await p.getByLabel('Email').fill(`shape-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`);await p.getByLabel('Password').fill('Local-demo-test-2026!');await p.getByRole('checkbox',{name:'Quickstage',exact:true}).check();await button(p,'Create company').click();
  await expect(p.locator('#shape-editor')).toBeVisible();
}
// A 20 × 16 m yard with two workers, a forklift and one empty stillage S-001 at 4, 4 m.
async function yardWithStock(p){
  await register(p);await expect(width(p)).toHaveValue('20');await expect(p.getByRole('spinbutton',{name:'Depth (m)',exact:true})).toHaveValue('16');await button(p,'Create yard').click();await expect(p.locator('.scene')).toBeVisible();
  const yard=(await snapshot(p)).yards[0];await cmd(p,'resources',{location:yard.id,workers:2,machines:1,capacity:1500000,stepMs:100,speed:20000,craneWorkers:1});
  const stillage=await cmd(p,'container',{name:'S-001',location:yard.id,type:'STILLAGE',length:2000,width:1000,height:1000,envelopeLength:2000,envelopeWidth:1000,tare:50000,x:4000,y:4000});
  await expect(p.locator('.scene [data-select="'+stillage.id+'"]')).toBeVisible();return {yard,stillage};
}
async function openEditor(p){await button(p,'Change yard shape & size').click();await expect(p.locator('#shape-editor')).toBeVisible();}

test('the first-run editor fits a phone: Width is on screen, the save bar is short and nothing scrolls sideways',async({page})=>{
  await page.setViewportSize({width:375,height:812});await register(page);
  await expect(width(page)).toBeInViewport();await expect(width(page)).toHaveValue('20');
  const bar=await page.locator('#shape-savebar').boundingBox();expect(bar.height).toBeLessThanOrEqual(140);// two status lines, the More link and one 44 px row of buttons
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
});

test('one click on Save yard saves the new size (no click is lost to the 1 s refresh), and the toast never covers the save bar',async({page})=>{
  await yardWithStock(page);await openEditor(page);
  const box=await page.locator('#shape-save').boundingBox();const hit=await page.evaluate(([x,y])=>document.elementFromPoint(x,y)?.closest('#shape-save')?.id??null,[box.x+box.width/2,box.y+box.height/2]);expect(hit).toBe('shape-save');
  await width(page).fill('25');await width(page).press('Tab');await expect(save(page)).toBeEnabled();await save(page).click();
  await expect(page.locator('.plan-head-actions span')).toContainText('25.0 × 16.0 m');
});

test('focus stays where the owner put it: drag the right side, then type a width',async({page})=>{
  await yardWithStock(page);await openEditor(page);
  const handle=page.locator('#shape-svg [data-handle="side:1"]').first(),b=await handle.boundingBox();
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2+40,b.y+b.height/2,{steps:5});
  await expect(page.locator('#shape-svg .dim-label').first()).not.toHaveText('20.0 m');await page.mouse.up();
  await width(page).click();await width(page).fill('25');await width(page).press('Tab');
  await expect(width(page)).toHaveValue('25');await expect(page.locator('#shape-size')).toHaveText(/^25\.0 × 16\.0 m/);
});

test('typing survives the poll, and Movement activity keeps updating while the editor is open',async({page})=>{
  const {stillage}=await yardWithStock(page);await openEditor(page);
  const nameField=page.locator('#shape-name');await nameField.fill('North yard');await page.waitForTimeout(3000);await expect(nameField).toHaveValue('North yard');await expect(nameField).toBeFocused();
  await nameField.press('Tab');await cmd(page,'rotate',{container:stillage.id,rotation:90});
  await expect(page.locator('section.activity')).toContainText(/TURN 90°|No movements waiting/,{timeout:10000});await expect(page.locator('#shape-name')).toHaveValue('North yard');
});

test('the gate cannot be dropped outside the yard; it stays at its last allowed spot',async({page})=>{
  await yardWithStock(page);await openEditor(page);
  const gate=page.locator('#shape-svg [data-handle="gate"]'),b=await gate.boundingBox(),svg=await page.locator('#shape-svg').boundingBox();
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(svg.x+4,svg.y+4,{steps:8});await page.mouse.up();
  const [x,y]=(await gate.getAttribute('aria-label')).match(/(-?[\d.]+), (-?[\d.]+) m/).slice(1).map(Number);
  expect(x).toBeGreaterThanOrEqual(0);expect(y).toBeGreaterThanOrEqual(0);expect(x).toBeLessThanOrEqual(18);expect(y).toBeLessThanOrEqual(14.5);
});

test('shrinking the yard names the stillage that will be moved before saving',async({page})=>{
  await yardWithStock(page);await openEditor(page);
  await width(page).fill('5');await width(page).press('Tab');
  await expect(page.locator('#shape-status')).toContainText('S-001');await expect(save(page)).toHaveText(/moves 1 stillage/);
});

test('a refused save shows in the bar only and the toast clears itself',async({page})=>{
  await yardWithStock(page);await openEditor(page);
  await page.route('**/api/commands/yard',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Test refusal: nothing was changed.'})}));
  await width(page).fill('22');await width(page).press('Tab');await save(page).click();
  await expect(page.locator('#shape-status')).toContainText('Test refusal');
  const box=await page.locator('#shape-save').boundingBox();expect(await page.evaluate(([x,y])=>document.elementFromPoint(x,y)?.closest('#shape-save')?.id??null,[box.x+box.width/2,box.y+box.height/2])).toBe('shape-save');
  await expect(page.locator('#message')).toBeEmpty({timeout:10000});
});

test('one click on the plan turn button turns S-001, and the page does not jump when it is selected',async({page})=>{
  const {stillage}=await yardWithStock(page);
  const worker=(await snapshot(page)).resources.find(r=>r.type==='WORKER');await cmd(page,'workerCommand',{id:worker.id,order:'MOVE',x:15000,y:12000});
  const before=await page.evaluate(()=>scrollY);await page.locator('.scene [data-select="'+stillage.id+'"]').click();
  await expect(page.locator('.plan-selection')).toContainText('long side along side 1');expect(Math.abs(await page.evaluate(()=>scrollY)-before)).toBeLessThan(5);
  const turn=page.locator('.plan-turn');await expect(turn).toBeVisible();await expect(turn).toBeEnabled();await turn.click();
  await expect(page.locator('#message')).toHaveText(/quarter turn/);
  await expect(page.getByText('No movements waiting. Material stays where it is until you request a move.',{exact:true})).toBeVisible({timeout:45000});
  await expect(page.locator('.plan-selection')).toContainText('long side along side 2',{timeout:10000});
});
