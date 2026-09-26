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
// Re-reads the page until check() returns true (the page re-renders from its own poll), so a stale render is never read as the answer.
async function until(p,check,what,timeout=45000){
  const deadline=Date.now()+timeout;let last;
  for(;;){if(p.domSnapshot)await p.domSnapshot();try{last=await check();if(last===true)return;}catch(e){last=e.message;}if(Date.now()>deadline)throw new Error(`${what} did not happen before the deadline (last seen: ${JSON.stringify(last)}).`);await new Promise(resolve=>setTimeout(resolve,250));}
}
// Waits until the Stock register row for the product shows these figures.
async function stockIs(p,product,want){await until(p,async()=>{const row=await register(p,product);return Object.entries(want).every(([k,v])=>row[k]===v)||row;},`${product} register ${JSON.stringify(want)}`);}
// Clicks a button that sends one command and waits for the server's answer (Playwright); a driver without waitForResponse waits for the given sign instead.
async function sent(p,name,click,sign){
  if(!p.waitForResponse){await click();return visible(p,sign);}
  const [res]=await Promise.all([p.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/commands/'+name,{timeout:45000}),click()]);
  assert.ok(res.ok(),`${name} was refused: ${await res.text()}`);await visible(p,sign);
}
export async function setupDemo(p,email){
  await fill(p,'Company name','Automated browser DEMO');await fill(p,'Your name','Test Owner');await fill(p,'Email',email);await fill(p,'Password','Local-demo-test-2026!');await p.getByRole('checkbox',{name:'Quickstage',exact:true}).check();await button(p,'Create company').click();
  await setupYard(p);
}
export async function setupYard(p){
  // First run: the shape editor opens on its own with a 20 × 16 m rectangle already filled in. Creating the yard lands an operations user on Home, with the set-up guide.
  await visible(p,button(p,'Create yard'));assert.equal(await p.getByRole('spinbutton',{name:'Width (m)',exact:true}).inputValue(),'20');assert.equal(await p.getByRole('spinbutton',{name:'Depth (m)',exact:true}).inputValue(),'16');await button(p,'Create yard').click();
  await visible(p,p.getByRole('heading',{level:2,name:'Set up your real yard',exact:true}));
  await open(p,'Yard (layout plan)','Yard layout');await fold(p,'Configure workers & equipment · DEMO ONLY').click();await sent(p,'resources',()=>button(p,'Save resources').click(),p.getByRole('status').filter({hasText:'Saved.'}));
  await nav(p,'Account').click();await sent(p,'seed',()=>button(p,'Add synthetic demo catalogue').click(),p.getByRole('status').filter({hasText:'Synthetic catalogue added.'}));await button(p,'← Open yard').click();await visible(p,nav(p,'Stock'));
  await open(p,'Yard (layout plan)','Yard layout');await fold(p,'Add a stillage or small-parts cage').click();await button(p,'Register stillage / cage').click();await visible(p,p.getByRole('button',{name:/^S-001/}));
  await open(p,'Stock','Stock ledger');await fold(p,'Record original stock (opening balance)').click();await sent(p,'opening',()=>button(p,'Record original stock').click(),p.getByRole('status').filter({hasText:'Saved.'}));await stockIs(p,'DEMO ledger — 2 m',{'In yard':'100','At sites':'0',Total:'100'});
  await setupLogistics(p);
}
export async function setupLogistics(p){
  await open(p,'Truck 12.5 tonne','Truck garage');await fold(p,'Add a 12.5 tonne truck').click();await button(p,'Add truck').click();await visible(p,p.getByRole('img',{name:'T-01 truck deck',exact:true}));
  await open(p,'Client sites','Site directory');await fold(p,'Create a site').click();await fill(p,'Site name','Browser demo site');await fill(p,'Address / location','Synthetic test location');await button(p,'Create site').click();await visible(p,p.getByRole('heading',{name:/Browser demo site/}));
  await open(p,'Yard (layout plan)','Yard layout');await fold(p,'Configure workers & equipment · DEMO ONLY').click();await p.getByRole('combobox',{name:'Location',exact:true}).selectOption({label:'Browser demo site'});await sent(p,'resources',()=>button(p,'Save resources').click(),p.getByRole('status').filter({hasText:'Saved.'}));
}
export async function deliverDemo(p){
  await open(p,'Client sites','Site directory');await fold(p,'Quick single-line request').click();await button(p,'Send to yard').click();await visible(p,button(p,'Plan packs & load truck'));await p.getByRole('combobox',{name:'Loading truck',exact:true}).selectOption({label:'T-01'});await button(p,'Plan packs & load truck').click();await visible(p,p.getByText('ALLOCATED',{exact:true}));await idle(p);
  await dispatchDemo(p);
}
export async function dispatchDemo(p){
  // The truck card reads At the yard → On the road → At site (the trip takes a few seconds of simulation), so the test checks the dispatch answer rather than the short On-the-road moment.
  await open(p,'Truck 12.5 tonne','Truck garage');assert.equal(await p.getByText('Loaded 550 kg',{exact:true}).count(),1);
  await sent(p,'dispatch',()=>button(p,'Dispatch truck').click(),p.getByText('At site',{exact:true}));assert.equal(await p.getByText('Loaded 550 kg',{exact:true}).count(),1);await unloadDemo(p);
}
export async function unloadDemo(p){
  await sent(p,'unload',()=>button(p,'Unload at current location').click(),p.getByRole('heading',{name:'Movement activity',exact:true}));
  await open(p,'Stock','Stock ledger');await stockIs(p,'DEMO ledger — 2 m',{'In yard':'0','At sites':'100','On trucks':'0',Total:'100'});await open(p,'Client sites','Site directory');await visible(p,p.getByText('DELIVERED',{exact:true}));
}
