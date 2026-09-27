import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase,atomic } from '../src/database.js';
import { Service } from '../src/service.js';
import { Simulation } from '../src/simulation.js';
import { gpStops,gpChoose,gpSnap,gpFill,gpCount,gpPerStillage } from '../public/game-pick.js';

// The game board's one-tap commands and the truck autopilot (src/domain/game.js), on a small yard made the way the board makes it.
function game(t,{systems=['quickstage']}={}){
  const db=openDatabase(':memory:');t.after(()=>db.close());const auth=new Service(db);
  const user=auth.authenticate(auth.register({name:'Owner',companyName:'Demo',email:randomUUID()+'@example.com',password:'demonstration-password',systems}));
  const sim=new Simulation(db,user);const cmd=(action,input={})=>sim.execute(action,input,randomUUID());
  const start=cmd('gameStart',{size:'S'});const c=sim.repo.all('config')[0];Object.assign(c,{stepMs:100,speed:100000,jobs:false,routineJobs:false});sim.repo.save(c);
  const tick=(n=1,ms=1000)=>{for(let i=0;i<n;i++)atomic(db,()=>sim.tick(ms));};
  const until=(fn,n=400)=>{for(let i=0;i<n;i++){if(fn())return true;tick(1);}return fn();};
  const truck=id=>sim.repo.get(id,'truck');
  const total=()=>db.prepare('SELECT COALESCE(SUM(quantity),0) n FROM contents WHERE company_id=?').get(user.company_id).n;
  const at=(loc,product)=>sim.containers().filter(x=>x.location===loc).reduce((n,x)=>n+sim.repo.quantity(x.id,product),0);
  return {db,auth,user,sim,cmd,tick,until,truck,total,at,yard:start.yard};
}
const items=(...rows)=>rows.map(([id,support,lines,busy=false])=>({id,name:id,support,lines,busy}));

test('picking takes whole stillages, tops of piles first, single-product ones before mixed ones, fuller ones first',()=>{
  const list=items(['A',null,[['p',50]]],['B','A',[['p',30]]],['C',null,[['p',20],['q',5]]],['D',null,[['p',40]]],['E',null,[['q',10]]],['F','E',[['p',60]]],['G',null,[['p',99]],true]);
  // B sits on A, F on E; G is busy. Tops holding p: B (30), C (mixed), D (40), F (60): F first (fuller), then D, B, then A (freed by B), then C (mixed last).
  assert.deepEqual(gpStops(list,'p').map(s=>s.qty),[60,100,130,180,200]);
  assert.deepEqual(gpStops(list,'p')[3].ids,['F','D','B','A']);
  assert.equal(gpSnap(gpStops(list,'p'),70),100,'the slider snaps up to the next whole stillage');assert.equal(gpSnap(gpStops(list,'p'),999),200,'or everything there is');assert.equal(gpSnap([],5),0);
  const r=gpChoose(list,[{product:'p',quantity:90},{product:'q',quantity:10}]);
  assert.deepEqual(r.ids.sort(),['D','E','F'],'p takes F and D; q then takes E, which F no longer covers');assert.equal(r.got.get('p'),100);assert.equal(r.got.get('q'),10);assert.deepEqual(r.short,[]);
  const s=gpChoose(list,[{product:'q',quantity:50}]);assert.deepEqual(s.short,[{product:'q',want:50,got:15}],'mixed C first, then E with F riding along');assert.deepEqual(s.extra.get('p'),80,'the p in C and F ride along');
  const pile=gpChoose(list,[{product:'p',quantity:180}]);assert.deepEqual(pile.ids.slice(0,2).sort(),['B','F'],'a stillage on top is listed before the one under it');
  assert.equal(gpFill(0),'Empty');assert.equal(gpFill(.5),'Half full');assert.equal(gpFill(1),'Full');assert.equal(gpCount(1234),'1.2k');assert.equal(gpCount(200),'200');assert.equal(gpCount(45678),'45k');
});

