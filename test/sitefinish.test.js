import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase,atomic } from '../src/database.js';
import { Service } from '../src/service.js';
import { Simulation } from '../src/simulation.js';
import { sfBlock,sfAsk,sfTies,sfActs,sfSub,sfSendable,sfTile,sfBelowTiles,sfNewSiteList,sfOfficeActs,sfFinishedHTML,sfClick,__sf } from '../public/game-finish.js';
import { __gm } from '../public/game.js';

// Remove site (src/domain/sitefinish.js, public/game-finish.js), on a small yard made the way the board makes it.
function game(t){
  const db=openDatabase(':memory:');t.after(()=>db.close());const auth=new Service(db);
  const user=auth.authenticate(auth.register({name:'Owner',companyName:'Demo',email:randomUUID()+'@example.com',password:'demonstration-password',systems:['quickstage']}));
  const sim=new Simulation(db,user);const cmd=(action,input={},key=randomUUID())=>sim.execute(action,input,key);
  const start=cmd('gameStart',{size:'S'});const c=sim.repo.all('config')[0];Object.assign(c,{stepMs:100,speed:100000,jobs:false,routineJobs:false});sim.repo.save(c);
  const tick=(n=1,ms=1000)=>{for(let i=0;i<n;i++)atomic(db,()=>sim.tick(ms));};
  const until=(fn,n=600)=>{for(let i=0;i<n;i++){if(fn())return true;tick(1);}return fn();};
  const truck=id=>sim.repo.get(id,'truck'),site=id=>sim.repo.get(id,'site');
  const total=()=>db.prepare('SELECT COALESCE(SUM(quantity),0) n FROM contents WHERE company_id=?').get(user.company_id).n;
  const at=(loc,product)=>sim.containers().filter(x=>x.location===loc).reduce((n,x)=>n+sim.repo.quantity(x.id,product),0);
  const stock=q=>{const demo=cmd('seed');const p=demo.find(x=>sim.effective(x.id).packQuantity===100);cmd('gameAddStock',{lines:[{product:p.id,quantity:q}]});return p;};
  const idle=()=>sim.repo.all('truck').every(x=>!x.game&&x.status==='AT_YARD');
  const supervisor=()=>{auth.addUser(user,{name:'Sup',email:'sup-'+randomUUID()+'@example.com',password:'demonstration-password',roles:['SUPERVISOR']});const u=db.prepare("SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE r.role='SUPERVISOR' ORDER BY u.rowid DESC LIMIT 1").get();return new Simulation(db,{id:u.id,company_id:user.company_id,name:'Sup'});};
  // a site that was used and is empty again: stock sent, then all brought back
  const usedEmpty=(name,p)=>{const s=cmd('gameSite',{name}).site;cmd('gameSend',{site:s.id,lines:[{product:p.id,quantity:100}]});assert.ok(until(()=>idle()));cmd('gameCollect',{site:s.id,all:true});assert.ok(until(()=>idle()&&at(s.id,p.id)===0));return s;};
  return {db,auth,user,sim,cmd,tick,until,truck,site,total,at,stock,idle,supervisor,usedEmpty,yard:start.yard};
}
// The ledger's stock rows (custody: every piece in and out) and the contents table, to compare before and after.
const custody=f=>({ledger:f.db.prepare("SELECT sequence,event,product_id,container_id,quantity,source,destination FROM ledger WHERE company_id=? AND event NOT IN ('COMMAND','SITE_REMOVED','SITE_MAP','SITE_RESTORED') ORDER BY sequence").all(f.user.company_id),contents:f.db.prepare('SELECT container_id,product_id,quantity FROM contents WHERE company_id=? ORDER BY container_id,product_id').all(f.user.company_id)});
const lotOf=(f,id)=>{const p=f.sim.worldLayoutNow().byId.get(id);return p?[p.col,p.row]:null;};

test('a site never used goes completely at once: its crane, crew and map block go, the ledger and stock are untouched; Undo puts it back in its block',t=>{
  const f=game(t);const p=f.stock(200);const keep=f.cmd('gameSite',{name:'Keep St'}).site;
  const before=custody(f),keepLot=lotOf(f,keep.id);
  const {site}=f.cmd('gameSite',{name:'George St',address:'1 George St'});const lot=lotOf(f,site.id);assert.ok(lot);
  assert.equal(f.sim.repo.all('resource').filter(r=>r.location===site.id).length,3,'crane and two workers');
  const r=f.cmd('gameRemoveSite',{site:site.id});assert.equal(r.removed,true);assert.equal(r.message,'George St removed');
  assert.equal(typeof r.undo,'string','a copy is kept for Undo');
  assert.throws(()=>f.sim.repo.get(site.id,'site'),/not found/,'the site is gone');assert.equal(f.sim.repo.all('resource').filter(r=>r.location===site.id).length,0,'its crane and crew too');
  const after=f.sim.worldLayoutNow();assert.equal(after.byId.get(site.id),undefined);assert.ok(!after.places.some(x=>x.col===lot[0]&&x.row===lot[1]),'its block is free again');
  assert.deepEqual(lotOf(f,keep.id),keepLot,'the other site stays where it was');
  assert.deepEqual(custody(f),before,'no stock moved and no custody row changed');assert.equal(f.at(f.yard.id,p.id),200);
  assert.ok(f.db.prepare("SELECT 1 FROM ledger WHERE company_id=? AND event='SITE_REMOVED' AND reason LIKE '%George St%'").get(f.user.company_id),'the removal is noted');
  // Undo: the very same site back, in the same block, with its crane and crew
  const back=f.cmd('gameRestoreSite',{undo:r.undo});assert.equal(back.message,'George St is back on the map.');assert.equal(back.site.id,site.id,'the same site');
  assert.deepEqual(lotOf(f,site.id),lot);assert.equal(f.site(site.id).address,'1 George St');assert.equal(f.sim.repo.all('resource').filter(r=>r.location===site.id).length,3);
  assert.deepEqual(custody(f),before,'Undo moves no stock either');assert.throws(()=>f.cmd('gameRestoreSite',{undo:r.undo}),/can no longer be put back/,'once');
  f.cmd('gameRemoveSite',{site:site.id});
  // a site made in the Office goes the same way while unused; a Send only waiting for a truck does not count as use
  const o=f.cmd('site',{name:'Office made'});assert.equal(f.cmd('gameRemoveSite',{site:o.id}).removed,true);
  const w=f.cmd('gameSite',{name:'Waiting'}).site;const busy=f.sim.repo.all('truck');for(const x of busy){x.game={kind:'HOLD'};f.sim.repo.save(x);}
  assert.ok(f.cmd('gameSend',{site:w.id,lines:[{product:p.id,quantity:100}]}).queued);for(const x of busy){const y=f.truck(x.id);y.game=null;f.sim.repo.save(y);}
  assert.equal(f.cmd('gameRemoveSite',{site:w.id}).removed,true);assert.equal(f.sim.repo.all('gameOrder').length,0,'the waiting Send is dropped');
});

