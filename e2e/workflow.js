import assert from 'node:assert/strict';
// Shared between Playwright test runner and Codex Browser's supported Playwright surface.
const button=(p,name)=>p.getByRole('button',{name,exact:true});
const fill=(p,name,value)=>p.getByRole('textbox',{name,exact:true}).fill(value);
async function visible(p,locator,timeout=45000){
  if(!p.domSnapshot)return locator.waitFor({state:'visible',timeout});
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){await p.domSnapshot();if(await locator.isVisible())return;await new Promise(resolve=>setTimeout(resolve,300));}
  throw new Error('Expected browser state did not become visible before the deadline.');
}
const idle=p=>visible(p,p.getByText('No movements waiting. Material stays where it is until you request a move.',{exact:true}));
export async function setupDemo(p,email){
  await fill(p,'Company name','Automated browser DEMO');await fill(p,'Your name','Test Owner');await fill(p,'Email',email);await fill(p,'Password','Local-demo-test-2026!');await p.getByRole('checkbox',{name:'Quickstage',exact:true}).check();await button(p,'Create company').click();
  await setupYard(p);
}
export async function setupYard(p){
  await visible(p,button(p,'Add segment'));await button(p,'Add segment').click();await p.getByRole('radio',{name:'↓ DOWN',exact:true}).check();await p.getByRole('spinbutton',{name:'Line length (m)',exact:true}).fill('16');await button(p,'Add segment').click();await p.getByRole('radio',{name:'← LEFT',exact:true}).check();await button(p,'Add segment').click();await button(p,'Preview and close perimeter').click();await button(p,'Save yard').click();
  await visible(p,p.getByText('Configure workers & equipment · DEMO ONLY',{exact:true}));await p.getByText('Configure workers & equipment · DEMO ONLY',{exact:true}).click();await button(p,'Save resources').click();await visible(p,button(p,'Pause simulation'));
  await button(p,'⚙ SETTINGS').click();await button(p,'Add synthetic demo catalogue').click();await visible(p,p.getByRole('status').filter({hasText:'Synthetic catalogue added.'}));await button(p,'← Open yard').click();await p.getByText('Add an empty container',{exact:true}).click();await button(p,'Register empty container').click();await visible(p,button(p,'Select S-001'));
  await button(p,'▤ STOCK').click();await p.getByText('Add starting stock / authorised receipt',{exact:true}).click();await button(p,'Record stock receipt').click();const stock=p.getByRole('row').filter({hasText:'DEMO ledger — 2 m'});await visible(p,stock);assert.equal(await stock.getByRole('cell',{name:'100',exact:true}).count(),2);assert.match(await stock.innerText(),/Main yard/);
  await setupLogistics(p);
}
export async function setupLogistics(p){
  await button(p,'▰ TRUCKS').click();await p.getByText('Add a truck',{exact:true}).click();await button(p,'Add truck').click();await visible(p,p.getByRole('heading',{name:'▰ T-01',exact:true}));
  await button(p,'⚑ SITES').click();await p.getByText('Create a site',{exact:true}).click();await fill(p,'Site name','Browser demo site');await fill(p,'Address / location','Synthetic test location');await button(p,'Create site').click();await visible(p,p.getByRole('heading',{name:'⚑ Browser demo site',exact:true}));
  await button(p,'▦ YARD').click();await p.getByText('Configure workers & equipment · DEMO ONLY',{exact:true}).click();await p.getByRole('combobox',{name:'Location',exact:true}).selectOption({label:'Browser demo site'});await button(p,'Save resources').click();await p.getByRole('button',{name:'Save resources',exact:true}).waitFor({state:'hidden'});
}
export async function deliverDemo(p){
  await button(p,'☷ REQUESTS').click();await p.getByText('Create a material request',{exact:true}).click();await button(p,'Send to yard').click();await visible(p,button(p,'Plan packs & load truck'));await button(p,'Plan packs & load truck').click();await visible(p,p.getByText('ALLOCATED',{exact:true}));await idle(p);
  await dispatchDemo(p);
}
export async function dispatchDemo(p){
  await button(p,'▰ TRUCKS').click();assert.equal(await p.getByText('550 kg',{exact:true}).count(),1);await button(p,'Dispatch truck').click();await visible(p,p.getByText('IN TRANSIT',{exact:true}));await visible(p,p.getByText('AT SITE',{exact:true}));assert.equal(await p.getByText('550 kg',{exact:true}).count(),1);await unloadDemo(p);
}
export async function unloadDemo(p){
  await button(p,'Unload at current location').click();await visible(p,p.getByText('1 active tasks',{exact:true}));await idle(p);
  await button(p,'▤ STOCK').click();const row=await p.getByRole('row').filter({hasText:'DEMO ledger — 2 m'}).innerText();assert.match(row,/Browser demo site/);assert.match(row,/100/);await button(p,'☷ REQUESTS').click();await visible(p,p.getByText('DELIVERED',{exact:true}));
}
