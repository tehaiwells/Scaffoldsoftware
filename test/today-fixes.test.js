process.env.TZ='Australia/Sydney';// each test file runs in its own process; the planner's days and times are Sydney's
import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../src/simulation.js';
import { addDays,dayLabel } from '../src/domain/schedule.js';
import { planFixture,D0,L } from './helpers/plan-fixture.js';
// The Today hub review fixes: the crane crew stays at a site with a delivery, "Anyone free" can fall back on yardsmen, a list that didn't go by
// the end of its day lets its stillages go and waits for a new day, times already gone are refused, short lists top up, and the update cards.
const D1=addDays(D0,1),D2=addDays(D0,2),D3=addDays(D0,3);
const team=(f,names,role='SCAFFOLDER')=>names.map(name=>f.cmd('teamAdd',{name,role}).person.id);
const crewAt=(f,site)=>f.sim.repo.all('resource').filter(r=>r.type==='WORKER'&&r.enabled&&r.location===site).sort((a,b)=>a.name.localeCompare(b.name));
const holds=(f,id)=>f.sim.repo.all('reservation').filter(x=>x.active&&x.plan===id).length;

test("the crane crew: the last hand at a site with a delivery that day can't be booked away; the calendar marks them; a blocked unload says why and goes again when the crew is back",t=>{
  const f=planFixture(t,{now:L(D0,'09:00')});const {p,per}=f.stock(2);const a=f.site('Bondi'),b=f.site('Parramatta');f.cmd('planReplies',{on:false});
  f.cmd('planMaterials',{day:D1,site:a.id,lines:[{product:p.id,quantity:per}]});const [one,two]=crewAt(f,a.id);
  const r=f.cmd('planWorkers',{day:D1,site:b.id,count:3,people:[one.id]});assert.equal(r.item.people.length,3,'one of two can go');
  assert.throws(()=>f.cmd('planAsk',{item:r.item.id,person:two.id,replace:r.item.people[1].person}),/Worker 2 is needed at Bondi that day to work the crane for a delivery\. Pick someone else\./);
  assert.throws(()=>f.cmd('planWorkers',{day:D1,site:b.id,time:'08:00',count:2,people:[two.id]}),/needed at Bondi/);
  const m=f.sim.planMonth(D1.slice(0,7));assert.equal(m.taken[D1].crane[two.id],'Bondi');assert.ok(!m.taken[D1].pool.some(x=>x.id===two.id),'not offered by Anyone free');
  assert.ok(m.taken[D1].people.includes(one.id));assert.ok(!r.item.people.some(x=>x.person===two.id),'auto-pick never took the last crane hand');
  f.cmd('planWorkers',{day:D2,site:b.id,count:2,people:[one.id,two.id]});// no delivery at Bondi that day: both can go
  // both hands away when the truck gets there: the list says so, then unloads once they are back
  const g=planFixture(t,{now:L(D1,'05:00')});const s=g.stock(1);const site=g.site('Bondi');const it=g.cmd('planMaterials',{day:D1,time:'07:00',site:site.id,lines:[{product:s.p.id,quantity:s.per}]}).item.id;
  const away=crewAt(g,site.id);for(const w of away){w.location=g.yard.id;g.sim.repo.save(w);}
  g.clock(D1,'07:00');assert.ok(g.until(()=>/nobody there to work the crane/.test(g.item(it).problem??''),900),g.item(it).problem);
  assert.match(g.item(it).problem,/^T-0\d is waiting at Bondi: nobody there to work the crane\.$/);assert.equal(g.view(it).flags.red,true);
  for(const w of away){const x=g.sim.repo.get(w.id,'resource');x.location=site.id;g.sim.repo.save(x);}
  g.at(L(D1,'07:00')+61000);g.pass();assert.ok(g.until(()=>g.item(it).status==='DONE',900),'unloaded once the crew was back');assert.ok(g.item(it).log.some(l=>/unloading again/.test(l.text)));
});