test('choosing a yard size makes the yard with a starter kit; a second start is refused',t=>{
  const f=game(t),s=f.sim.snapshot();
  assert.equal(s.yards.length,1);assert.equal(s.yards[0].name,'Main yard');assert.deepEqual(s.yards[0].points.map(p=>[p.x,p.y]),[[0,0],[20000,0],[20000,16000],[0,16000]]);
  assert.equal(s.resources.filter(r=>r.type==='WORKER').length,4);assert.equal(s.resources.filter(r=>r.type==='FORKLIFT').length,2);assert.deepEqual(s.trucks.map(t=>t.name).sort(),['T-01','T-02']);
  assert.ok(s.yards[0].fixtures.some(x=>x.kind==='OFFICE'),'a yard office in the corner');
  assert.throws(()=>f.cmd('gameStart',{size:'L'}),/already set up/);assert.throws(()=>game(t).cmd('gameStart',{size:'XL'}),/already set up|small, medium or large/);
});

test('a new site comes with a crane and crew; the supplier lists load once for the systems in use',t=>{
  const f=game(t);const {site}=f.cmd('gameSite',{name:'George Street'});const crew=f.sim.repo.all('resource').filter(r=>r.location===site.id);
  assert.equal(crew.filter(r=>r.type==='CRANE').length,1);assert.equal(crew.filter(r=>r.type==='WORKER').length,2);
  const r=f.cmd('gameCatalogue');assert.ok(!/\d/.test(r.message),'no counts in the pop');assert.ok(r.added>=40,'the Quickstage list');const products=f.sim.repo.all('product');assert.ok(products.every(p=>p.system==='quickstage'&&p.verification==='SOURCE VERIFIED'),'only the systems in use, only reviewed figures');
  assert.throws(()=>f.cmd('gameCatalogue'),/already loaded/);
});

test('which scaffold is asked on the board: the systems picked become the company\'s, and only their reviewed lists load',t=>{
  const f=game(t,{systems:['quickstage','at-pac','tube-clip']});const r=f.cmd('gameCatalogue',{systems:['tube-clip']});assert.ok(r.added>=100);
  assert.ok(f.sim.repo.all('product').every(p=>p.system==='tube-clip'));assert.deepEqual(f.db.prepare('SELECT system_id FROM company_systems WHERE company_id=? AND enabled=1').all(f.user.company_id).map(x=>x.system_id),['tube-clip']);
  assert.throws(()=>f.cmd('gameCatalogue',{systems:['no-such-system']}),/valid scaffold system/);
});

test('a site can be opened on the empty block that was tapped on the map',t=>{
  const f=game(t);const first=f.cmd('gameSite',{name:'First'}).site;const l=f.sim.worldLayoutNow(),p=l.byId.get(first.id),yard=l.places.find(x=>x.kind==='yard');
  // a free block next to the first site
  const taken=new Set(l.places.map(x=>x.col+','+x.row));const spot=[[1,0],[-1,0],[0,1],[0,-1]].map(([dc,dr])=>({col:p.col+dc,row:p.row+dr})).find(x=>!taken.has(x.col+','+x.row));
  const {site}=f.cmd('gameSite',{name:'Second',...spot});const q=f.sim.worldLayoutNow().byId.get(site.id);assert.deepEqual([q.col,q.row],[spot.col,spot.row]);assert.ok(yard);
});

test('added stock goes in by the pack, or in stillages a forklift can lift when there is no pack size',t=>{
  const f=game(t);const demo=f.cmd('seed');const ledger=demo.find(p=>f.sim.effective(p.id).packQuantity===100);
  f.cmd('gameAddStock',{lines:[{product:ledger.id,quantity:250}]});assert.equal(f.at(f.yard.id,ledger.id),250);
  const packs=f.sim.containers().filter(c=>f.sim.repo.quantity(c.id,ledger.id)>0).map(c=>f.sim.repo.quantity(c.id,ledger.id)).sort((a,b)=>b-a);assert.deepEqual(packs,[100,100,50]);
  f.cmd('gameCatalogue');const heavy=f.sim.repo.all('product').find(p=>p.packQuantity==null&&p.unitWeight>=10000);assert.ok(heavy,'a supplier part with a weight and no pack size');
  const per=Math.floor((1500000-50000)/heavy.unitWeight);f.cmd('gameAddStock',{lines:[{product:heavy.id,quantity:per*2+3}]});
  const q=f.sim.containers().map(c=>f.sim.repo.quantity(c.id,heavy.id)).filter(n=>n>0).sort((a,b)=>b-a);assert.deepEqual(q,[per,per,3],'each stillage at most what a 1.5 t forklift lifts');
  f.cmd('gameAddStock',{lines:[{product:heavy.id,quantity:per}]});assert.deepEqual(f.sim.containers().map(c=>f.sim.repo.quantity(c.id,heavy.id)).filter(n=>n>0).sort((a,b)=>b-a),[per,per,per,3],'the part-filled stillage is topped up first');
  const events=f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE company_id=? AND event='PURCHASE'").get(f.user.company_id).n;assert.ok(events>=5,'every piece is on the ledger as a purchase');
  assert.throws(()=>f.cmd('gameAddStock',{lines:[]}),/Pick at least one/);
});

