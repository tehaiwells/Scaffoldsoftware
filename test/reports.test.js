process.env.TZ='Australia/Sydney';// the server's local day is Sydney's in this file
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { atomic } from '../src/database.js';
import { Simulation } from '../src/simulation.js';
import { createApp } from '../src/server.js';
import { fixture } from './simulation.test.js';
import { addDays } from '../src/domain/schedule.js';

const START=Date.parse('2026-08-03T00:00:00Z');// Monday 3 Aug 2026, 10:00 in Sydney
const setup=(t,now=START)=>{t.mock.timers.enable({apis:['Date'],now});return fixture(t);};
const at=(t,iso)=>t.mock.timers.setTime(Date.parse(iso));
const later=(t,days)=>t.mock.timers.setTime(Date.now()+days*86400000);
const settle=(f,n=150)=>{f.tick(n);for(const task of f.sim.tasks().filter(t=>t.state==='BLOCKED'))f.cmd('retry',{id:task.id});f.tick(n);};
// The live numbers the Stock page shows (the register), which the rebuilt ledger history must match.
const register=(sim=null,f)=>(sim??f.sim).snapshot().register.reduce((s,r)=>({yard:s.yard+r.yard,site:s.site+r.site,truck:s.truck+r.truck}),{yard:0,site:0,truck:0});
const user=(f,email,role)=>{f.auth.addUser(f.user,{name:role,email,password:'demonstration-password',roles:[role]});return new Simulation(f.db,f.auth.authenticate(f.auth.login({email,password:'demonstration-password'})));};
// One loaded run: container onto the truck at the yard, drive to the site, unload with the site crane, drive back empty.
const deliver=(f,container,site=f.site)=>{f.cmd('loadTruck',{truck:f.truck.id,containers:[container.id]});settle(f);f.cmd('dispatch',{id:f.truck.id,destination:site.id});f.tick(5);f.cmd('unload',{id:f.truck.id});settle(f,60);f.cmd('dispatch',{id:f.truck.id,destination:f.yard.id});f.tick(5);};
const giveBack=(f,container,site=f.site)=>{f.cmd('dispatch',{id:f.truck.id,destination:site.id});f.tick(5);f.cmd('returnStock',{container:container.id,truck:f.truck.id});settle(f,60);f.cmd('dispatch',{id:f.truck.id,destination:f.yard.id});f.tick(5);f.cmd('unload',{id:f.truck.id});settle(f,60);};

test('pieces in the yard per day are rebuilt from the ledger and end on the live yard total',t=>{
  const f=setup(t);// day 1: 200 pieces opened in the yard
  later(t,1);const c=f.container('C',13000,4000);f.cmd('opening',{container:c.id,product:f.products[1].id,quantity:40,reason:'Purchased'});// day 2: +40
  later(t,1);deliver(f,f.a);// day 3: 100 go to the site
  assert.equal(f.sim.repo.get(f.a.id).location,f.site.id);
  later(t,2);f.cmd('stockRemoval',{location:f.yard.id,product:f.products[1].id,quantity:15,reason:'Sold'});// day 5: -15
  later(t,1);giveBack(f,f.a);// day 6: 100 come back
  assert.equal(f.sim.repo.get(f.a.id).location,f.yard.id);
  later(t,1);const count=f.cmd('count',{scope:f.b.id});f.cmd('observe',{id:count.id,observed:[93],reason:'Seven missing'});f.cmd('approveCount',{id:count.id});// day 7: -7
  const live=register(null,f),r=f.sim.reports(30),today='2026-08-09';
  assert.equal(r.today,today);assert.equal(r.from,addDays(today,-29));assert.equal(r.pieces.series.length,30);assert.equal(r.scope,'company');
  assert.deepEqual(r.pieces.check,{rebuilt:live.yard,actual:live.yard,ok:true});assert.equal(live.yard,200+40-15+0-7);
  const by=Object.fromEntries(r.pieces.series.map(p=>[p.day,p.pieces]));
  assert.deepEqual([by['2026-08-02'],by['2026-08-03'],by['2026-08-04'],by['2026-08-05'],by['2026-08-06'],by['2026-08-07'],by['2026-08-08'],by['2026-08-09']],[0,200,240,140,140,125,225,218]);
  assert.equal(r.pieces.now,218);assert.equal(r.pieces.start,0);
  // runs: one loaded delivery and one loaded return; the empty drives are not counted
  assert.equal(r.totals.deliveries,1);assert.equal(r.totals.returns,1);assert.equal(r.totals.piecesOut,100);assert.equal(r.totals.piecesBack,100);
  const week=r.weeks.find(w=>w.week==='2026-08-03');assert.equal(week.deliveries,1);assert.equal(week.returns,1);assert.equal(week.days,7);
  assert.equal(r.weeks.at(-1).week,'2026-08-03');assert.ok(r.weeks[0].days<=7&&r.weeks[0].start===r.from);
  const truck=r.trucks.find(x=>x.id===f.truck.id);assert.equal(truck.runs,2);assert.equal(truck.pieces,200);// two trips left the yard; 100 loaded there, 100 at the site
  assert.deepEqual(r.materials.map(m=>[m.product,m.out,m.back,m.total]),[[f.products[0].id,100,100,200]]);
  const sys=r.systems.find(s=>s.id==='quickstage');assert.equal(sys.yard,218);assert.equal(sys.site,0);assert.equal(sys.name,'Quickstage');
});