test('Anyone free: yard scaffolders, spare site crew, then yardsmen as a last resort (never the packer, two stay at the yard); someone who said no is free again',t=>{
  const f=planFixture(t,{now:L(D0,'09:00')});f.cmd('planReplies',{on:false});const {p,per}=f.stock(1);const a=f.site('Bondi'),b=f.site('Parramatta');
  const mat=f.cmd('planMaterials',{day:D2,site:a.id,lines:[{product:p.id,quantity:per}]});const packer=f.item(mat.item.id).packer;
  const r=f.cmd('planWorkers',{day:D2,site:b.id,count:3});const picked=f.item(r.item.id).people.map(x=>f.sim.repo.get(x.person,'resource'));
  assert.equal(picked.length,2,'4 yardsmen, one packs, two stay: two can go');assert.ok(picked.every(w=>f.sim.roleOf(w)==='YARDSMAN'&&w.id!==packer));
  assert.equal(r.message,'3 workers booked for Parramatta on '+dayLabel(D2)+' at 7:00 am. Short by 1: nobody else is free that day. They get a message '+dayLabel(D1)+' at 3:00 pm.');
  const m=f.sim.planMonth(D2.slice(0,7));assert.ok(m.taken[D2].pool.every(x=>x.home===b.id),'only the spare hand of Parramatta, which the form skips for Parramatta');assert.deepEqual(m.taken[D3].pool.length,4,'another day: Parramatta can spare one, two yardsmen, a Bondi hand');
  // a no frees the person for another booking that day
  const [liam]=team(f,['Liam']);const noahOf=()=>null;f.clock(D0,'16:00');const w=f.cmd('planWorkers',{day:D1,site:a.id,count:1,people:[liam]});f.cmd('messageAnswer',{id:f.msgs(w.item.id)[0].id,yes:false,reason:'Crook'});
  const again=f.cmd('planWorkers',{day:D1,site:b.id,count:1,people:[liam]});assert.equal(again.item.people[0].person,liam);
  assert.ok(!f.sim.planMonth(D1.slice(0,7)).taken[D1].people.includes(noahOf(f)));
});