test('Send: the next free truck is loaded with whole stillages, drives, is unloaded by the site crane, says Delivered and comes home',t=>{
  const f=game(t);const demo=f.cmd('seed');const ledger=demo.find(p=>f.sim.effective(p.id).packQuantity===100);f.cmd('gameAddStock',{lines:[{product:ledger.id,quantity:300}]});
  const {site}=f.cmd('gameSite',{name:'George Street'});const before=f.total();
  const r=f.cmd('gameSend',{site:site.id,lines:[{product:ledger.id,quantity:150}]});assert.equal(r.trucks.length,1);assert.equal(r.trucks[0].stillages,2,'150 snaps to two whole packs');assert.match(r.message,/loading for George Street/);
  const id=r.trucks[0].id;assert.equal(f.truck(id).game.stage,'LOADING');assert.equal(f.truck(id).destination,site.id);
  assert.ok(f.until(()=>f.truck(id).status==='IN_TRANSIT'),'dispatched by itself once loaded');
  assert.ok(f.until(()=>f.truck(id).game?.stage==='UNLOADING'),'arrives and the crane starts');
  assert.ok(f.until(()=>f.truck(id).game?.stage==='RETURNING'),'unloaded');assert.equal(f.at(site.id,ledger.id),200);assert.equal(f.at(f.yard.id,ledger.id),100);
  assert.ok(f.sim.repo.all('notification').some(n=>n.title==='Delivered'&&/Delivered to George Street!/.test(n.body)));
  assert.ok(f.until(()=>f.truck(id).status==='AT_YARD'&&!f.truck(id).game),'home and free again');assert.equal(f.total(),before,'nothing appears or disappears');
  const d=f.sim.repo.all('delivery').find(x=>x.to===site.id);assert.equal(d.status,'DELIVERED');
});

test('Send spreads a big order over free trucks; when every truck is out it waits and goes on the next truck back',t=>{
  const f=game(t);const demo=f.cmd('seed');const ledger=demo.find(p=>f.sim.effective(p.id).packQuantity===100);f.cmd('gameAddStock',{lines:[{product:ledger.id,quantity:1500}]});
  const {site}=f.cmd('gameSite',{name:'Tower'});const r=f.cmd('gameSend',{site:site.id,lines:[{product:ledger.id,quantity:1000}]});
  const n=r.trucks.reduce((s,t)=>s+t.stillages,0)+r.left.length;assert.equal(n,10);assert.ok(r.trucks.length>=1);
  // every truck out: the next Send waits (even while the stillages it wants are still busy) and goes on the first truck back
  for(const t of f.sim.repo.all('truck').filter(t=>!t.game))f.cmd('quickAdjust',{kind:'TRUCK',delta:-1,location:f.yard.id});assert.ok(f.sim.repo.all('truck').filter(t=>!t.retired).every(t=>t.game));
  const w=f.cmd('gameSend',{site:site.id,lines:[{product:ledger.id,quantity:100}]});assert.ok(w.queued,'waits instead of refusing');assert.match(w.message,/next truck back/);
  // (what did not fit on the two trucks is already waiting: one order more when it had to)
  const orders=f.sim.snapshot().gameOrders,rest=/The rest goes/.test(r.message)?1:0;assert.equal(orders.length,1+rest);assert.equal(orders.at(-1).type,'SEND');assert.equal(orders.at(-1).site,site.id);
  // a second one waits too, and can be taken off the list
  const w2=f.cmd('gameSend',{site:site.id,lines:[{product:ledger.id,quantity:100}]});assert.ok(w2.queued);assert.match(f.cmd('gameCancel',{id:w2.queued}).message,/waiting list/);assert.equal(f.sim.snapshot().gameOrders.length,1+rest);
  // the first truck home takes the waiting Send by itself
  assert.ok(f.until(()=>!f.sim.repo.all('gameOrder').length,1200),'the order went');assert.ok(f.sim.repo.all('truck').some(t=>t.game?.kind==='SEND'&&t.game.site===site.id),'on its way');
});