test('a used site with nothing there goes off the map at once and is kept as history; Undo (Open again) brings it back',t=>{
  const f=game(t);const p=f.stock(200);const site=f.usedEmpty('Kent St',p);const lot=lotOf(f,site.id);
  const r=f.cmd('gameRemoveSite',{site:site.id});assert.equal(r.archived,true);assert.equal(r.message,'Kent St removed');
  const s=f.site(site.id);assert.equal(s.status,'ARCHIVED');assert.ok(s.finishedAt);assert.equal(lotOf(f,site.id),null,'off the map straight away');
  assert.ok(f.sim.repo.all('delivery').some(d=>d.to===site.id),'its trips are all still there');
  assert.ok(f.sim.repo.all('resource').filter(x=>x.location===site.id).every(x=>!x.enabled&&x.finishedOff),'its crane and crew leave');
  assert.throws(()=>f.cmd('gameRemoveSite',{site:site.id}),/already removed/);assert.throws(()=>f.cmd('gameSend',{site:site.id,lines:[{product:p.id,quantity:1}]}),/active site/);
  const back=f.cmd('gameReopen',{site:site.id});assert.equal(back.message,'Kent St is back on the map.');assert.equal(f.site(site.id).status,'ACTIVE');assert.deepEqual(lotOf(f,site.id),lot,'in its own block again');
  const crew=f.sim.repo.all('resource').filter(x=>x.location===site.id);assert.equal(crew.filter(x=>x.enabled&&x.type==='CRANE').length,1);assert.ok(crew.every(x=>!x.finishedOff));
  assert.throws(()=>f.cmd('gameReopen',{site:site.id}),/already open/);
});

test('Open again finds a free block when its old one was taken meanwhile',t=>{
  const f=game(t);const p=f.stock(100);const site=f.usedEmpty('Short job',p);const lot=lotOf(f,site.id);f.cmd('gameRemoveSite',{site:site.id});
  const other=f.cmd('gameSite',{name:'Newcomer',col:lot[0],row:lot[1]}).site;assert.deepEqual(lotOf(f,other.id),lot);
  f.cmd('gameReopen',{site:site.id});const q=f.sim.worldLayoutNow().byId.get(site.id);assert.ok(q&&!q.archived);assert.notDeepEqual([q.col,q.row],lot,'a free block');
  assert.deepEqual(lotOf(f,other.id),lot,'the newcomer stays put');assert.deepEqual(f.site(site.id).map,{col:q.col,row:q.row},'pinned there');
  f.cmd('gameSend',{site:site.id,lines:[{product:p.id,quantity:100}]});assert.ok(f.until(()=>f.idle()&&f.at(site.id,p.id)===100),'it works again');
});

test('scaffold still on the site: asked first; then everything comes home on the board trucks (more than one load) and the site goes by itself',t=>{
  const f=game(t);const p=f.stock(1300);const {site}=f.cmd('gameSite',{name:'Tower'});const total=f.total();
  f.cmd('gameSend',{site:site.id,lines:[{product:p.id,quantity:1300}]});assert.ok(f.until(()=>f.idle()&&!f.sim.repo.all('gameOrder').length,4000));
  assert.ok(f.at(site.id,p.id)>0,'stock on site');
  assert.throws(()=>f.cmd('gameRemoveSite',{site:site.id}),/Tower still has scaffold on it\. Bring it all back and remove the site\?/);assert.equal(f.site(site.id).finishing,undefined,'nothing started');
  const r=f.cmd('gameRemoveSite',{site:site.id,bringBack:true});assert.equal(r.removing,true);assert.match(r.message,/Bringing everything back from Tower/);
  assert.ok(f.site(site.id).finishing,'marked');assert.equal(f.site(site.id).status,'ACTIVE');
  assert.ok(f.sim.repo.all('truck').some(x=>x.game?.kind==='COLLECT'&&x.game.site===site.id),'a truck is on its way');
  assert.equal(f.cmd('gameRemoveSite',{site:site.id}).removing,true,'a second tap changes nothing');
  assert.throws(()=>f.cmd('gameSend',{site:site.id,lines:[{product:p.id,quantity:1}]}),/being removed\. Tap Keep it first/);
  assert.ok(f.until(()=>f.site(site.id).status==='ARCHIVED',6000),'archived when the last stillage is home');
  assert.equal(f.at(site.id,p.id),0);assert.equal(f.at(f.yard.id,p.id),1300);assert.equal(f.total(),total,'nothing appears or disappears');
  assert.ok(f.sim.repo.all('collection').filter(o=>o.site===site.id).length>=2,'more than one truckload');assert.ok(f.idle());
  assert.ok(f.sim.repo.all('notification').some(n=>n.title==='Site removed'&&n.body==='Tower is finished and removed.'));
  assert.ok(f.db.prepare("SELECT 1 FROM ledger WHERE company_id=? AND event='SITE_FINISHING'").get(f.user.company_id));
  assert.equal(f.sim.repo.all('gameOrder').length,0);assert.equal(lotOf(f,site.id),null,'gone from the map once the trucks are home');
  // the pure question, as the board shows it
  assert.equal(sfAsk({name:'Q St'},true),'Q St still has scaffold on it. Bring it all back and remove the site?');assert.match(sfAsk({name:'Q St'},false),/^A truck is still busy for Q St\./);
});

