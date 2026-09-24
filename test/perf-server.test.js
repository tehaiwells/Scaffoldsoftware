import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase,atomic,cached } from '../src/database.js';
import { Service } from '../src/service.js';
import { Simulation,startScheduler,tickCompany } from '../src/simulation.js';
import { catalogueRevision } from '../src/repository.js';
import { computeEffectiveProducts } from '../src/domain/catalogue.js';
import { createApp } from '../src/server.js';

const password='demonstration-password';
function world(t,{site=true}={}){
  const db=openDatabase(':memory:');t.after(()=>db.close());const auth=new Service(db);
  const user=auth.authenticate(auth.register({name:'Owner',companyName:'Perf',email:randomUUID()+'@example.com',password,systems:['quickstage']}));
  const sim=new Simulation(db,user),cmd=(action,input={})=>sim.execute(action,input,randomUUID());
  const yard=cmd('yard',{name:'Yard',segments:[{direction:'RIGHT',length:20000},{direction:'DOWN',length:16000},{direction:'LEFT',length:20000}],closed:true});
  const products=cmd('seed');cmd('resources',{location:yard.id,workers:3,machines:1,stepMs:100,speed:100000,jobs:false});
  const truck=cmd('truck',{name:'T01',yard:yard.id});
  const container=(name,x,y,extra={})=>cmd('container',{name,location:yard.id,type:'STILLAGE',length:2000,width:1000,height:1000,tare:50000,x,y,...extra});
  const tick=(n=1,ms=1000)=>{for(let i=0;i<n;i++)atomic(db,()=>sim.tick(ms));};
  let sup=null,assigned=null,hidden=null;
  if(site){const email=randomUUID()+'@example.com';auth.addUser(user,{name:'Supervisor',email,password,roles:['SUPERVISOR']});sup=auth.authenticate(auth.login({email,password}));assigned=cmd('site',{name:'Assigned',supervisor:sup.id});hidden=cmd('site',{name:'Hidden'});}
  return {db,auth,user,sim,cmd,yard,products,truck,container,tick,sup,assigned,hidden};
}
const retry=f=>{for(const task of f.sim.tasks().filter(t=>t.state==='BLOCKED'))f.cmd('retry',{id:task.id});};

test('prepared statements are cached per connection and SQL text',t=>{
  const a=openDatabase(':memory:'),b=openDatabase(':memory:');t.after(()=>{a.close();b.close();});
  assert.equal(cached(a,'SELECT 1 x'),cached(a,'SELECT 1 x'));assert.notEqual(cached(a,'SELECT 1 x'),cached(b,'SELECT 1 x'));assert.notEqual(cached(a,'SELECT 1 x'),cached(a,'SELECT 2 x'));
  assert.equal(a.prepare('PRAGMA synchronous').get().synchronous,1,'synchronous=NORMAL');
  const names=a.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r=>r.name);
  for(const n of ['ledger_company_event_sequence','contents_company_product'])assert.ok(names.includes(n),n);
  assert.equal(a.prepare('SELECT MAX(version) v FROM schema_migrations').get().v,5);
});