test('a waiting order that can no longer go is dropped with a note, not left forever',t=>{
  const f=game(t);const demo=f.cmd('seed');const ledger=demo.find(p=>f.sim.effective(p.id).packQuantity===100);f.cmd('gameAddStock',{lines:[{product:ledger.id,quantity:200}]});
  const {site}=f.cmd('gameSite',{name:'Short job'});for(const t of f.sim.repo.all('truck')){t.game={kind:'SEND',site:site.id,stage:'RETURNING'};t.status='IN_TRANSIT';f.sim.repo.save(t);}
  const w=f.cmd('gameSend',{site:site.id,lines:[{product:ledger.id,quantity:100}]});assert.ok(w.queued);
  f.cmd('archive',{id:site.id});for(const t of f.sim.repo.all('truck')){t.game=null;t.status='AT_YARD';f.sim.repo.save(t);}f.tick(2);
  assert.equal(f.sim.repo.all('gameOrder').length,0);assert.ok(f.sim.repo.all('notification').some(n=>n.title==='Not sent'&&/Short job/.test(n.body)));
});

test('Bring back: a free truck drives out empty, the site crane loads the collection, it comes home and the yard unloads it',t=>{
  const f=game(t);const demo=f.cmd('seed');const ledger=demo.find(p=>f.sim.effective(p.id).packQuantity===100);f.cmd('gameAddStock',{lines:[{product:ledger.id,quantity:200}]});
  const {site}=f.cmd('gameSite',{name:'Kent St'});const s=f.cmd('gameSend',{site:site.id,lines:[{product:ledger.id,quantity:200}]});const first=s.trucks[0].id;
  assert.ok(f.until(()=>f.truck(first).status==='AT_YARD'&&!f.truck(first).game));assert.equal(f.at(site.id,ledger.id),200);
  assert.equal(f.sim.gameItemsFor(site.id).items.length,2,'the board sees the stillages on site');assert.equal(f.sim.snapshot().game,undefined,'the 1 s poll does not carry them');
  const r=f.cmd('gameCollect',{site:site.id,lines:[{product:ledger.id,quantity:100}]});const id=r.truck.id;assert.equal(f.truck(id).status,'IN_TRANSIT');assert.equal(f.truck(id).game.stage,'OUTBOUND');
  const o=f.sim.repo.get(r.collection,'collection');assert.equal(o.scope,'SELECTED');assert.equal(o.containers.length,1);assert.equal(o.neededOn,f.sim.calendar().today);
  assert.ok(f.until(()=>f.truck(id).game?.stage==='RETURNING'),'loaded at the site');
  assert.ok(f.until(()=>!f.truck(id).game),'unloaded at the yard');assert.equal(f.at(site.id,ledger.id),100);assert.equal(f.at(f.yard.id,ledger.id),100);
  assert.equal(f.sim.repo.get(r.collection,'collection').status,'RETURNED');assert.ok(f.sim.repo.all('notification').some(n=>n.title==='Back at the yard'));
  const all=f.cmd('gameCollect',{site:site.id,all:true});assert.ok(f.until(()=>!f.truck(all.truck.id).game));assert.equal(f.at(site.id,ledger.id),0);assert.equal(f.at(f.yard.id,ledger.id),200);
  assert.throws(()=>f.cmd('gameCollect',{site:site.id,all:true}),/Nothing is on Kent St/);
});