test('a Send still loading when the site is removed comes straight home; waiting Sends are dropped',t=>{
  const f=game(t);const p=f.stock(400);const {site}=f.cmd('gameSite',{name:'Pier'});
  f.cmd('gameSend',{site:site.id,lines:[{product:p.id,quantity:100}]});assert.ok(f.until(()=>f.idle()));
  const s=f.cmd('gameSend',{site:site.id,lines:[{product:p.id,quantity:100}]});const id=s.trucks[0].id;assert.equal(f.truck(id).game.stage,'LOADING');
  const busy=f.sim.repo.all('truck').filter(x=>x.id!==id);for(const x of busy){x.game={kind:'HOLD'};f.sim.repo.save(x);}
  const w=f.cmd('gameSend',{site:site.id,lines:[{product:p.id,quantity:100}]});assert.ok(w.queued);for(const x of busy){const y=f.truck(x.id);y.game=null;f.sim.repo.save(y);}
  f.cmd('gameRemoveSite',{site:site.id,bringBack:true});assert.ok(!f.sim.repo.all('gameOrder').some(o=>o.type==='SEND'),'the waiting Send is dropped');
  assert.ok(f.until(()=>f.site(site.id).status==='ARCHIVED',3000));assert.equal(f.at(f.yard.id,p.id),400,'the loaded Send went back into the yard');
  assert.equal(f.sim.repo.all('delivery').filter(d=>d.to===site.id&&d.containers.length).length,1,'only the first Send ever took stock there');
});

test('a Send already on the road when the site is removed turns round at the gate: its load is never set down there',t=>{
  const f=game(t);const p=f.stock(200);const {site}=f.cmd('gameSite',{name:'Dock'});f.cmd('gameSend',{site:site.id,lines:[{product:p.id,quantity:100}]});assert.ok(f.until(()=>f.idle()));
  const s=f.cmd('gameSend',{site:site.id,lines:[{product:p.id,quantity:100}]}),id=s.trucks[0].id;assert.ok(f.until(()=>f.truck(id).status==='IN_TRANSIT'));
  f.cmd('gameRemoveSite',{site:site.id,bringBack:true});
  assert.ok(f.until(()=>f.site(site.id).status==='ARCHIVED',3000));assert.equal(f.at(f.yard.id,p.id),200);assert.equal(f.at(site.id,p.id),0);
  assert.equal(f.sim.repo.all('notification').filter(n=>n.title==='Delivered').length,1,'no second Delivered');
});

test('Keep it stops the removing: what came back stays back, a truck driving out empty turns round, nothing is archived',t=>{
  const f=game(t);const p=f.stock(200);const {site}=f.cmd('gameSite',{name:'Bay Rd'});
  f.cmd('gameSend',{site:site.id,lines:[{product:p.id,quantity:200}]});assert.ok(f.until(()=>f.idle()));
  f.cmd('gameRemoveSite',{site:site.id,bringBack:true});const t0=f.sim.repo.all('truck').find(x=>x.game?.kind==='COLLECT');assert.equal(t0.game.stage,'OUTBOUND');
  const r=f.cmd('gameKeepOpen',{site:site.id});assert.equal(r.message,'Bay Rd stays.');assert.equal(f.site(site.id).finishing,null);
  assert.equal(f.sim.repo.get(t0.game.collection,'collection').status,'CANCELLED','its collection is cancelled');
  assert.ok(f.until(()=>f.idle(),800),'the truck comes home');assert.equal(f.at(site.id,p.id),200,'the stock stays on site');assert.equal(f.site(site.id).status,'ACTIVE');
  f.tick(20);assert.equal(f.site(site.id).status,'ACTIVE','and it is never archived by itself');assert.throws(()=>f.cmd('gameKeepOpen',{site:site.id}),/not being removed/);
  f.cmd('gameRemoveSite',{site:site.id,bringBack:true});assert.ok(f.until(()=>f.site(site.id).status==='ARCHIVED',3000));assert.equal(f.at(f.yard.id,p.id),200);
});

