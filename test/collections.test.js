process.env.TZ='Australia/Sydney';// the server's local day is Sydney's
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Simulation } from '../src/simulation.js';
import { fixture } from './simulation.test.js';

// Scheduled returns (collections): validation, permissions, the status flow through the real engine, the schedule, alerts and reports.
const WED=Date.parse('2026-09-23T00:00:00Z');// Wednesday 23 Sep 2026, 10:00 in Sydney
const TODAY='2026-09-23',TOMORROW='2026-09-24',FRI='2026-09-25';
const setup=t=>{const f=fixture(t);t.mock.timers.enable({apis:['Date'],now:WED});return f;};
const clock=(t,iso)=>t.mock.timers.setTime(Date.parse(iso));
const settle=(f,n=150)=>{f.tick(n);for(const task of f.sim.tasks().filter(t=>t.state==='BLOCKED'))f.cmd('retry',{id:task.id});f.tick(n);};
const user=(f,email,role)=>{f.auth.addUser(f.user,{name:role==='SUPERVISOR'?'Sam Supervisor':role,email,password:'demonstration-password',roles:[role]});const u=f.auth.authenticate(f.auth.login({email,password:'demonstration-password'}));return new Simulation(f.db,u);};
const as=(sim,action,input)=>sim.execute(action,input,randomUUID());
const view=(f,id,sim=f.sim)=>sim.snapshot().collections.find(c=>c.id===id);
const coll=(f,id)=>f.sim.repo.get(id,'collection');
// Takes A and B (100 pieces each) to Site A on T01 and leaves the truck parked there, empty.
const stockOnSite=f=>{f.cmd('loadTruck',{truck:f.truck.id,containers:[f.a.id,f.b.id]});settle(f);f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});f.tick(5);f.cmd('unload',{id:f.truck.id});settle(f);
  assert.equal(f.sim.repo.get(f.a.id).location,f.site.id);assert.equal(f.sim.repo.get(f.b.id).location,f.site.id);assert.equal(f.sim.repo.get(f.truck.id).status,'AT_SITE');};
const home=f=>{f.cmd('dispatch',{id:f.truck.id,destination:f.yard.id});f.tick(5);};

test('requestCollection validates the site, what to collect, the date, window and notes',t=>{
  const f=setup(t);
  assert.throws(()=>f.cmd('requestCollection',{site:f.site.id,neededOn:TOMORROW}),/Nothing is on Site A to collect/);
  stockOnSite(f);
  assert.throws(()=>f.cmd('requestCollection',{site:'nope',neededOn:TOMORROW}),/Record not found/);
  assert.throws(()=>f.cmd('requestCollection',{site:f.yard.id,neededOn:TOMORROW}),/Record not found/,'a yard is not a site');
  assert.throws(()=>f.cmd('requestCollection',{site:f.site.id}),/Choose a needed-on date/);
  assert.throws(()=>f.cmd('requestCollection',{site:f.site.id,neededOn:'2026-09-22'}),/cannot be in the past/);
  assert.throws(()=>f.cmd('requestCollection',{site:f.site.id,neededOn:'23/09/2026'}),/YYYY-MM-DD/);
  assert.throws(()=>f.cmd('requestCollection',{site:f.site.id,neededOn:'2027-12-01'}),/within the next 12 months/);
  assert.throws(()=>f.cmd('requestCollection',{site:f.site.id,neededOn:TOMORROW,slot:'NIGHT'}),/delivery window/);
  assert.throws(()=>f.cmd('requestCollection',{site:f.site.id,neededOn:TOMORROW,scope:'SOME'}),/everything on site or the stillages/);
  assert.throws(()=>f.cmd('requestCollection',{site:f.site.id,neededOn:TOMORROW,scope:'SELECTED',containers:[]}),/Tick the stillages/);
  assert.throws(()=>f.cmd('requestCollection',{site:f.site.id,neededOn:TOMORROW,scope:'SELECTED',containers:[f.empty.id]}),/must be on Site A now/,'a yard stillage cannot be collected from the site');
  assert.throws(()=>f.cmd('requestCollection',{site:f.site.id,neededOn:TOMORROW,notes:'x'.repeat(501)}),/at most 500/);
  assert.throws(()=>f.cmd('requestCollection',{site:f.site.id,neededOn:TOMORROW,truck:'nope'}),/Record not found/);
  const c=f.cmd('requestCollection',{site:f.site.id,neededOn:TOMORROW,slot:'PM',scope:'SELECTED',containers:[f.a.id,f.a.id],notes:'  Gate code 1234  '});
  assert.equal(c.status,'REQUESTED');assert.deepEqual(c.containers,[f.a.id],'duplicates dropped');assert.equal(c.notes,'Gate code 1234');assert.equal(c.slot,'PM');assert.match(c.message,/Collection from Site A booked for Thu 24 Sep \(PM\): 1 stillage\. It needs a truck\./);
  assert.throws(()=>f.cmd('requestCollection',{site:f.site.id,neededOn:FRI,scope:'SELECTED',containers:[f.a.id]}),/A is already on the collection for Thu 24 Sep/);
  assert.throws(()=>f.cmd('requestCollection',{site:f.site.id,neededOn:FRI}),/already booked for Thu 24 Sep/,'everything-on-site overlaps any open collection');
  const b=f.cmd('requestCollection',{site:f.site.id,neededOn:FRI,scope:'SELECTED',containers:[f.b.id],truck:f.truck.id});assert.equal(b.status,'BOOKED');assert.equal(b.plannedTruck,f.truck.id);
  assert.equal(f.sim.repo.all('notification').filter(n=>n.title==='Collection requested').length,2);
});