test('a failed step waits with its reason and is tried again; Stop hands the truck back; supervisors get no game block or game commands',t=>{
  const f=game(t);const demo=f.cmd('seed');const ledger=demo.find(p=>f.sim.effective(p.id).packQuantity===100);f.cmd('gameAddStock',{lines:[{product:ledger.id,quantity:200}]});
  const {site}=f.cmd('gameSite',{name:'Park Rd'});const r=f.cmd('gameSend',{site:site.id,lines:[{product:ledger.id,quantity:100}]});const id=r.trucks[0].id;
  // the site's crane is taken away while the truck drives and unloading fails: the truck waits at the site with the reason, and carries on once it can
  assert.ok(f.until(()=>f.truck(id).status==='IN_TRANSIT'));
  const unload=f.sim.unload;f.sim.unload=()=>{throw Object.assign(new Error('No crane here.'),{status:409});};
  assert.ok(f.until(()=>f.truck(id).game?.problem==='No crane here.'),'the reason is kept on the trip');const g=f.truck(id).game;assert.ok(g.retryAt>Date.now());assert.equal(f.truck(id).status,'AT_SITE');
  f.sim.unload=unload;g.retryAt=0;const tr=f.truck(id);tr.game=g;f.sim.repo.save(tr);
  assert.ok(f.until(()=>!f.truck(id).game,800),'it carries on');assert.equal(f.at(site.id,ledger.id),100);
  // Stop: the truck is run by hand again
  const r2=f.cmd('gameSend',{site:site.id,lines:[{product:ledger.id,quantity:100}]});const id2=r2.trucks[0].id;assert.match(f.cmd('gameStop',{id:id2}).message,/by hand/);assert.equal(f.truck(id2).game,null);
  f.tick(40);assert.equal(f.truck(id2).status,'AT_YARD','no longer dispatched by itself');assert.throws(()=>f.cmd('gameStop',{id:id2}),/not on an automatic trip/);
  f.auth.addUser(f.user,{name:'Sup',email:'sup-game@example.com',password:'demonstration-password',roles:['SUPERVISOR']});
  const sup=new Simulation(f.db,f.auth.authenticate(f.auth.login({email:'sup-game@example.com',password:'demonstration-password'})));
  assert.equal(sup.snapshot().gameOrders,undefined);assert.throws(()=>sup.execute('gameSend',{site:site.id,lines:[{product:ledger.id,quantity:1}]},randomUUID()),/does not allow/);assert.throws(()=>sup.gameItemsFor(site.id),/permission|allow/i);
});

test('a buried stillage can still go: what is stacked on it rides along',()=>{
  const list=items(['A',null,[['p',50]]],['B','A',[['q',30]]],['C','B',[['q',20]]]);
  assert.deepEqual(gpStops(list,'p').map(s=>s.qty),[50]);assert.deepEqual(gpStops(list,'p')[0].ids.sort(),['A','B','C']);
  const r=gpChoose(list,[{product:'p',quantity:10}]);assert.deepEqual(r.ids,['C','B','A'],'top first');assert.equal(r.extra.get('q'),50);
  assert.deepEqual(gpStops(items(['A',null,[['p',50]]],['B','A',[['q',30]],true]),'p'),[],'not when something on it is busy');
});

test('added stock stands in tidy rows with aisles, three high at most, and every stillage can be driven out and sent',t=>{
  const f=game(t,{systems:['quickstage','tube-clip']});f.cmd('gameCatalogue');const ps=f.sim.repo.all('product').filter(p=>p.unitWeight>0&&p.unitWeight<30000).slice(0,8);
  f.cmd('gameAddStock',{lines:ps.map((p,i)=>({product:p.id,quantity:Math.floor((1450000/p.unitWeight))*(2+i%4)}))});
  const all=f.sim.containers().filter(c=>c.location===f.yard.id),byId=new Map(all.map(c=>[c.id,c]));const lvl=c=>{let n=1;for(let x=c;x.support;x=byId.get(x.support))n++;return n;};
  assert.ok(Math.max(...all.map(lvl))<=3,'piles at most three high');for(const c of all.filter(c=>c.support))assert.equal(f.sim.repo.lines(c.id)[0].product_id,f.sim.repo.lines(c.support)[0].product_id,'a pile holds one product');
  const ground=all.filter(c=>!c.support);for(const a of ground)for(const b of ground){if(a===b)continue;const gx=Math.max(b.x-(a.x+2000),a.x-(b.x+2000)),gy=Math.max(b.y-(a.y+1000),a.y-(b.y+1000));assert.ok(gx>=1200||gy>=1200,'an aisle between '+a.name+' and '+b.name);}
  const {site}=f.cmd('gameSite',{name:'Big job'});let sent=0;
  for(let round=0;round<12;round++){const free=f.sim.gameItemsFor(f.yard.id).items.filter(c=>!c.busy);if(!free.length)break;
    const lines=[...new Set(free.map(c=>c.lines[0][0]))].slice(0,2).map(product=>({product,quantity:1}));
    const r=f.cmd('gameSend',{site:site.id,lines});if(r.queued){f.cmd('gameCancel',{id:r.queued});f.until(()=>f.sim.repo.all('truck').some(x=>!x.game),400);continue;}sent+=r.trucks.reduce((n,x)=>n+x.stillages,0);
    f.until(()=>f.sim.tasks().some(x=>x.state==='BLOCKED')||!f.sim.repo.all('truck').some(x=>x.game?.stage==='LOADING'),600);
    assert.deepEqual(f.sim.tasks().filter(x=>x.state==='BLOCKED').map(x=>x.reason),[],'nothing gets stuck');}
  assert.ok(sent>=6,'sent '+sent);
});