test('snapshot with the read cache equals the uncached snapshot for owner and supervisor; lean drops only the unread keys',t=>{
  const f=world(t),p=f.products[0];
  const a=f.container('A',4000,4000),b=f.container('B',7000,4000),empty=f.container('Empty',10000,4000);f.container('Top',10000,4000,{support:empty.id});f.container('Spare',13000,4000);
  for(const c of [a,b])f.cmd('opening',{container:c.id,product:p.id,quantity:100,reason:'DEMO ONLY opening'});
  f.cmd('removeStock',{container:b.id,product:p.id,quantity:5,reason:'Materials list correction'});
  const request=f.cmd('request',{site:f.assigned.id,product:p.id,quantity:120});f.cmd('allocate',{id:request.id,truck:f.truck.id});f.tick(6);
  // ledger rows the supervisor may or may not see: its site, a hidden site, the truck (visible once at its site), a container on the truck (never: its location is not a site), nothing, a missing id
  for(const destination of [f.assigned.id,f.hidden.id,f.truck.id,a.id,null,'missing-id'])f.sim.repo.event(f.user.id,'PURCHASE',{destination,quantity:1,reason:'test'});
  f.sim.repo.event(f.user.id,'STOCK_REMOVED',{source:f.assigned.id,quantity:1,reason:'test'});
  const retired=f.sim.repo.get(f.products[2].id,'product');retired.retired=true;f.sim.repo.save(retired);f.sim.repo.event(f.user.id,'PURCHASE',{destination:f.assigned.id,product:retired.id,quantity:1,reason:'retired'});
  const scoped=new Simulation(f.db,f.sup);
  const same=label=>{for(const [who,sim] of [['owner',f.sim],['supervisor',scoped]]){const fast=sim.snapshot(),slow=sim.snapshot(0,{cache:false});assert.deepStrictEqual(fast,slow,label+' '+who);assert.equal(sim.repo.cache,null);assert.equal(sim.auth.memo,null);assert.equal(sim.catalogueMemo,null);
    for(const id of [...f.sim.repo.all('site'),...f.sim.repo.all('truck'),...f.sim.repo.all('container')].map(o=>o.id).concat([null,'missing-id'])){let ok=true;try{sim.assertSite(id);}catch{ok=false;}assert.equal(sim.siteVisible(id)||sim.auth.permissions(sim.user).includes('operations.manage'),ok,'siteVisible mirrors assertSite for '+id);}
    const lean=sim.snapshot(0,{lean:true}),expected={...fast};for(const k of ['recentTasks','sources','packaging'])delete expected[k];expected.catalogueRev=lean.catalogueRev;assert.deepStrictEqual(lean,expected,label+' lean '+who);
    const again=sim.snapshot(0,{lean:true,catalogue:lean.catalogueRev});assert.ok(!('products' in again));delete expected.products;assert.deepStrictEqual(again,expected);}};
  const s=f.sim.snapshot();assert.ok(s.trucks[0].loadedWeight>0||s.trucks[0].reservedWeight>0,'truck has cargo or reservations');assert.ok(s.balances.some(l=>l.reserved>0),'reservations');assert.ok(s.containers.some(c=>c.support),'a pile');assert.ok(s.tasks.length>0);
  same('loading');
  for(let i=0;i<4;i++){f.tick(60);retry(f);}f.cmd('dispatch',{id:f.truck.id,destination:f.assigned.id});f.tick(5);
  const sv=scoped.snapshot();assert.equal(sv.trucks.length,1,'supervisor sees the truck at their site');assert.ok(sv.balances.length>0);assert.ok(sv.additions.some(l=>l.destination===f.truck.id));assert.ok(!sv.additions.some(l=>l.destination===a.id||l.destination===f.hidden.id||l.product_id===retired.id));
  same('at site');
  // a snapshot inside a caller's transaction neither commits nor ends it
  f.db.exec('BEGIN');f.sim.snapshot();assert.equal(f.db.isTransaction,true);f.db.exec('ROLLBACK');
  // cached objects never leak: a write after a snapshot and the next snapshot see fresh rows
  const before=f.sim.snapshot();const c=f.sim.repo.get(empty.id,'container');c.name='Renamed';f.sim.repo.save(c);assert.equal(f.sim.snapshot().containers.find(x=>x.id===empty.id).name,'Renamed');assert.notEqual(before.containers.find(x=>x.id===empty.id).name,'Renamed');
});