test('the rebuilt yard stays equal to the live yard through intake, a repacked part-load and a truck parked at the yard',t=>{
  const f=setup(t);
  f.cmd('stockIntake',{location:f.yard.id,product:f.products[0].id,quantity:260,kind:'PURCHASE'});f.container('Spare',16000,10000);later(t,1);
  // a part-load (repack into an empty stillage) goes on the truck: the pieces sit on the truck at the yard, not in the yard
  const req=f.cmd('request',{site:f.site.id,product:f.products[0].id,quantity:30});f.cmd('allocate',{id:req.id,truck:f.truck.id});settle(f);
  let live=register(null,f),r=f.sim.reports(30);assert.ok(live.truck>0,'something is on the truck');assert.equal(r.pieces.check.rebuilt,live.yard);assert.ok(r.pieces.check.ok);
  f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});f.tick(5);f.cmd('unload',{id:f.truck.id});settle(f,60);later(t,1);
  live=register(null,f);r=f.sim.reports(90);assert.equal(r.pieces.series.length,90);assert.ok(r.pieces.check.ok);assert.equal(r.pieces.now,live.yard);
  assert.equal(r.totals.piecesOut,live.site);assert.equal(r.systems[0].site,live.site);
});

test('after every kind of stock change the rebuilt yard and site totals equal the live register',t=>{
  const f=setup(t),sup=user(f,'sup2@example.com','SUPERVISOR');f.cmd('siteDetails',{id:f.site.id,supervisor:sup.user.id});
  const check=label=>{const live=register(null,f),r=f.sim.reports(30),s=sup.reports(30);
    assert.deepEqual(r.pieces.check,{rebuilt:live.yard,actual:live.yard,ok:true},label+': yard');assert.deepEqual(s.pieces.check,{rebuilt:live.site,actual:live.site,ok:true},label+': site');
    assert.equal(r.pieces.series.at(-1).pieces,live.yard,label+': today is the live yard');assert.equal(s.pieces.series.at(-1).pieces,live.site);
    const bySys=r.systems.reduce((a,x)=>({yard:a.yard+x.yard,site:a.site+x.site,truck:a.truck+x.truck}),{yard:0,site:0,truck:0});assert.deepEqual(bySys,live,label+': stock by system');};
  check('start');f.container('Spare',16000,10000);f.container('Spare 2',16000,4000);
  const req=f.cmd('request',{site:f.site.id,product:f.products[0].id,quantity:30});f.cmd('allocate',{id:req.id,truck:f.truck.id});settle(f);check('part-load on the truck');
  later(t,1);f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});f.tick(5);check('truck at the site');f.cmd('unload',{id:f.truck.id});settle(f,60);check('unloaded at the site');
  const there=f.sim.containers().find(c=>c.location===f.site.id);f.cmd('opening',{container:there.id,product:f.products[1].id,quantity:12,reason:'Found on site'});check('opening at a site');
  later(t,1);f.cmd('returnStock',{container:there.id,truck:f.truck.id});settle(f,60);check('loaded for return');f.cmd('dispatch',{id:f.truck.id,destination:f.yard.id});f.tick(5);f.cmd('unload',{id:f.truck.id});settle(f,60);check('returned');
  later(t,1);f.cmd('stockRemoval',{location:f.yard.id,product:f.products[0].id,quantity:9,reason:'Sold'});check('removal');
  const count=f.cmd('count',{scope:f.yard.id}),n=f.sim.repo.get(count.id,'count').lines.length;f.cmd('observe',{id:count.id,observed:Array.from({length:n},(_,i)=>i===0?1000:0),reason:'Recount'});f.cmd('approveCount',{id:count.id});check('yard stocktake');
  f.cmd('purgeDemo');check('demo purged');assert.equal(register(null,f).yard,0);
});