test('supervisors request, reschedule and cancel collections for their own sites but never book or load a truck',t=>{
  const f=setup(t);stockOnSite(f);const sup=user(f,'sup@example.com','SUPERVISOR');
  assert.throws(()=>as(sup,'requestCollection',{site:f.site.id,neededOn:TOMORROW}),/assigned sites/);
  f.cmd('siteDetails',{id:f.site.id,supervisor:sup.user.id});
  const other=f.cmd('site',{name:'Site B'});assert.throws(()=>as(sup,'requestCollection',{site:other.id,neededOn:TOMORROW}),/assigned sites/);
  assert.throws(()=>as(sup,'requestCollection',{site:f.site.id,neededOn:TOMORROW,truck:f.truck.id}),/Only the yard office can book a truck/);
  const c=as(sup,'requestCollection',{site:f.site.id,neededOn:TOMORROW});assert.equal(c.status,'REQUESTED');
  const v=view(f,c.id,sup);assert.ok(v,'the supervisor sees the collection');assert.equal(v.canReschedule,true);assert.equal(v.canCancel,true);assert.equal(v.canLoad,false);assert.equal(v.requestedBy,'Sam Supervisor');
  assert.throws(()=>as(sup,'bookTruck',{id:c.id,truck:f.truck.id}),/role does not allow/);
  assert.throws(()=>as(sup,'loadCollection',{id:c.id}),/role does not allow/);
  const r=as(sup,'reschedule',{id:c.id,neededOn:FRI,slot:'AM'});assert.equal(r.changed,true);assert.equal(r.kind,'collection');assert.match(r.message,/now needed Fri 25 Sep \(AM\) \(was Thu 24 Sep\)/);
  assert.equal(coll(f,c.id).neededOn,FRI);
  // a collection on a site the supervisor does not run stays hidden from them and cannot be touched
  f.cmd('siteDetails',{id:f.site.id,supervisor:null});
  assert.equal(sup.snapshot().collections.length,0,'no longer their site: nothing shown');
  assert.throws(()=>as(sup,'cancelCollection',{id:c.id}),/assigned sites/);
  assert.throws(()=>as(sup,'reschedule',{id:c.id,neededOn:FRI}),/assigned sites/);
  f.cmd('siteDetails',{id:f.site.id,supervisor:sup.user.id});
  const done=as(sup,'cancelCollection',{id:c.id,reason:'Job extended'});assert.equal(done.status,'CANCELLED');assert.equal(coll(f,c.id).reason,'Job extended');
  assert.throws(()=>as(sup,'cancelCollection',{id:c.id}),/already cancelled/);
});