test('what blocks removing is said in plain words (the same rule on the board): a stocktake, a truck run by hand, an Office booking',t=>{
  const f=game(t);const p=f.stock(200);const {site}=f.cmd('gameSite',{name:'Hill St'});f.cmd('gameSend',{site:site.id,lines:[{product:p.id,quantity:100}]});assert.ok(f.until(()=>f.idle()));
  const count=f.cmd('count',{scope:site.id});assert.throws(()=>f.cmd('gameRemoveSite',{site:site.id,bringBack:true}),/A stocktake is open at Hill St\. Finish it first\./);assert.equal(f.site(site.id).finishing,undefined);
  f.cmd('cancelCount',{id:count.id});
  const hand=f.sim.repo.all('truck')[0];f.cmd('dispatch',{id:hand.id,destination:site.id});assert.throws(()=>f.cmd('gameRemoveSite',{site:site.id,bringBack:true}),/A truck run by hand is on its way to Hill St/);
  assert.ok(f.until(()=>f.truck(hand.id).status==='AT_SITE'));const b=f.sim.sfBlockFor(f.site(site.id));assert.equal(b.fix.act,'home');assert.equal(b.fix.truck,hand.id);
  f.cmd('dispatch',{id:hand.id,destination:f.yard.id});assert.ok(f.until(()=>f.truck(hand.id).status==='AT_YARD'));
  const req=f.cmd('request',{site:site.id,product:p.id,quantity:10});assert.throws(()=>f.cmd('gameRemoveSite',{site:site.id,bringBack:true}),/A delivery to Hill St is booked in the Office/);
  f.cmd('cancelRequest',{id:req.id,reason:'test'});
  const col=f.cmd('requestCollection',{site:site.id,neededOn:f.sim.calendar().today});assert.throws(()=>f.cmd('gameRemoveSite',{site:site.id,bringBack:true}),/A collection from Hill St is booked in the Office/);
  f.cmd('cancelCollection',{id:col.id});assert.equal(f.cmd('gameRemoveSite',{site:site.id,bringBack:true}).removing,true);
  const s={id:'S',name:'Q St'};assert.equal(sfBlock(s,{}),null);
  assert.equal(sfBlock(s,{counts:[{state:'OPEN',scope:'C1'}],here:new Set(['C1'])}).fix.view,'STOCK','a stocktake of a stillage there counts');
  assert.equal(sfBlock(s,{trucks:[{id:'T',status:'AT_SITE',at:'S',game:{kind:'COLLECT',site:'S'}}]}),null,'a board truck is not in the way');
  assert.equal(sfBlock(s,{collections:[{id:'O',site:'S',status:'BOOKED'}],trucks:[{id:'T',game:{collection:'O'}}]}),null,'the board\'s own collection is fine');
});

test('supervisors cannot remove, keep or re-open a site; commands are idempotent',t=>{
  const f=game(t);const p=f.stock(100);const site=f.usedEmpty('Guarded',p);const sup=f.supervisor();
  for(const a of ['gameRemoveSite','gameKeepOpen','gameReopen'])assert.throws(()=>sup.execute(a,{site:site.id,bringBack:true},randomUUID()),/does not allow/,a);
  assert.equal(f.site(site.id).status,'ACTIVE');
  const key=randomUUID(),a=f.cmd('gameRemoveSite',{site:site.id},key),b=f.cmd('gameRemoveSite',{site:site.id},key);assert.deepEqual(b,a);assert.equal(a.archived,true);
  const k2=randomUUID(),c=f.cmd('gameReopen',{site:site.id},k2);assert.deepEqual(f.cmd('gameReopen',{site:site.id},k2),c);assert.equal(f.site(site.id).status,'ACTIVE');
  const {site:s2}=f.cmd('gameSite',{name:'Twice'});const k3=randomUUID(),r=f.cmd('gameRemoveSite',{site:s2.id},k3);assert.deepEqual(f.cmd('gameRemoveSite',{site:s2.id},k3),r);assert.equal(r.removed,true);
  assert.throws(()=>f.cmd('gameKeepOpen',{site:site.id},k3),/different action/);
});