test('the report is cached by the ledger sequence and replays only new rows',t=>{
  const f=setup(t);const first=f.sim.reports(30);assert.equal(f.sim.reports(30),first,'nothing new: the same result object');
  f.cmd('opening',{container:f.empty.id,product:f.products[0].id,quantity:5,reason:'Found'});const second=f.sim.reports(30);
  assert.notEqual(second,first);assert.ok(second.seq>first.seq);assert.equal(second.pieces.now,first.pieces.now+5);assert.ok(second.pieces.check.ok);
  // another Simulation (another request) on the same database uses the same store
  const again=new Simulation(f.db,f.user).reports(30);assert.equal(again,second);
});

test('supervisors see only their own sites; other roles and bad periods are refused',t=>{
  const f=setup(t);const other=f.cmd('site',{name:'Site B'});f.cmd('resources',{location:other.id,workers:2,machines:1,stepMs:100,speed:100000,jobs:false});
  const sup=user(f,'sup@example.com','SUPERVISOR');f.cmd('siteDetails',{id:f.site.id,supervisor:sup.user.id});
  deliver(f,f.a);deliver(f,f.b,other);later(t,1);
  const own=sup.reports(30);
  assert.equal(own.scope,'sites');assert.deepEqual(own.sites.map(s=>s.id),[f.site.id]);assert.equal(own.trucks,null,'the fleet is company-wide');
  assert.equal(own.pieces.now,100);assert.deepEqual(own.pieces.check,{rebuilt:100,actual:100,ok:true});
  assert.equal(own.totals.deliveries,1);assert.equal(own.totals.piecesOut,100);assert.deepEqual(own.systems.map(s=>[s.id,s.yard,s.site,s.truck]),[['quickstage',0,100,0]]);
  const json=JSON.stringify(own);assert.ok(!json.includes(other.id)&&!json.includes('Site B'),'nothing about the other site');
  const all=f.sim.reports(30);assert.equal(all.totals.deliveries,2);assert.equal(all.pieces.now,0);assert.equal(all.systems[0].site,200);
  assert.throws(()=>f.sim.reports(7),/30 or 90/);assert.throws(()=>f.sim.reports('30'),/30 or 90/);
  const gm=user(f,'gm@example.com','GENERAL_MANAGER');assert.equal(gm.reports(90).scope,'company');
});

test('GET /api/reports: period parameter, login required',async t=>{
  const f=fixture(t);const handler=createApp(f.db).listeners('request')[0];const token=f.auth.login({email:f.user.email,password:'demonstration-password'});
  const call=(url,cookie=true)=>new Promise(done=>{const req={method:'GET',url,headers:{host:'x',...(cookie?{cookie:'session='+token}:{})},socket:{remoteAddress:'127.0.0.1'},async *[Symbol.asyncIterator](){}};let status=200;const res={setHeader(){},writeHead(s){status=s;},end(b){done({status,body:JSON.parse(b)});}};handler(req,res);});
  const ok=await call('/api/reports?days=90');assert.equal(ok.status,200);assert.equal(ok.body.days,90);assert.equal(ok.body.pieces.now,200);
  assert.equal((await call('/api/reports')).body.days,30);assert.equal((await call('/api/reports?days=365')).status,400);assert.equal((await call('/api/reports',false)).status,401);
});