test('catalogue revision changes on every catalogue write, survives rollbacks and hands out fresh copies',t=>{
  const f=world(t,{site:false}),company=f.user.company_id,rev=()=>catalogueRevision(f.db,company),fresh=()=>computeEffectiveProducts(f.sim.repo);
  let last=rev();const changed=why=>{const now=rev();assert.notEqual(now,last,why);last=now;assert.deepStrictEqual(f.sim.effectiveProducts(),fresh(),why);};
  assert.deepStrictEqual(f.sim.effectiveProducts(),fresh());
  f.cmd('override',{product:f.products[0].id,unitWeight:12345,packQuantity:7,reason:'Weighed'});changed('override adds productSettings');assert.equal(f.sim.effectiveProducts()[0].unitWeight,12345);
  f.cmd('override',{product:f.products[0].id,unitWeight:222,reason:'Weighed again'});changed('override saves productSettings');assert.equal(f.sim.effective(f.products[0].id).unitWeight,222);
  const pack=f.sim.repo.all('packaging').find(x=>x.product===f.products[1].id);pack.operatingQuantity=99;f.sim.repo.save(pack);changed('packaging save');
  f.sim.repo.remove(pack.id,'packaging');changed('packaging remove');
  f.cmd('product',{name:'New',reference:'NEW-1',system:'quickstage',verification:'DEMO ONLY',unitWeight:1000});changed('product add');
  f.container('X',4000,4000);f.sim.repo.event(f.user.id,'PURCHASE',{quantity:1,reason:'x'});assert.equal(rev(),last,'other kinds leave the catalogue revision alone');
  // callers may mutate what they get
  const list=f.sim.effectiveProducts();list[0].name='mutated';assert.notEqual(f.sim.effectiveProducts()[0].name,'mutated');const one=f.sim.effective(f.products[0].id);one.name='mutated';assert.notEqual(f.sim.effective(f.products[0].id).name,'mutated');
  // a rolled-back bump never serves the rolled-back catalogue, even when the next bump reaches the same counter
  f.db.exec('BEGIN');const p=f.sim.repo.get(f.products[0].id,'product');p.name='Rolled back';f.sim.repo.save(p);assert.equal(f.sim.effectiveProducts()[0].name,'Rolled back');f.db.exec('ROLLBACK');
  assert.equal(rev(),last);assert.deepStrictEqual(f.sim.effectiveProducts(),fresh());
  const q=f.sim.repo.get(f.products[0].id,'product');q.name='Committed';f.sim.repo.save(q);changed('product save');assert.equal(f.sim.effectiveProducts()[0].name,'Committed');
  assert.throws(()=>f.sim.effective('missing-id'),{status:404});assert.throws(()=>f.sim.effective(5),{status:400});
});