test("MATERIALS end of day: a list that never went lets its stillages go, says why, shows on Today and in the alerts, and waits for a new day",t=>{
  const f=planFixture(t,{now:L(D0,'09:00')});const {p,per}=f.stock(2);const site=f.site();f.cmd('teamStart');f.cmd('planReplies',{on:false});
  const tr=f.cmd('planTruck',{day:D1,truck:f.truck('T-01').id,driver:f.driver('Dave').id});
  const r=f.cmd('planMaterials',{day:D1,site:site.id,lines:[{product:p.id,quantity:per}],truckPlan:tr.item.id});
  f.clock(D1,'07:00');f.pass();assert.match(f.item(r.item.id).problem,/Waiting for Dave to say yes/);assert.ok(holds(f,r.item.id)>0);
  f.clock(D1,'17:00');f.pass();let it=f.item(r.item.id);assert.equal(it.status,'MISSED');assert.equal(it.problem,"Didn't go: Dave never said yes. Pick a new day or cancel it.");
  assert.equal(holds(f,r.item.id),0,'its stillages are free again');assert.ok(f.msgs(r.item.id).every(m=>m.closedAt),'its pack message is closed');
  assert.ok(f.sim.repo.all('notification').some(n=>n.title==="Didn't go"));const v=f.view(it.id);assert.equal(v.words,"Didn't go");assert.equal(v.flags.red,true);assert.equal(v.canMove,true);assert.equal(v.canCancel,true);
  f.clock(D3,'09:00');const tv=f.sim.todayView();assert.ok(tv.beginToday.missed.some(x=>x.id===it.id));assert.match(tv.summary.sentence,/1 booking didn't go/);
  assert.ok(f.sim.snapshot().alerts.items.some(x=>x.kind==='MISSED'&&x.target.day===D1&&/Dave never said yes/.test(x.detail)));assert.ok(f.sim.planMonth(D3.slice(0,7)).missed.some(x=>x.id===it.id));
  f.pass();assert.equal(f.item(it.id).status,'MISSED','the engine leaves it alone');
  assert.throws(()=>f.cmd('planMove',{id:it.id,time:'08:00'}),/Pick a new day for it\./);
  f.cmd('planMove',{id:it.id,day:addDays(D3,1)});it=f.item(it.id);assert.equal(it.status,'PLANNED');assert.equal(it.stage,'WAITING');assert.equal(it.problem,null);
  // nothing in the yard all day: it ends the same way
  const none=f.cmd('planMaterials',{day:addDays(D3,2),site:site.id,lines:[{product:f.stock(0,x=>x.id!==p.id).p.id,quantity:5}]});f.clock(addDays(D3,2),'07:00');f.pass();f.clock(addDays(D3,2),'17:00');f.pass();
  assert.equal(f.item(none.item.id).problem,"Didn't go: nothing on the list was free in the yard. Pick a new day or cancel it.");f.cmd('planCancel',{id:none.item.id});assert.equal(f.item(none.item.id).status,'CANCELLED');
});

test('booking: a time already gone today is refused, the day after 5 pm too; the stock check is made before anything is packed',t=>{
  const f=planFixture(t,{now:L(D0,'12:00')});const s=f.site();team(f,['Liam']);f.cmd('teamStart');const {p,per}=f.stock(1);
  assert.throws(()=>f.cmd('planWorkers',{day:D0,time:'07:00',site:s.id,count:1}),/That time has passed\. Choose a later time or tomorrow\./);
  assert.throws(()=>f.cmd('planTruck',{day:D0,time:'12:00',truck:f.truck('T-01').id}),/That time has passed/);
  assert.throws(()=>f.cmd('planRestack',{day:D0,time:'11:30'}),/That time has passed/);
  const ok=f.cmd('planMaterials',{day:D0,time:'12:00',site:s.id,lines:[{product:p.id,quantity:per}]});assert.doesNotMatch(ok.message,/Only/,'what it just packed is not counted against it');
  assert.throws(()=>f.cmd('planMove',{id:ok.item.id,time:'09:00'}),/That time has passed|already loading/);
  f.clock(D0,'17:00');assert.throws(()=>f.cmd('planMaterials',{day:D0,time:'17:00',site:s.id,lines:[{product:p.id,quantity:1}]}),/Today is nearly over\. Choose tomorrow or a later day\./);
  assert.match(f.cmd('planWorkers',{day:D1,site:s.id,count:1}).message,/They've been sent a message\./);
});

test('the Office crew reset calls off the plans of the people it switches off; a list never takes a truck whose driver has not said yes; a short list tops up',t=>{
  const f=planFixture(t,{now:L(D0,'09:00')});const s=f.site();const [liam]=team(f,['Liam']);f.cmd('planReplies',{on:false});
  const w=f.cmd('planWorkers',{day:D2,site:s.id,count:1,people:[liam]});f.cmd('resources',{location:f.yard.id,workers:4,machines:2});
  assert.equal(f.sim.repo.get(liam,'resource').enabled,false);assert.equal(f.item(w.item.id).people.length,0);assert.match(f.item(w.item.id).problem,/Short by 1/);assert.equal(f.view(w.item.id).flags.red,true);
  // T-01 is booked today with Dave, who can't make it: an unlinked list goes on T-02, never on T-01
  const g=planFixture(t,{now:L(D1,'05:00')});g.cmd('teamStart');g.cmd('planReplies',{on:false});const x=g.stock(1),site=g.site();
  const tr=g.cmd('planTruck',{day:D1,truck:g.truck('T-01').id,driver:g.driver('Dave').id});g.cmd('messageAnswer',{id:g.msgs(tr.item.id)[0].id,yes:false,reason:'Crook'});
  const r=g.cmd('planMaterials',{day:D1,site:site.id,lines:[{product:x.p.id,quantity:x.per}]});g.clock(D1,'07:00');g.pass();assert.equal(g.item(r.item.id).trips[0].truck,g.truck('T-02').id);
  // packed short, then more of it comes into the yard: topped up before the truck goes
  const h=planFixture(t,{now:L(D0,'09:00')});const y=h.stock(1),hs=h.site();const l=h.cmd('planMaterials',{day:D1,site:hs.id,lines:[{product:y.p.id,quantity:y.per*2}]});
  h.clock(D1,'06:00');h.pass();let it=h.item(l.item.id);assert.equal(it.stage,'PACKED','yard jobs are off: the office packs it at 6:00');assert.equal(it.held.length,1);assert.equal(it.short.length,1);
  h.cmd('gameAddStock',{lines:[{product:y.p.id,quantity:y.per}]});h.pass();it=h.item(l.item.id);
  assert.equal(it.short.length,0,'topped up');assert.ok(it.log.some(e=>/^Topped up: 1 more stillage set aside\. Nothing is short now\.$/.test(e.text)));
});

test("small fixes: -1 truck never removes a hire truck; a supervisor never sees another site's allocation; an answer can't change once they are on site; re-stack with nothing to do is 'already tidy'",t=>{
  const f=planFixture(t,{now:L(D0,'09:00')});f.cmd('planTruck',{day:D1,hire:{size:'BIG'}});f.clock(D1,'06:00');f.pass();
  f.cmd('quickAdjust',{kind:'TRUCK',delta:-1,location:f.yard.id,payload:12500000});assert.deepEqual(f.sim.repo.all('truck').filter(x=>x.retired).map(x=>x.name),['T-02']);
  const g=planFixture(t,{now:L(D0,'09:00')});const a=g.site('Bondi'),b=g.site('Parramatta');g.auth.addUser(g.user,{name:'Sue',email:'sue-fix@example.com',password:'demonstration-password',roles:['SUPERVISOR']});
  const sup=new Simulation(g.db,g.auth.authenticate(g.auth.login({email:'sue-fix@example.com',password:'demonstration-password'})));g.cmd('siteDetails',{id:a.id,supervisor:sup.user.id});
  const w=crewAt(g,a.id)[0];g.cmd('planWorkers',{day:D0,time:'17:00',site:b.id,count:1,people:[w.id]});assert.equal(sup.personView('worker',w.id).today,null);assert.ok(g.sim.personView('worker',w.id).today);
  const h=planFixture(t,{now:L(D0,'16:00')});const s=h.site();const [liam]=team(h,['Liam']);h.cmd('planReplies',{on:false});const r=h.cmd('planWorkers',{day:D1,site:s.id,count:1,people:[liam]});const m=h.msgs(r.item.id)[0];
  h.cmd('messageAnswer',{id:m.id,yes:true,via:'PHONE_VIEW'});h.clock(D1,'07:00');h.pass();assert.throws(()=>h.cmd('messageAnswer',{id:m.id,yes:false}),/Liam is already at Bondi and comes home at 5 pm\./);
  const rs=h.cmd('planRestack',{day:D1,time:'08:00'});h.cmd('jobsMode',{jobs:true});h.clock(D1,'08:00');h.pass();h.at(L(D1,'08:00')+61000);h.pass();h.at(L(D1,'08:00')+125000);h.pass();
  assert.equal(h.view(rs.item.id).words,'Done: the yard was already tidy');h.clock(D2,'09:00');assert.ok(!h.sim.todayView().yesterdayDone.lines.some(l=>/Re-stack/.test(l.words)),'not news');
});

test('names: the demo crew get first names once (teamNames), people rows say where a "Worker n" belongs, and a message never says "Hi Worker"',t=>{
  const f=planFixture(t,{now:L(D0,'16:00')});const a=f.site('Bondi');f.cmd('planReplies',{on:false});
  let v=f.sim.teamView();assert.equal(v.needsNames,true);const row=v.people.find(p=>p.name==='Worker 1'&&p.where==='Bondi');assert.equal(row.label,'Worker 1 (Bondi)');
  const w=f.cmd('planWorkers',{day:D1,site:a.id,count:1,people:[crewAt(f,f.yard.id)[0].id]});assert.equal(f.msgs(w.item.id)[0].text.slice(0,9),'Hi there,');assert.equal(f.view(w.item.id).people[0].name,'Worker 1 (Main yard)');
  const n=f.cmd('teamNames');assert.equal(n.named,6);v=f.sim.teamView();assert.equal(v.needsNames,false);const names=v.people.filter(p=>p.kind==='worker').map(p=>p.name);assert.equal(new Set(names).size,names.length,'every name different');
  assert.ok(v.people.filter(p=>p.kind==='worker').every(p=>p.demoName),'still marked as demo names');assert.equal(f.cmd('teamNames').named,0,'once');
  const first=v.people.find(p=>p.kind==='worker'&&p.where==='Main yard');f.cmd('teamUpdate',{id:first.id,name:'Kev'});assert.equal(f.sim.teamView().people.find(p=>p.id===first.id).demoName,false);
});

test("the update cards: who is at a site now (no double counting), Crew on site, Next skips what is under way, tomorrow's can't-make-it, nobody booked, the board's trips, a low-stock warning, hire built up",t=>{
  const f=planFixture(t,{now:L(D0,'16:00')});f.cmd('planReplies',{on:false});const a=f.site('Bondi'),b=f.site('Parramatta');const {p,per}=f.stock(3);const [liam,noah]=team(f,['Liam','Noah']);
  const own=crewAt(f,b.id)[0];const w=f.cmd('planWorkers',{day:D1,site:b.id,count:3,people:[liam,noah,own.id]});
  for(const m of f.msgs(w.item.id))f.cmd('messageAnswer',{id:m.id,yes:m.person!==noah,reason:m.person===noah?'Crook':null});
  let v=f.sim.todayView();assert.equal(v.roster.tomorrow.cantMake,1);assert.match(v.roster.tomorrow.words,/^1 person can't make it tomorrow: pick someone else/);assert.match(v.summary.sentence,/Tomorrow: 1 person can't make it/);
  assert.equal(v.roster.sub,'Nobody booked to a site today');
  f.clock(D1,'06:00');v=f.sim.todayView();const row=()=>v.sites.find(s=>s.id===b.id);assert.equal(row().whoWords,'2 site crew · Liam from 7:00 am','its own hand is already there');
  assert.ok(v.roster.onSite.every(r=>r.coming&&/^Going to Parramatta at 7:00 am$/.test(r.words)));
  f.clock(D1,'07:00');f.pass();v=f.sim.todayView();assert.equal(row().whoWords,'Liam + 2 site crew','its own worker is counted once');assert.equal(row().stage,'Crew on site');assert.equal(row().next,null,'the item under way is not next');
  f.clock(D1,'17:00');f.pass();v=f.sim.todayView();assert.equal(row().whoWords,'2 site crew','gone home');
  // a board send today: on the calendar and where we begin today, with the pieces it is taking
  f.clock(D1,'17:30');f.cmd('gameSend',{site:a.id,lines:[{product:p.id,quantity:per}]});const m=f.sim.planMonth(D1.slice(0,7)),trip=m.runs.find(r=>r.kind==='trip');
  assert.ok(trip&&trip.day===D1&&trip.siteName==='Bondi'&&trip.pieces===per,JSON.stringify(trip));v=f.sim.todayView();assert.ok(v.beginToday.items.some(i=>i.kind==='trip'&&/Bondi/.test(i.words)));assert.equal(v.sites.find(s=>s.id===a.id).stage,'Gear on the way');
  // a list above what is free in the yard: amber before its day
  const big=f.cmd('planMaterials',{day:D3,site:a.id,lines:[{product:p.id,quantity:per*9}]});const bv=f.view(big.item.id);assert.equal(bv.flags.warn,true);assert.match(bv.lowWords,/^Only \d+ of .+ in the yard now: \d+ short$/);
  // hire built up since it began (nothing is invoiced in the app yet)
  f.cmd('hireRate',{product:p.id,week:7000});const money=f.sim.todayView().business.money;assert.equal(money.toInvoiceWords,'Built up since hire began, to invoice (incl. GST)');assert.ok(money.toInvoice>=money.builtUp);
});