test('50,000 ledger rows: the first report replays them within budget and the next one is served from the store',t=>{
  const f=fixture(t);const {db}=f,company=f.user.company_id;
  // a year of synthetic custody moves between the yard and the site through the forklift (net zero), plus purchases into stillage A
  const fork=f.sim.repo.all('resource').find(r=>r.type==='FORKLIFT'&&r.location===f.yard.id).id,ins=db.prepare('INSERT INTO ledger(id,company_id,actor,event,product_id,container_id,quantity,source,destination,reason,command_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  const t0=Date.now()-360*86400000;let added=0;
  atomic(db,()=>{for(let i=0;i<50000;i++){const when=new Date(t0+i*620000).toISOString(),k=i%5;
    if(k===4){ins.run(randomUUID(),company,f.user.id,'COMMAND',null,null,0,null,null,'x',randomUUID(),when);continue;}
    if(k===0){ins.run(randomUUID(),company,f.user.id,'PURCHASE',f.products[0].id,f.a.id,2,null,f.yard.id,'Bought',randomUUID(),when);added+=2;continue;}
    ins.run(randomUUID(),company,f.user.id,k===1?'PICKUP':k===2?'PLACEMENT':'PICKUP',f.products[0].id,f.b.id,1,k===1?f.yard.id:k===2?fork:f.yard.id,k===1?fork:k===2?f.yard.id:fork,'Moved',randomUUID(),when);
    if(k===3)ins.run(randomUUID(),company,f.user.id,'PLACEMENT',f.products[0].id,f.b.id,1,fork,f.yard.id,'Moved',randomUUID(),when);}
    f.sim.repo.balance(f.a.id,f.products[0].id,added);});
  const t1=performance.now();const r=f.sim.reports(90),cold=performance.now()-t1;
  const t2=performance.now();f.sim.reports(90);const warm=performance.now()-t2;
  const t3=performance.now();f.cmd('opening',{container:f.empty.id,product:f.products[0].id,quantity:1,reason:'One more'});const r2=f.sim.reports(90),step=performance.now()-t3;
  console.log(`50k rows: cold ${cold.toFixed(0)} ms, cached ${warm.toFixed(2)} ms, one new row ${step.toFixed(1)} ms`);
  assert.ok(r.pieces.check.ok,'rebuilt '+r.pieces.check.rebuilt+' vs live '+r.pieces.check.actual);assert.equal(r.pieces.now,200+added);assert.equal(r2.pieces.now,201+added);
  assert.ok(cold<1500,'cold replay took '+cold+' ms');assert.ok(warm<5,'cached read took '+warm+' ms');assert.ok(step<250,'incremental took '+step+' ms');
});

test('a delivery and a return of the same product at the same site on the same day are both counted, not netted to zero',t=>{
  const f=setup(t);later(t,1);
  deliver(f,f.a);let r=f.sim.reports(30);
  assert.deepEqual(r.materials.map(m=>[m.product,m.out,m.back]),[[f.products[0].id,100,0]]);assert.equal(r.totals.piecesOut,100);
  giveBack(f,f.a);// same day: the same stillage comes straight back
  r=f.sim.reports(30);
  assert.deepEqual(r.materials.map(m=>[m.product,m.out,m.back,m.total]),[[f.products[0].id,100,100,200]]);
  assert.equal(r.totals.piecesOut,100);assert.equal(r.totals.piecesBack,100);
  const wk=r.weeks.find(w=>w.piecesOut);assert.equal(wk.piecesOut,100);assert.equal(wk.piecesBack,100);assert.ok(r.pieces.check.ok);
});