test('GET /api/state is lean and leaves out an unchanged catalogue',async t=>{
  const f=world(t,{site:false});const server=createApp(f.db);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const token=f.auth.login({email:f.db.prepare('SELECT email FROM users WHERE id=?').get(f.user.id).email,password});
  const get=async q=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/state${q}`,{headers:{cookie:'session='+token}});assert.equal(r.status,200);return r.json();};
  const first=await get('');assert.equal(typeof first.catalogueRev,'string');assert.equal(first.products.length,f.products.length);for(const k of ['sources','packaging','recentTasks'])assert.ok(!(k in first),k);
  const second=await get('?page=0&catalogue='+encodeURIComponent(first.catalogueRev));assert.ok(!('products' in second));assert.equal(second.catalogueRev,first.catalogueRev);
  f.cmd('override',{product:f.products[0].id,unitWeight:4321,reason:'Weighed'});
  const third=await get('?catalogue='+encodeURIComponent(first.catalogueRev));assert.notEqual(third.catalogueRev,first.catalogueRev);assert.equal(third.products.find(p=>p.id===f.products[0].id).unitWeight,4321);
  assert.ok(Array.isArray(f.sim.snapshot().sources)&&Array.isArray(f.sim.snapshot().recentTasks),'snapshot() without options is unchanged');
});

const dump=db=>db.prepare('SELECT id,kind,version,data FROM objects ORDER BY rowid').all().map(r=>({...r}));
function normalise(rows,known){const uuid=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,iso=/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g;return rows.map(r=>JSON.stringify(r).replace(uuid,m=>known.has(m)?m:'new').replace(iso,'time'));}

test('the quiescence probe runs only yard jobs when nothing else moves, and that equals a full tick',t=>{
  const f=world(t,{site:false});const owner={company_id:f.user.company_id,id:f.user.id};
  f.tick(1,250);// place the crew
  f.cmd('jobsMode',{jobs:true,routineJobs:true});const config=f.sim.repo.all('config')[0];config.jobRefreshMs=250;f.sim.repo.save(config);
  const known=new Set(dump(f.db).flatMap(r=>[r.id,...(r.data.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)??[])]));
  const run=fn=>{f.db.exec('BEGIN');try{const mode=fn();return {mode,rows:normalise(dump(f.db),known)};}finally{f.db.exec('ROLLBACK');}};
  const start=normalise(dump(f.db),known);
  const probe=run(()=>tickCompany(f.db,owner,250)),full=run(()=>{new Simulation(f.db,owner).tick(250);return 'full';});
  assert.equal(probe.mode,'jobs');assert.deepStrictEqual(probe.rows,full.rows);assert.notDeepStrictEqual(full.rows,start,'the tick did real work (routine jobs, walks)');
  atomic(f.db,()=>tickCompany(f.db,owner,250));assert.ok(f.sim.repo.all('resource').some(r=>r.walk)||f.sim.repo.all('job').some(j=>j.state==='IN_PROGRESS'));
  if(f.sim.repo.all('resource').some(r=>r.walk))assert.equal(run(()=>tickCompany(f.db,owner,250)).mode,'full','a walking worker needs the full tick');
  f.cmd('jobsMode',{jobs:false});f.tick(40);
  const a=f.container('A',4000,4000);f.cmd('queue',{container:a.id,destination:f.truck.id});assert.equal(run(()=>tickCompany(f.db,owner,250)).mode,'full','an active task needs the full tick');
  f.cmd('pause',{paused:true});const paused=run(()=>tickCompany(f.db,owner,250));assert.equal(paused.mode,'paused');assert.deepStrictEqual(paused.rows,normalise(dump(f.db),known));
});

test('scheduler: per-company rounds tick, renew the lease, keep the singleton guard and stop cleanly',async t=>{
  const f=world(t,{site:false});f.tick(1,250);f.cmd('jobsMode',{jobs:true,routineJobs:true});
  const other=world(t,{site:false});// a second database is independent
  const stop=startScheduler(f.db);assert.throws(()=>startScheduler(f.db),/Another movement engine/);
  const first=f.db.prepare('SELECT expires_at FROM engine_lease').get().expires_at;
  await new Promise(r=>setTimeout(r,2200));
  assert.ok(f.sim.repo.all('job').length>0,'the engine ticked the company');assert.ok(f.db.prepare('SELECT expires_at FROM engine_lease').get().expires_at>first,'lease renewed');
  stop();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM engine_lease').get().n,0);
  const versions=JSON.stringify(dump(f.db));await new Promise(r=>setTimeout(r,600));assert.equal(JSON.stringify(dump(f.db)),versions,'no rounds after stop');
  // a paused company is skipped without a transaction and nothing of it changes
  f.cmd('pause',{paused:true});const frozen=JSON.stringify(dump(f.db));let begins=0;const exec=f.db.exec.bind(f.db);f.db.exec=sql=>{if(sql==='BEGIN IMMEDIATE')begins++;return exec(sql);};
  const again=startScheduler(f.db);await new Promise(r=>setTimeout(r,700));again();f.db.exec=exec;assert.equal(JSON.stringify(dump(f.db)),frozen);assert.equal(begins,1,'only the lease is taken');
  const third=startScheduler(other.db);third();
});
