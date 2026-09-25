import assert from 'node:assert/strict';
// Shared between Playwright test runner and Codex Browser's supported Playwright surface.
// Pages are reached through the sidebar (Home, Overview, Workers, Equipment, Truck 12.5 tonne, Truck 2 tonne, Stock, Materials list, Client sites, Yard (layout plan), Account).
const button=(p,name)=>p.getByRole('button',{name,exact:true});
const fill=(p,name,value)=>p.getByRole('textbox',{name,exact:true}).fill(value);
const nav=(p,label)=>p.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:label,exact:true});
// Fold-out forms: the summary carries a title and a small subtitle, so match on the title.
const fold=(p,title)=>p.locator('summary').filter({hasText:title}).first();
async function visible(p,locator,timeout=45000){
  if(!p.domSnapshot)return locator.first().waitFor({state:'visible',timeout});
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){await p.domSnapshot();if(await locator.first().isVisible())return;await new Promise(resolve=>setTimeout(resolve,300));}
  throw new Error('Expected browser state did not become visible before the deadline.');
}
async function open(p,label,hero){await nav(p,label).click();await visible(p,p.getByRole('heading',{level:1,name:hero,exact:true}));}
// The Stock page's materials register: one row per product, read by column heading (In yard, At sites, On trucks, Total, Reserved, Available).
async function register(p,product){const row=p.getByRole('row').filter({hasText:product}).first();await visible(p,row);const table=p.locator('table').filter({has:row}).first(),heads=(await table.getByRole('columnheader').allTextContents()).map(h=>h.trim()),cells=(await row.getByRole('cell').allTextContents()).map(c=>c.trim());return Object.fromEntries(heads.map((h,i)=>[h,cells[i]]));}
const idle=p=>visible(p,p.getByText('No movements waiting. Material stays where it is until you request a move.',{exact:true}));
export async function setupDemo(p,email){
  await fill(p,'Company name','Automated browser DEMO');await fill(p,'Your name','Test Owner');await fill(p,'Email',email);await fill(p,'Password','Local-demo-test-2026!');await p.getByRole('checkbox',{name:'Quickstage',exact:true}).check();await button(p,'Create company').click();
  await setupYard(p);
}
export async function setupYard(p){
  // First run: the shape editor opens on its own with a 20 × 16 m rectangle already filled in.
  await visible(p,button(p,'Create yard'));assert.equal(await p.getByRole('spinbutton',{name:'Width (m)',exact:true}).inputValue(),'20');assert.equal(await p.getByRole('spinbutton',{name:'Depth (m)',exact:true}).inputValue(),'16');await button(p,'Create yard').click();
  await visible(p,fold(p,'Configure workers & equipment · DEMO ONLY'));await fold(p,'Configure workers & equipment · DEMO ONLY').click();await button(p,'Save resources').click();await visible(p,button(p,'Pause simulation'));
  await nav(p,'Account').click();await button(p,'Add synthetic demo catalogue').click();await visible(p,p.getByRole('status').filter({hasText:'Synthetic catalogue added.'}));await button(p,'← Open yard').click();
  await open(p,'Yard (layout plan)','A place for everything.');await fold(p,'Add a stillage or small-parts cage').click();await button(p,'Register stillage / cage').click();await visible(p,p.getByRole('button',{name:/^S-001/}));
  await open(p,'Stock','Stock ledger');await fold(p,'Record original stock (opening balance)').click();await button(p,'Record original stock').click();const opening=await register(p,'DEMO ledger — 2 m');assert.equal(opening['In yard'],'100');assert.equal(opening['At sites'],'0');assert.equal(opening.Total,'100');
  await setupLogistics(p);
}
export async function setupLogistics(p){
  await open(p,'Truck 12.5 tonne','Truck garage');await fold(p,'Add a 12.5 tonne truck').click();await button(p,'Add truck').click();await visible(p,p.getByRole('img',{name:'T-01 truck deck',exact:true}));
  await open(p,'Client sites','Site directory');await fold(p,'Create a site').click();await fill(p,'Site name','Browser demo site');await fill(p,'Address / location','Synthetic test location');await button(p,'Create site').click();await visible(p,p.getByRole('heading',{name:/Browser demo site/}));
  await open(p,'Yard (layout plan)','A place for everything.');await fold(p,'Configure workers & equipment · DEMO ONLY').click();await p.getByRole('combobox',{name:'Location',exact:true}).selectOption({label:'Browser demo site'});await button(p,'Save resources').click();await visible(p,p.getByRole('status').filter({hasText:'Saved.'}));
}
export async function deliverDemo(p){
  await open(p,'Client sites','Site directory');await fold(p,'Quick single-line request').click();await button(p,'Send to yard').click();await visible(p,button(p,'Plan packs & load truck'));await button(p,'Plan packs & load truck').click();await visible(p,p.getByText('ALLOCATED',{exact:true}));await idle(p);
  await dispatchDemo(p);
}
export async function dispatchDemo(p){
  // The truck card reads At the yard → On the road → At site; the fleet strip above it names the destination while it travels.
  await open(p,'Truck 12.5 tonne','Truck garage');assert.equal(await p.getByText('Loaded 550 kg',{exact:true}).count(),1);await button(p,'Dispatch truck').click();await visible(p,p.getByText('To Browser demo site',{exact:true}));await visible(p,p.getByText('At site',{exact:true}));assert.equal(await p.getByText('Loaded 550 kg',{exact:true}).count(),1);await unloadDemo(p);
}
export async function unloadDemo(p){
  await button(p,'Unload at current location').click();await visible(p,p.getByText('1 active tasks',{exact:true}));await idle(p);
  await open(p,'Stock','Stock ledger');const delivered=await register(p,'DEMO ledger — 2 m');assert.equal(delivered['In yard'],'0');assert.equal(delivered['At sites'],'100');assert.equal(delivered['On trucks'],'0');assert.equal(delivered.Total,'100');await open(p,'Client sites','Site directory');await visible(p,p.getByText('DELIVERED',{exact:true}));
}