test('the full flow: requested, booked, loaded by the site crane, on the way, unloaded at the yard, returned; stock never teleports',t=>{
  const f=setup(t);stockOnSite(f);home(f);
  const c=f.cmd('requestCollection',{site:f.site.id,neededOn:TODAY,slot:'AM',notes:'Back gate'});
  assert.throws(()=>f.cmd('loadCollection',{id:c.id}),/Book a truck/);
  let r=f.cmd('bookTruck',{id:c.id,truck:f.truck.id});assert.equal(r.changed,true);assert.match(r.message,/T01 booked for Collection from Site A on Wed 23 Sep/);assert.equal(coll(f,c.id).status,'BOOKED');
  assert.equal(f.cmd('bookTruck',{id:c.id,truck:f.truck.id}).changed,false);
  let s=f.sim.snapshot(),v=s.collections.find(x=>x.id===c.id);
  assert.equal(v.kind,'collection');assert.equal(v.urgency,'TODAY');assert.equal(v.runTruck,f.truck.id);assert.equal(v.runTruckName,'T01');assert.equal(v.stillages,2);assert.equal(v.pieces,200);assert.equal(v.schedulable,true);assert.equal(v.canLoad,false,'the truck is at the yard');assert.equal(v.truckHere,false);
  const run=s.trucks.find(x=>x.id===f.truck.id).nextRuns.find(x=>x.id===c.id);assert.ok(run,'the truck lists it in Next runs');assert.equal(run.kind,'collection');assert.equal(run.pieces,200);
  assert.throws(()=>f.cmd('loadCollection',{id:c.id}),/T01 is not at Site A yet/);
  f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});f.tick(5);
  assert.equal(view(f,c.id).canLoad,true);
  const total=f.total();
  r=f.cmd('loadCollection',{id:c.id});assert.equal(r.status,'LOADING');assert.equal(r.tasks.length,2);assert.deepEqual(r.left,[]);assert.match(r.message,/Loading 2 stillages \(A, B\) onto T01 at Site A/);
  assert.ok(r.tasks.every(x=>x.handling===f.site.id&&x.from===f.site.id&&x.to===f.truck.id),'moves run through the site crane onto the truck');
  assert.throws(()=>f.cmd('loadCollection',{id:c.id}),/already loading/);
  assert.throws(()=>f.cmd('reschedule',{id:c.id,neededOn:FRI}),/is loading/);
  assert.throws(()=>f.cmd('bookTruck',{id:c.id,truck:null}),/is loading/);
  v=view(f,c.id);assert.equal(v.status,'LOADING');assert.equal(v.schedulable,false);assert.equal(v.pieces,200);assert.equal(v.stillages,2);
  f.tick(3);assert.equal(f.total(),total,'mid-lift the stock is counted on the crane');
  settle(f);assert.equal(f.sim.repo.get(f.a.id).location,f.truck.id);assert.equal(f.sim.repo.get(f.b.id).location,f.truck.id);assert.equal(view(f,c.id).loaded,2);assert.equal(coll(f,c.id).status,'LOADING');
  f.cmd('dispatch',{id:f.truck.id,destination:f.yard.id});
  const o=coll(f,c.id);assert.equal(o.status,'ON THE WAY');assert.ok(o.delivery);assert.equal(f.sim.repo.get(o.delivery,'delivery').collection,c.id,'the trip back carries the collection');
  assert.throws(()=>f.cmd('cancelCollection',{id:c.id}),/has left the site/);
  f.tick(5);f.cmd('unload',{id:f.truck.id});settle(f);
  const done=coll(f,c.id);assert.equal(done.status,'RETURNED');assert.equal(done.inYard,2);assert.ok(done.returnedAt);assert.equal(f.sim.repo.get(f.a.id).location,f.yard.id);assert.equal(f.total(),total);
  v=view(f,c.id);assert.equal(v.urgency,'DONE');assert.equal(v.pieces,200);
  const titles=f.sim.repo.all('notification').map(n=>n.title);for(const x of ['Collection requested','Truck booked','Collection loading','Collection on the way','Collection returned'])assert.ok(titles.includes(x),x);
  // custody: every lift and set-down is in the ledger, and the reports see a return trip with its pieces
  const ledger=f.sim.repo.history(1000).filter(l=>l.container_id===f.a.id);assert.ok(ledger.some(l=>l.event==='PICKUP'&&l.source===f.site.id));assert.ok(ledger.some(l=>l.event==='PLACEMENT'&&l.destination===f.truck.id));assert.ok(ledger.some(l=>l.event==='PLACEMENT'&&l.destination===f.yard.id));
  const rep=f.sim.reports(30);assert.equal(rep.totals.returns,1);assert.equal(rep.totals.piecesBack,200);
});

