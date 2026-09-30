import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase,atomic } from '../src/database.js';
import { Service } from '../src/service.js';
import { Simulation } from '../src/simulation.js';
import { GAME_PAUSED } from '../src/domain/game.js';
import { gpPerStillage } from '../public/game-pick.js';

// Phase 0, D9: Send or Bring back while the yard is paused used to load a truck that then sat still with no sign on the board.
// Now the server refuses at once in plain words and the board's message offers one button: Resume and send (or bring back).
function board(t){
  const db=openDatabase(':memory:');t.after(()=>db.close());const auth=new Service(db);
  const user=auth.authenticate(auth.register({name:'Owner',companyName:'Harbour',email:randomUUID()+'@example.com',password:'demonstration-password',systems:['quickstage']}));
  const sim=new Simulation(db,user),cmd=(a,i={})=>sim.execute(a,i,randomUUID());const {yard}=cmd('gameStart',{size:'S'});cmd('gameCatalogue',{systems:['quickstage']});
  const lift=sim.gameLift(yard),p=sim.repo.all('product').map(x=>sim.effective(x.id)).find(x=>x.unitWeight>0&&gpPerStillage(x,lift)>=10);
  const account={company:{id:user.company_id,name:'Harbour'},user:{id:user.id,name:'Owner'},permissions:auth.permissions(user)};
  return {db,sim,cmd,yard,p,per:gpPerStillage(p,lift),account,tick:n=>{for(let i=0;i<n;i++)atomic(db,()=>sim.tick(1000));}};
}
const loading=f=>f.sim.repo.all('truck').filter(t=>t.game);

test('paused: Send and Bring back are refused at once in plain words, nothing is loaded; Add stock still lands; resumed, Send goes',t=>{
  const f=board(t);f.cmd('gameAddStock',{lines:[{product:f.p.id,quantity:f.per*2}]});const site=f.cmd('gameSite',{name:'Bondi'}).site;
  f.cmd('pause',{paused:true});
  assert.throws(()=>f.cmd('gameSend',{site:site.id,lines:[{product:f.p.id,quantity:f.per}]}),e=>e.message===GAME_PAUSED);
  assert.equal(GAME_PAUSED,"The yard is paused, so the trucks can't go.");assert.equal(loading(f).length,0,'no truck was loaded to sit still');
  assert.throws(()=>f.cmd('gameCollect',{site:site.id,all:true}),e=>e.message===GAME_PAUSED);
  const r=f.cmd('gameAddStock',{lines:[{product:f.p.id,quantity:f.per}]});assert.match(r.message,/added to the yard/,'Add stock lands straight away, paused or not');
  f.cmd('pause',{paused:false});const s=f.cmd('gameSend',{site:site.id,lines:[{product:f.p.id,quantity:f.per}]});assert.match(s.message,/is loading for Bondi/);assert.equal(loading(f).length,1);
});

test('the board: the paused answer shows the words with one Resume button that resumes the yard and then sends what was asked',async t=>{
  const f=board(t);f.cmd('gameAddStock',{lines:[{product:f.p.id,quantity:f.per}]});const site=f.cmd('gameSite',{name:'Bondi'}).site;f.cmd('pause',{paused:true});
  const {__gm}=await import('../public/game.js');const had=globalThis.document;globalThis.document={querySelector:()=>null,querySelectorAll:()=>[]};t.after(()=>{globalThis.document=had;__gm.setCtx(null);});
  const said=[],sent=[];const ctx={state:f.sim.snapshot(0,{lean:true}),account:f.account,cmd:async(a,d)=>{sent.push(a);return f.cmd(a,d);},refresh:async()=>{},notify:m=>said.push(m)};__gm.setCtx(ctx);
  let done=null;const out=await __gm.run('gameSend',{site:site.id,lines:[{product:f.p.id,quantity:f.per}]},r=>{done=r;});
  assert.equal(out,null);assert.equal(done,null);assert.deepEqual(said,[],'not the plain error line: the board message with its button');
  const g=__gm.state();assert.equal(g.resume.action,'gameSend');
  const html=__gm.popInner(GAME_PAUSED,'warn','Resume and send');assert.match(html,/The yard is paused, so the trucks can&#39;t go\.|The yard is paused, so the trucks can't go\./);assert.match(html,/<button type="button" class="gm-pop-act" data-gm-resume>Resume and send<\/button>/);
  await __gm.resumeAndGo({closest:()=>null});
  assert.deepEqual(sent,['gameSend','pause','gameSend']);assert.equal(f.sim.repo.all('config')[0].paused,false,'resumed');assert.match(done.message,/is loading for Bondi/,'and sent');assert.equal(g.resume,null);
  // any other refusal is still the plain line it always was
  await __gm.run('gameSend',{site:site.id,lines:[{product:f.p.id,quantity:9999999}]});assert.equal(said.length,1);
});