test('Add stock never makes a stillage the crew cannot lift: a heavy pack is split, a part with no weight is refused, and neither is ever offered',t=>{
  const f=game(t,{systems:['quickstage','at-pac','tube-clip']});f.cmd('gameCatalogue');const all=f.sim.repo.all('product').map(p=>f.sim.effective(p.id));
  // every reviewed supplier part with a weight: a stillage of it is at most what the 1.5 t forklift and site crane lift
  for(const p of all.filter(p=>p.unitWeight>0)){const per=gpPerStillage(p);assert.ok(per>=1&&per*p.unitWeight+50000<=1500000,p.name);if(p.packQuantity>0)assert.ok(per<=p.packQuantity,p.name);}
  const heavy=all.find(p=>p.packQuantity>0&&p.unitWeight>0&&p.packQuantity*p.unitWeight+50000>1500000);assert.ok(heavy,'a supplier pack heavier than the forklift');
  f.cmd('gameAddStock',{lines:[{product:heavy.id,quantity:heavy.packQuantity*2}]});const mine=f.sim.containers().filter(c=>f.sim.repo.quantity(c.id,heavy.id)>0);
  assert.ok(mine.length>2,'the packs are split');for(const c of mine)assert.ok(f.sim.weight(c)<=1500000,c.name+' can be lifted');
  const {site}=f.cmd('gameSite',{name:'Heavy St'});const r=f.cmd('gameSend',{site:site.id,lines:[{product:heavy.id,quantity:heavy.packQuantity}]});
  assert.ok(f.until(()=>!f.sim.repo.all('truck').some(t=>t.game),900),'delivered and home');assert.ok(f.at(site.id,heavy.id)>=heavy.packQuantity);assert.equal(f.sim.tasks().filter(x=>x.state==='BLOCKED').length,0,'the crew was never stuck');assert.ok(r.trucks.length);
  const none=f.sim.repo.all('product').find(p=>!(f.sim.effective(p.id).unitWeight>0));if(none)assert.throws(()=>f.cmd('gameAddStock',{lines:[{product:none.id,quantity:10}]}),/no weight in your parts list/);
  // a stillage made too heavy by hand (the Office) is never offered by the slider or picked by Send
  const c=f.sim.containers().find(x=>x.location===f.yard.id&&f.sim.repo.quantity(x.id,heavy.id)>0);atomic(f.db,()=>f.sim.purchase({container:c.id,product:heavy.id,quantity:heavy.packQuantity*2,reason:'test'}));
  assert.equal(f.sim.gameItemsFor(f.yard.id).items.find(x=>x.id===c.id).busy,true);
});