test('loading leaves what cannot go (a damaged stillage) on site with its reason and loads the rest',t=>{
  const f=setup(t);stockOnSite(f);
  f.cmd('condition',{id:f.b.id,condition:'DAMAGED',reason:'Bent frame'});
  // nothing loadable: nothing changes
  const d=f.cmd('requestCollection',{site:f.site.id,neededOn:FRI,scope:'SELECTED',containers:[f.b.id]});
  assert.throws(()=>f.cmd('loadCollection',{id:d.id,truck:f.truck.id}),/Nothing could be loaded. B: .*damaged/);assert.equal(coll(f,d.id).status,'REQUESTED');assert.equal(f.sim.tasks().filter(t=>t.state==='QUEUED').length,0);
  f.cmd('cancelCollection',{id:d.id});
  const c=f.cmd('requestCollection',{site:f.site.id,neededOn:TODAY,truck:f.truck.id});
  const r=f.cmd('loadCollection',{id:c.id});assert.equal(r.tasks.length,1);assert.equal(r.left.length,1);assert.equal(r.left[0].name,'B');assert.match(r.left[0].reason,/damaged/);assert.match(r.message,/Left on site: B/);
  settle(f);assert.equal(f.sim.repo.get(f.a.id).location,f.truck.id);assert.equal(f.sim.repo.get(f.b.id).location,f.site.id);
  const v=view(f,c.id);assert.equal(v.left[0].name,'B');assert.equal(v.stillages,1);assert.equal(v.pieces,100);
  home(f);f.cmd('unload',{id:f.truck.id});settle(f);assert.equal(coll(f,c.id).status,'RETURNED');assert.equal(coll(f,c.id).inYard,1);
});

test('cancelling while loading cancels the unstarted moves; cancelled moves put a collection back to booked; a removed truck unbooks it',t=>{
  const f=setup(t);stockOnSite(f);
  const c=f.cmd('requestCollection',{site:f.site.id,neededOn:TODAY,truck:f.truck.id});f.cmd('loadCollection',{id:c.id});
  const x=f.cmd('cancelCollection',{id:c.id});assert.equal(x.status,'CANCELLED');assert.equal(f.sim.tasks().filter(t=>t.state!=='CANCELLED'&&t.to===f.truck.id&&t.state!=='COMPLETE').length,0);assert.equal(f.sim.snapshot().reservedTotal,0);
  assert.equal(f.sim.repo.get(f.a.id).location,f.site.id,'nothing moved');
  const d=f.cmd('requestCollection',{site:f.site.id,neededOn:TODAY,truck:f.truck.id});const r=f.cmd('loadCollection',{id:d.id});
  for(const task of r.tasks.slice().reverse())f.cmd('cancel',{id:task.id});
  assert.equal(coll(f,d.id).status,'BOOKED','its moves were cancelled in Movement activity');assert.deepEqual(coll(f,d.id).tasks,[]);
  home(f);f.cmd('retire',{id:f.truck.id});const o=coll(f,d.id);assert.equal(o.status,'REQUESTED');assert.equal(o.plannedTruck,null);assert.ok(f.sim.repo.all('notification').some(n=>n.title==='Truck booking removed'&&/Collection from Site A needs a truck again/.test(n.body)));
});