test('the board: Remove under every site tile, in the new-site window, in the site window and the Office; one calm question with stock; Removing and Keep it',t=>{
  const f=game(t);const p=f.stock(200);const {site}=f.cmd('gameSite',{name:'George St'});const other=f.cmd('gameSite',{name:'Kent St'}).site;__sf.reset();
  const account={company:{id:f.user.company_id,name:'Demo'},user:{id:f.user.id,name:'Owner'},permissions:f.auth.permissions(f.user)};
  const snap=()=>f.sim.snapshot(0,{lean:true}),siteIn=s=>s.sites.find(x=>x.id===site.id);let s=snap();
  __gm.reset();__gm.shell({state:s,account,hire:true});
  // the Send window: every tile has its Remove, next to + New site
  __gm.setMode('send',site.id);let head=__gm.head(s);
  for(const x of [site,other])assert.ok(head.includes('data-sf-remove="'+x.id+'" aria-label="Remove '+x.name+'"'),x.name);assert.match(head,/data-gm-newsite/);assert.match(head,/<span>Remove site<\/span>/);assert.ok(!/<span>Remove<\/span>/.test(head),'never just "Remove" (the part line has its own)');
  assert.equal(sfTile(siteIn(s),'TILE',false),'TILE','nothing for someone who cannot run the yard');
  // the new-site window lists the sites already on the map, each with Remove
  const nw=sfNewSiteList(s,s.sites,true);assert.match(nw,/Already on the map/);assert.ok(nw.includes('data-sf-remove="'+site.id+'"')&&nw.includes('data-sf-remove="'+other.id+'"'));assert.equal(sfNewSiteList(s,[],true),'');
  // the site window: Remove site under Send here / Bring back
  __gm.setMode('site',site.id);let acts=__gm.acts(s);assert.match(acts,/Send here/);assert.match(acts,/data-sf-remove="/);assert.match(acts,/Remove site/);assert.match(acts,/class="sf-bin"/);
  assert.equal(sfActs(s,siteIn(s),false,'BASE'),'BASE');
  // the Office card
  assert.match(sfOfficeActs(s,siteIn(s)),/data-sf-remove=".*Remove site/);
  f.cmd('gameSend',{site:site.id,lines:[{product:p.id,quantity:100}]});assert.ok(f.until(()=>f.idle()));s=snap();acts=__gm.acts(s);assert.match(acts,/Remove site/,'still there once used');
  assert.ok(!/style="/.test(acts+head+nw),'no inline styles (CSP)');
  // a tap asks first when there is stock, in place, and the same question shows under the tiles
  const api={ctx:{state:s,cmd:()=>{throw new Error('not yet');}},refresh:()=>{},pop:()=>{},gone:()=>{}};
  assert.equal(sfClick({dataset:{sfRemove:site.id},closest:()=>null},api),true);acts=__gm.acts(s);
  assert.match(acts,/George St still has scaffold on it\. Bring it all back and remove the site\?/);assert.match(acts,/data-sf-sure=/);assert.match(acts,/Bring it back and remove/);assert.match(acts,/Keep it/);assert.ok(!/Send here/.test(acts),'one question, nothing else');
  assert.match(sfBelowTiles(s,s.sites,other.id,true),/still has scaffold on it/);
  sfClick({dataset:{sfNo:''},closest:()=>null},api);assert.match(__gm.acts(s),/Send here/);assert.equal(sfBelowTiles(s,s.sites,other.id,true),'');
  // a stocktake: its words and the one button that fixes it
  const count=f.cmd('count',{scope:site.id});s=snap();api.ctx.state=s;sfClick({dataset:{sfRemove:site.id},closest:()=>null},api);acts=__gm.acts(s);
  assert.match(acts,/A stocktake is open at George St\. Finish it first\./);assert.match(acts,/data-sf-fix=/);assert.match(acts,/Open the stocktake/);
  sfClick({dataset:{sfNo:''},closest:()=>null},api);f.cmd('cancelCount',{id:count.id});
  // removing: the words, Keep it, and no Send to it
  f.cmd('gameRemoveSite',{site:site.id,bringBack:true});s=snap();assert.equal(sfSub(siteIn(s)),'Removing — bringing it all home');assert.match(__gm.head(s),/Removing — bringing it all home/);
  acts=__gm.acts(s);assert.match(acts,/still there/,'the window title already says Removing');assert.ok(!/Bringing it all home/.test(acts),'said once');assert.match(acts,/data-sf-keep=/);assert.match(acts,/>Keep it</);assert.ok(!/Send here|Remove site/.test(acts));
  assert.match(sfOfficeActs(s,siteIn(s)),/data-sf-keep=/);
  assert.equal(sfSendable(siteIn(s)),false,'Send does not offer it');__gm.setMode('send',other.id);assert.ok(!__gm.head(s).includes('data-gm-site="'+site.id+'"'));
  __gm.setMode('back',site.id);head=__gm.head(s);assert.match(head,/Removing&hellip;/);assert.match(head,/Removing — bringing it all home/,'the picked site says so under the tiles');
  assert.ok(f.until(()=>f.site(site.id).status==='ARCHIVED',3000));s=snap();
  const office=sfFinishedHTML(s.sites,true);assert.match(office,/Removed \/ finished sites/);assert.match(office,/George St/);assert.match(office,/data-sf-reopen="/);assert.match(office,/Open again/);
  assert.ok(!sfFinishedHTML(s.sites,false).includes('data-sf-reopen'),'a supervisor only sees the list');assert.equal(sfFinishedHTML([],true),'');
});

test('the map says a site is being removed on its tag',async t=>{
  const f=game(t);const p=f.stock(100);const {site}=f.cmd('gameSite',{name:'Wharf'});f.cmd('gameSend',{site:site.id,lines:[{product:p.id,quantity:100}]});assert.ok(f.until(()=>f.idle()));
  f.cmd('gameRemoveSite',{site:site.id,bringBack:true});const s=f.sim.snapshot(0,{lean:true,world:'1'});assert.ok(s.sites.find(x=>x.id===site.id).finishing,'the snapshot carries it for the tag');
  const src=(await import('node:fs')).readFileSync(new URL('../public/world.js',import.meta.url),'utf8');assert.match(src,/Removing — bringing it all home/);
  assert.ok(f.until(()=>f.site(site.id).status==='ARCHIVED',3000));assert.equal(f.sim.snapshot(0,{world:'1'}).world.lots[site.id],undefined,'then it goes');
});

test('the board new module is served to the browser (every module game.js and operations.js import is)',async()=>{
  const {readFileSync}=await import('node:fs'),read=f=>readFileSync(new URL('../'+f,import.meta.url),'utf8'),server=read('src/server.js');
  for(const f of ['public/game.js','public/operations.js'])for(const m of read(f).matchAll(/from '\.\/([\w-]+\.js)'/g))assert.ok(server.includes("'/"+m[1]+"':"),m[1]+' is served');
  assert.match(read('public/game.css'),/Site undo and finish/);assert.ok(!/style="/.test(read('public/game-finish.js')),'no inline styles (CSP)');
});

// ---------- review fixes ----------
test('Undo of a never-used site puts back the very same site: its Office details, its drawn shape, its id; in a free block when its own was taken',t=>{
  const f=game(t);f.stock(100);
  const o=f.cmd('site',{name:'Office Job',address:'9 Main Rd',client:'BuildCo',contact:'Jan',phone:'0400'});const full=f.site(o.id);
  const shaped={...full,points:[{x:0,y:0},{x:30000,y:0},{x:30000,y:9000},{x:0,y:9000}],height:12000};f.sim.repo.save(shaped);const want=f.site(o.id);
  const lot=lotOf(f,o.id);const r=f.cmd('gameRemoveSite',{site:o.id});assert.equal(r.removed,true);
  assert.equal(f.sim.repo.all('site').some(x=>x.id===o.id),false,'gone from every list');
  const other=f.cmd('gameSite',{name:'Took it',col:lot[0],row:lot[1]}).site;assert.deepEqual(lotOf(f,other.id),lot);
  const back=f.cmd('gameRestoreSite',{undo:r.undo});assert.equal(back.site.id,o.id);const s=f.site(o.id);
  for(const k of ['name','address','client','contact','phone','points','height','gate','loading','supervisor'])assert.deepEqual(s[k],want[k],k);
  assert.equal(s.status,'ACTIVE');const q=lotOf(f,o.id);assert.ok(q);assert.notDeepEqual(q,lot,'a free block');assert.deepEqual(lotOf(f,other.id),lot,'the newcomer stays');
  assert.throws(()=>f.cmd('gameRestoreSite',{undo:'nope'}),/can no longer be put back/);
  const sup=f.supervisor();const r2=f.cmd('gameRemoveSite',{site:o.id});assert.throws(()=>sup.execute('gameRestoreSite',{undo:r2.undo},randomUUID()),/does not allow/);
  const k=randomUUID(),a=f.cmd('gameRestoreSite',{undo:r2.undo},k);assert.deepEqual(f.cmd('gameRestoreSite',{undo:r2.undo},k),a,'idempotent');
});

test('the question matches what is happening: a Send loading, a Send on the road, scaffold there; only the last load driving home: no question at all',t=>{
  const f=game(t);const p=f.stock(400);const {site}=f.cmd('gameSite',{name:'Pitt St'});
  f.cmd('gameSend',{site:site.id,lines:[{product:p.id,quantity:100}]});assert.equal(f.sim.sfBusy(f.site(site.id)),'loading');
  assert.throws(()=>f.cmd('gameRemoveSite',{site:site.id}),/A truck is loading for Pitt St\. Stop it and remove the site\?$/);
  assert.ok(f.until(()=>f.sim.repo.all('truck').some(x=>x.game?.stage==='DRIVING')));assert.equal(f.sim.sfBusy(f.site(site.id)),'sending');
  assert.throws(()=>f.cmd('gameRemoveSite',{site:site.id}),/A truck is taking scaffold to Pitt St\. Bring it home and remove the site\?$/);
  assert.ok(f.until(()=>f.idle()));assert.throws(()=>f.cmd('gameRemoveSite',{site:site.id}),/Pitt St still has scaffold on it\./);
  // bring it all back by hand; once the truck has left the site with the last load, Remove site needs no question
  const c=f.cmd('gameCollect',{site:site.id,all:true});assert.ok(f.until(()=>{const x=f.truck(c.truck.id);return x.status==='IN_TRANSIT'&&x.game?.stage==='RETURNING';}));
  assert.equal(f.sim.sfBusy(f.site(site.id)),'home');
  const r=f.cmd('gameRemoveSite',{site:site.id});assert.equal(r.removing,true);assert.equal(r.message,'The last load from Pitt St is on its way home. Pitt St goes when it is back.');
  assert.ok(f.until(()=>f.site(site.id).status==='ARCHIVED',2000));assert.equal(f.at(f.yard.id,p.id),400);
  assert.equal(sfAsk({name:'Q'},'loading'),'A truck is loading for Q. Stop it and remove the site?');
  assert.equal(sfTies('S',{trucks:[{id:'T',status:'IN_TRANSIT',destination:'Y',at:'S',game:{kind:'COLLECT',site:'S',stage:'RETURNING'}}],collections:[{site:'S',status:'ON THE WAY',truck:'T'}]}),'home');
  assert.equal(sfTies('S',{trucks:[{id:'T',status:'AT_YARD',at:'Y',game:{kind:'SEND',site:'S',stage:'LOADING'}}]}),'loading');
  assert.equal(sfTies('S',{}),null);
});

test('while a site is being removed nothing new is booked for it or sent there by hand; a replayed command still answers',t=>{
  const f=game(t);const p=f.stock(300);const {site}=f.cmd('gameSite',{name:'I St'});f.cmd('gameSend',{site:site.id,lines:[{product:p.id,quantity:100}]});assert.ok(f.until(()=>f.idle()));
  const hand=f.sim.repo.all('truck')[0],key=randomUUID();const first=f.cmd('dispatch',{id:hand.id,destination:site.id},key);assert.ok(f.until(()=>f.truck(hand.id).status==='AT_SITE'));
  f.cmd('dispatch',{id:hand.id,destination:f.yard.id});assert.ok(f.until(()=>f.truck(hand.id).status==='AT_YARD'));
  // hold the trucks so the removal waits
  const all=f.sim.repo.all('truck');for(const x of all){x.game={kind:'HOLD'};f.sim.repo.save(x);}
  f.cmd('gameRemoveSite',{site:site.id,bringBack:true});assert.ok(f.site(site.id).finishing);
  for(const [a,input] of [['request',{site:site.id,product:p.id,quantity:10}],['requestCollection',{site:site.id,neededOn:f.sim.calendar().today}],['createLoadList',{site:site.id,lines:[{product:p.id,quantity:10}]}],['dispatch',{id:f.sim.repo.all('truck')[1].id,destination:site.id}]])
    assert.throws(()=>f.cmd(a,input),/I St is being removed\. Tap Keep it first\./,a);
  assert.deepEqual(f.cmd('dispatch',{id:hand.id,destination:site.id},key),first,'the replay is answered as before');
  for(const x of all){const y=f.truck(x.id);y.game=null;f.sim.repo.save(y);}
  assert.ok(f.until(()=>f.site(site.id).status==='ARCHIVED',3000));
});

test('something in the way while removing is said on the site (not a silent wait): a stocktake opened meanwhile; it goes on by itself once fixed',t=>{
  const f=game(t);const p=f.stock(200);const {site}=f.cmd('gameSite',{name:'J St'});f.cmd('gameSend',{site:site.id,lines:[{product:p.id,quantity:200}]});assert.ok(f.until(()=>f.idle()));
  const all=f.sim.repo.all('truck');for(const x of all){x.game={kind:'HOLD'};f.sim.repo.save(x);}
  f.cmd('gameRemoveSite',{site:site.id,bringBack:true});const count=f.cmd('count',{scope:site.id});
  for(const x of all){const y=f.truck(x.id);y.game=null;f.sim.repo.save(y);}
  f.tick(5);assert.equal(f.site(site.id).finishing.blocked,'A stocktake is open at J St. Finish it first.');assert.ok(f.idle(),'no truck drives out meanwhile');
  f.cmd('cancelCount',{id:count.id});assert.ok(f.until(()=>f.site(site.id).status==='ARCHIVED',3000));assert.equal(f.at(f.yard.id,p.id),200);
});

test('a stillage marked damaged: said up front with Mark it OK; marked damaged after a truck left: the truck comes home empty, Try again after it is fixed',t=>{
  const f=game(t);const p=f.stock(300);const {site}=f.cmd('gameSite',{name:'D St'});f.cmd('gameSend',{site:site.id,lines:[{product:p.id,quantity:300}]});assert.ok(f.until(()=>f.idle()));
  const here=()=>f.sim.containers().filter(c=>c.location===site.id);const bad=here()[0];
  f.cmd('condition',{id:bad.id,condition:'DAMAGED',reason:'bent'});
  assert.throws(()=>f.cmd('gameRemoveSite',{site:site.id,bringBack:true}),new RegExp(bad.name+' at D St is marked damaged, so it cannot go on a truck\\. Mark it OK to bring it home\\.'));
  const b=f.sim.sfBlockFor(f.site(site.id));assert.equal(b.fix.act,'ok');assert.equal(b.fix.container,bad.id);assert.equal(b.fix.label,'Mark it OK');
  f.cmd('condition',{id:bad.id,condition:'SERVICEABLE',reason:'Marked OK to bring it home'});
  // now removing starts, and every stillage there is marked damaged while the truck is on its way
  f.cmd('gameRemoveSite',{site:site.id,bringBack:true});const tr=f.sim.repo.all('truck').find(x=>x.game?.kind==='COLLECT');assert.equal(tr.game.stage,'OUTBOUND');
  for(const c of here())f.cmd('condition',{id:c.id,condition:'DAMAGED',reason:'bent'});
  assert.ok(f.until(()=>f.idle(),1500),'the truck comes home, it does not wait at the site for ever');
  const fin=f.site(site.id).finishing;assert.match(fin.stuck,/Nothing could be loaded/);assert.match(fin.blocked,/marked damaged/);f.tick(30);assert.ok(f.idle(),'and no truck goes out again by itself');
  for(const c of here())f.cmd('condition',{id:c.id,condition:'SERVICEABLE',reason:'ok'});
  assert.ok(f.until(()=>f.site(site.id).status==='ARCHIVED',3000),'once fixed it goes on by itself');assert.equal(f.at(f.yard.id,p.id),300);
  // stuck with nothing to explain it: Try again (the same button) starts bringing it back again
  const {site:g}=f.cmd('gameSite',{name:'G St'});f.cmd('gameSend',{site:g.id,lines:[{product:p.id,quantity:100}]});assert.ok(f.until(()=>f.idle()));
  const all=f.sim.repo.all('truck');for(const y of all){y.game={kind:'HOLD'};f.sim.repo.save(y);}
  f.cmd('gameRemoveSite',{site:g.id,bringBack:true});for(const y of f.sim.repo.all('gameOrder'))f.sim.repo.remove(y.id,'gameOrder');
  const x=f.site(g.id);x.finishing={...x.finishing,stuck:'Nothing could be loaded.'};f.sim.repo.save(x);for(const y of all){const z=f.truck(y.id);z.game=null;f.sim.repo.save(z);}
  f.tick(20);assert.equal(f.site(g.id).status,'ACTIVE','stuck: it waits');assert.ok(f.idle());
  assert.equal(f.cmd('gameRemoveSite',{site:g.id,bringBack:true}).removing,true,'Try again');assert.equal(f.site(g.id).finishing.stuck,null);
  assert.ok(f.until(()=>f.site(g.id).status==='ARCHIVED',3000));
  // a stillage the crew could never lift is said too (the board cannot see weights)
  const {site:h}=f.cmd('gameSite',{name:'H St'});f.cmd('gameSend',{site:h.id,lines:[{product:p.id,quantity:100}]});assert.ok(f.until(()=>f.idle()));
  for(const r of f.sim.repo.all('resource'))if(r.location===f.yard.id&&r.type==='FORKLIFT'){r.capacity=1;f.sim.repo.save(r);}
  assert.throws(()=>f.cmd('gameRemoveSite',{site:h.id,bringBack:true}),/is too heavy for the crew to lift/);
});

test('Keep it calls off only what the removal asked for: the owner\'s own Bring back still goes; a turned-back Send says so; an empty truck brings no tick',t=>{
  const f=game(t);const p=f.stock(600);const {site}=f.cmd('gameSite',{name:'K St'});f.cmd('gameSend',{site:site.id,lines:[{product:p.id,quantity:300}]});assert.ok(f.until(()=>f.idle()));
  const all=f.sim.repo.all('truck');const hold=()=>{for(const x of all){const y=f.truck(x.id);y.game={kind:'HOLD'};f.sim.repo.save(y);}},free=()=>{for(const x of all){const y=f.truck(x.id);y.game=null;f.sim.repo.save(y);}};
  hold();const own=f.cmd('gameCollect',{site:site.id,lines:[{product:p.id,quantity:100}]});assert.ok(own.queued);
  f.cmd('gameRemoveSite',{site:site.id,bringBack:true});f.cmd('gameKeepOpen',{site:site.id});
  assert.deepEqual(f.sim.repo.all('gameOrder').map(o=>o.id),[own.queued],'the owner\'s Bring back is kept');
  free();assert.ok(f.until(()=>f.idle()&&!f.sim.repo.all('gameOrder').length));assert.equal(f.at(site.id,p.id),200,'it went');
  // the removal's own waiting Bring back is called off
  hold();f.cmd('gameRemoveSite',{site:site.id,bringBack:true});assert.equal(f.sim.repo.all('gameOrder').filter(o=>o.byRemove).length,1);f.cmd('gameKeepOpen',{site:site.id});
  assert.equal(f.sim.repo.all('gameOrder').length,0);free();
  // a Send turned back by the removal, then Keep it: the owner is told it was not made
  const s=f.cmd('gameSend',{site:site.id,lines:[{product:p.id,quantity:100}]});const id=s.trucks[0].id;
  // the other trucks are away for a while (a held truck would be freed by the next tick)
  for(const x of all)if(x.id!==id){const y=f.truck(x.id);y.retired=true;f.sim.repo.save(y);}
  f.cmd('gameRemoveSite',{site:site.id,bringBack:true});assert.ok(f.until(()=>f.truck(id).game?.diverted));f.cmd('gameKeepOpen',{site:site.id});
  assert.ok(f.until(()=>!f.truck(id).game,1500));for(const x of all){const y=f.truck(x.id);y.retired=false;f.sim.repo.save(y);}assert.ok(f.until(()=>f.idle()));
  assert.ok(f.sim.repo.all('notification').some(n=>n.title==='Not sent'&&/The load for K St came back to the yard\. Send it again/.test(n.body)));
  assert.equal(f.at(site.id,p.id),200,'nothing moved off the kept site');assert.equal(f.at(f.yard.id,p.id),400);
  // an empty truck turned back by Keep it: no "Back at the yard" for it
  f.cmd('gameRemoveSite',{site:site.id,bringBack:true});const out=f.sim.repo.all('truck').find(x=>x.game?.kind==='COLLECT');assert.equal(out.game.stage,'OUTBOUND');
  const before=f.sim.repo.all('notification').filter(n=>n.title==='Back at the yard').length;f.cmd('gameKeepOpen',{site:site.id});
  assert.ok(f.until(()=>f.idle(),1500));assert.equal(f.sim.repo.all('notification').filter(n=>n.title==='Back at the yard').length,before);assert.equal(f.at(site.id,p.id),200);
});

test('the board: "Remove site" in full on the tiles; the Undo of "added" asks the question when a Send already went; a stocktake fix opens that stocktake',t=>{
  const f=game(t);const p=f.stock(200);const {site}=f.cmd('gameSite',{name:'New St'});__sf.reset();
  const s0=f.sim.snapshot(0,{lean:true});assert.ok(sfTile(s0.sites.find(x=>x.id===site.id),'T',true).includes('<span>Remove site</span>'));
  f.cmd('gameSend',{site:site.id,lines:[{product:p.id,quantity:100}]});const s=f.sim.snapshot(0,{lean:true});
  const calls=[];const api={ctx:{state:s,cmd:a=>{calls.push(a);return {};}},refresh:()=>{},pop:()=>{},gone:()=>{}};
  __sf.state().undos.set('u9',{kind:'new',site:site.id});sfClick({dataset:{sfUndo:'u9'},closest:()=>null},api);
  assert.equal(calls.length,0,'nothing sent');assert.equal(__sf.state().ask,site.id,'the question shows instead');
  __sf.reset();assert.ok(f.until(()=>f.idle()));const count=f.cmd('count',{scope:site.id});const s2=f.sim.snapshot(0,{lean:true});let went=null;
  const api2={ctx:{state:s2,cmd:()=>({}),go:(v,o)=>{went=[v,o];}},refresh:()=>{},pop:()=>{},gone:()=>{}};
  sfClick({dataset:{sfRemove:site.id},closest:()=>null},api2);sfClick({dataset:{sfFix:site.id},closest:()=>null},api2);
  assert.deepEqual(went,['STOCK',{stockTab:'CONTAINERS',focus:count.id}]);
});