test('Bring everything back with more than a truckload: the next truck goes back for the rest, the owner is told, and a second Bring back is not taken twice',t=>{
  const f=game(t);const demo=f.cmd('seed');const ledger=demo.find(p=>f.sim.effective(p.id).packQuantity===100);f.cmd('gameAddStock',{lines:[{product:ledger.id,quantity:1300}]});
  const {site}=f.cmd('gameSite',{name:'Tower'});const s=f.cmd('gameSend',{site:site.id,lines:[{product:ledger.id,quantity:1300}]});
  // what did not fit on the two trucks waits for the next truck back instead of being dropped
  assert.match(s.message,/The rest goes on the next truck back/);assert.equal(f.sim.repo.all('gameOrder').length,1);
  assert.ok(f.until(()=>!f.sim.repo.all('truck').some(t=>t.game)&&!f.sim.repo.all('gameOrder').length,4000),'every stillage delivered');assert.equal(f.at(site.id,ledger.id),1300);
  const r=f.cmd('gameCollect',{site:site.id,all:true});
  assert.throws(()=>f.cmd('gameCollect',{site:site.id,all:true}),/already on its way to bring everything back from Tower/);
  assert.equal(f.sim.gameItemsFor(site.id).items.filter(x=>!x.busy).length,0,'the whole site is on its way back: nothing offered twice');
  assert.ok(f.until(()=>f.truck(r.truck.id).game?.stage==='RETURNING',900));assert.ok(f.sim.repo.all('notification').some(n=>n.title==='More to bring back'&&/Tower/.test(n.body)),'the owner is told');
  assert.ok(f.until(()=>f.at(site.id,ledger.id)===0&&!f.sim.repo.all('truck').some(t=>t.game)&&!f.sim.repo.all('gameOrder').length,5000),'everything comes back');assert.equal(f.at(f.yard.id,ledger.id),1300);
  assert.ok(f.sim.repo.all('notification').some(n=>n.title==='Back at the yard'&&/full load/.test(n.body)));
});

test('a stillage on a Bring back is not offered again, and the board never adds a second crane to a site whose crane is switched off',t=>{
  const f=game(t);const demo=f.cmd('seed');const ledger=demo.find(p=>f.sim.effective(p.id).packQuantity===100);f.cmd('gameAddStock',{lines:[{product:ledger.id,quantity:300}]});
  const {site}=f.cmd('gameSite',{name:'Kent St'});const s=f.cmd('gameSend',{site:site.id,lines:[{product:ledger.id,quantity:300}]});assert.ok(f.until(()=>!f.truck(s.trucks[0].id).game));
  const r=f.cmd('gameCollect',{site:site.id,lines:[{product:ledger.id,quantity:100}]});const o=f.sim.repo.get(r.collection,'collection');
  const items=f.sim.gameItemsFor(site.id).items;assert.equal(items.find(x=>x.id===o.containers[0]).busy,true);assert.equal(items.filter(x=>!x.busy).length,2);
  const r2=f.cmd('gameCollect',{site:site.id,lines:[{product:ledger.id,quantity:100}]});assert.notDeepEqual(f.sim.repo.get(r2.collection,'collection').containers,o.containers,'a second Bring back takes another stillage');
  const office=f.cmd('site',{name:'Office site'});f.sim.repo.add('resource',{name:'Crane A',type:'CRANE',location:office.id,enabled:false,task:null,capacity:1500000,reach:10000});
  assert.equal(f.sim.gameCrew(office),false);assert.equal(f.sim.repo.all('resource').filter(x=>x.location===office.id&&x.type==='CRANE').length,1);
});

test('a board Send is on Today and the Schedule: loading, on the road and delivered today, on the truck that ran it',async t=>{
  const {tdDay,boardRuns}=await import('../public/operations.js');
  const f=game(t);const demo=f.cmd('seed');const ledger=demo.find(p=>f.sim.effective(p.id).packQuantity===100);f.cmd('gameAddStock',{lines:[{product:ledger.id,quantity:200}]});
  const {site}=f.cmd('gameSite',{name:'George St'});const r=f.cmd('gameSend',{site:site.id,lines:[{product:ledger.id,quantity:200}]});const id=r.trucks[0].id;
  let s=f.sim.snapshot(0,{lean:true});let run=tdDay(s).due.find(x=>x.kind==='trip');assert.ok(run,'on Today while the crew loads');assert.equal(run.status,'LOADING');assert.equal(run.siteName,'George St');assert.equal(run.runTruck,id);
  assert.ok(f.until(()=>f.truck(id).status==='IN_TRANSIT'));s=f.sim.snapshot(0,{lean:true});run=boardRuns(s)[0];assert.equal(run.status,'IN_TRANSIT');assert.equal(run.pieces,200);assert.equal(run.neededOn,s.calendar.today);
  assert.ok(f.until(()=>!f.truck(id).game));s=f.sim.snapshot(0,{lean:true});const done=tdDay(s).due.filter(x=>x.kind==='trip');assert.equal(done.length,1,'one record for the run, not one per stage');assert.equal(done[0].status,'DELIVERED');assert.equal(done[0].urgency,'DONE');
});