test('stillages unloaded back onto the site put the collection back to booked',t=>{
  const f=setup(t);stockOnSite(f);
  const c=f.cmd('requestCollection',{site:f.site.id,neededOn:TODAY,truck:f.truck.id});f.cmd('loadCollection',{id:c.id});settle(f);
  f.cmd('unload',{id:f.truck.id});settle(f);// put back down on the site
  const o=coll(f,c.id);assert.equal(o.status,'BOOKED');assert.deepEqual(o.taken,[]);assert.equal(view(f,c.id).canLoad,true,'it can be loaded again');
  home(f);assert.equal(coll(f,c.id).status,'BOOKED');
});

test('schedule: collections are runs with clashes counted against yard lists, and overdue or unbooked-today ones raise alerts',t=>{
  const f=setup(t);stockOnSite(f);home(f);
  const siteB=f.cmd('site',{name:'Site B'});
  const list=f.cmd('createLoadList',{site:siteB.id,lines:[{product:f.products[0].id,quantity:10}],neededOn:TOMORROW});f.cmd('bookTruck',{id:list.id,truck:f.truck.id});
  const c=f.cmd('requestCollection',{site:f.site.id,neededOn:TOMORROW,slot:'AM'});
  let s=f.sim.snapshot();assert.equal(s.collections.find(x=>x.id===c.id).clash,0);
  const r=f.cmd('bookTruck',{id:c.id,truck:f.truck.id});assert.equal(r.clash,1);assert.match(r.message,/Clash/);
  s=f.sim.snapshot();const v=s.collections.find(x=>x.id===c.id);assert.equal(v.clash,1);assert.equal(v.clashWith[0].id,list.id);assert.equal(s.loadLists.find(l=>l.id===list.id).clash,1,'the yard list sees the collection');
  const clash=s.alerts.items.find(a=>a.kind==='CLASH');assert.ok(clash);assert.match(clash.detail,/Site A \(collection\)/);assert.match(clash.detail,/Site B/);
  assert.equal(f.sim.clashIndex().get(list.id)?.count,1,'the command-side index reads collections too');
  // unbooked and needed today -> due today; days later -> overdue with the days late
  f.cmd('bookTruck',{id:c.id,truck:null});f.cmd('reschedule',{id:c.id,neededOn:TODAY});
  s=f.sim.snapshot();let a=s.alerts.items.find(x=>x.id==='DUE_TODAY:'+c.id);assert.ok(a);assert.match(a.detail,/Collection · needed today \(AM\) · no truck booked/);assert.deepEqual(a.target,{view:'SCHEDULE',id:c.id,day:TODAY});
  clock(t,'2026-09-25T00:00:00Z');
  s=f.sim.snapshot();a=s.alerts.items.find(x=>x.id==='OVERDUE:'+c.id);assert.ok(a);assert.equal(a.severity,'high');assert.equal(a.daysLate,2);assert.match(a.detail,/was needed Wed 23 Sep \(2 days late\) · no truck booked/);
  assert.equal(s.alerts.count,s.alerts.items.length);assert.ok(s.alerts.items.findIndex(x=>x.id==='OVERDUE:'+c.id)<s.alerts.items.findIndex(x=>x.kind==='DAMAGED'||x.kind==='LOW_STOCK')||!s.alerts.items.some(x=>x.kind==='DAMAGED'));
  f.cmd('cancelCollection',{id:c.id});assert.ok(!f.sim.snapshot().alerts.items.some(x=>x.id.endsWith(c.id)),'a cancelled collection raises nothing');
});

test('a site emptied another way closes its open collection, and the site can then be archived',t=>{
  const f=setup(t);stockOnSite(f);const c=f.cmd('requestCollection',{site:f.site.id,neededOn:TOMORROW});
  f.cmd('loadTruck',{truck:f.truck.id,containers:[f.a.id,f.b.id]});settle(f);home(f);f.cmd('unload',{id:f.truck.id});settle(f);
  assert.equal(coll(f,c.id).status,'CANCELLED');assert.match(coll(f,c.id).reason,/Nothing left on site/);f.cmd('archive',{id:f.site.id});
  const o=coll(f,c.id);assert.equal(o.status,'CANCELLED');assert.match(o.reason,/Nothing left on site/,'closed once, not again by the archive');
});
