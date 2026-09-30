import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openDatabase } from '../src/database.js';
import { Service } from '../src/service.js';
import { Simulation } from '../src/simulation.js';
import { __gm } from '../public/game.js';

// Phase 0, D14: honest labels. The simulated company is the Practice yard and says so, calmly; the catalogue claims match the truth.
function board(t){
  const db=openDatabase(':memory:');t.after(()=>db.close());const auth=new Service(db);
  const user=auth.authenticate(auth.register({name:'Owner',companyName:'Harbour',email:randomUUID()+'@example.com',password:'demonstration-password',systems:['quickstage']}));
  const sim=new Simulation(db,user),cmd=(a,i={})=>sim.execute(a,i,randomUUID());
  const account={company:{id:user.company_id,name:'Harbour'},user:{id:user.id,name:'Owner'},permissions:auth.permissions(user)};
  return {sim,cmd,account,ctx:()=>({state:sim.snapshot(0,{lean:true}),account,hire:true})};
}

test('the board: a small permanent "Practice yard · simulated" chip in the top bar, before and after the yard is set up (no banner)',t=>{
  const f=board(t);__gm.reset();let html=__gm.shell(f.ctx());
  const chip='<span class="gm-practice" title="The crew, trucks and deliveries on this board are simulated. They are not a record of real deliveries.">Practice yard<span class="gm-practice-more"> &middot; simulated</span></span>';
  assert.ok(html.includes(chip),'on the first-run screen');
  f.cmd('gameStart',{size:'M'});html=__gm.shell(f.ctx());assert.ok(html.includes(chip),'on the board');assert.equal(html.split('class="gm-practice"').length-1,1,'once');
  assert.ok(!/simulation-banner/.test(html),'still no banner');
  const css=readFileSync(new URL('../public/game.css',import.meta.url),'utf8');assert.match(css,/\.gm-practice\{/);assert.match(css,/\.gm-practice-more\{display:none\}/,'a phone says just Practice yard');
});

test('the board hint while trucks move says the crew and trucks are simulated; no "Sit back and watch. The crew does it all."',t=>{
  const f=board(t);f.cmd('gameStart',{size:'S'});f.cmd('gameCatalogue',{systems:['quickstage']});
  const p=f.sim.repo.all('product').map(x=>f.sim.effective(x.id)).find(x=>x.unitWeight>0);f.cmd('gameAddStock',{lines:[{product:p.id,quantity:10}]});const site=f.cmd('gameSite',{name:'Bondi'}).site;
  f.cmd('gameSend',{site:site.id,lines:[{product:p.id,quantity:10}]});__gm.reset();const s=f.sim.snapshot(0,{lean:true});__gm.shell({state:s,account:f.account});
  const h=__gm.hint(s);assert.equal(h.id,'watch');assert.equal(h.text,'In the Practice yard the crew and trucks are simulated. Watch them work.');
});

test('the catalogue claims are true: a starter list copied from supplier catalogues, weights as printed; Account no longer says no documents were imported',async t=>{
  const f=board(t);f.cmd('gameStart',{size:'S'});__gm.reset();const s=f.sim.snapshot(0,{lean:true});__gm.shell({state:s,account:f.account});__gm.setMode('parts');
  const parts=__gm.grid(s);assert.ok(parts.includes('We load a starter parts list copied from published supplier catalogues, with the weights as they print them. Check them against your own supplier.'));
  assert.ok(!/real weights|your supplier's own parts list/i.test(parts));
  const r=f.cmd('gameCatalogue',{systems:['quickstage']});assert.equal(r.message,'The starter parts list is loaded. Check the weights against your own supplier.');
  const ops=await import('../public/operations.js');ops.__test.setState(f.sim.snapshot(0,{lean:true}),{...f.account,systems:[]});const acct=ops.catalogueSettings();
  assert.ok(!acct.includes('No manufacturer documents were imported'),'the old, untrue line');assert.match(acct,/copied from supplier documents: Turbo Scaffolding product sheets and the AT-PAC North America 2020 catalogue/);
  const doc=readFileSync(new URL('../CATALOGUE_PROVENANCE.md',import.meta.url),'utf8');
  assert.ok(!doc.includes('No manufacturer source documents were read or imported'),'no longer contradicts the supplier batches section');assert.match(doc,/What "SOURCE VERIFIED" means here/);
});
