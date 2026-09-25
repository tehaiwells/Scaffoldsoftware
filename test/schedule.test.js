process.env.TZ='Australia/Sydney';// each test file runs in its own process; the server's local day is Sydney's
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { atomic } from '../src/database.js';
import { Simulation } from '../src/simulation.js';
import { fixture } from './simulation.test.js';
import { addDays,dayLabel,calendarNow,parseDay,weekdayOf,mondayOf,urgencyOf,ladderBucket,whenWords } from '../src/domain/schedule.js';

const WED=Date.parse('2026-09-23T00:00:00Z');// Wednesday 23 Sep 2026, 10:00 in Sydney (AEST, UTC+10)
const TODAY='2026-09-23',TOMORROW='2026-09-24';
const mocked=new WeakSet();// a second fixture in the same test resets the clock instead of enabling the mock twice
const setup=(t,now=WED)=>{const f=fixture(t);if(mocked.has(t))t.mock.timers.setTime(now);else{t.mock.timers.enable({apis:['Date'],now});mocked.add(t);}return f;};
const clock=(t,iso)=>t.mock.timers.setTime(Date.parse(iso));
const createList=(f,extra={},quantity=10,sim=null)=>{const input={site:f.site.id,lines:[{product:f.products[0].id,quantity}],...extra};return sim?sim.execute('createLoadList',input,randomUUID()):f.cmd('createLoadList',input);};
const view=(f,id,sim=f.sim)=>{const s=sim.snapshot();return s.loadLists.find(l=>l.id===id)??s.requests.find(r=>r.id===id);};
const notes=f=>f.sim.repo.all('notification');
const settle=(f,n=150)=>{f.tick(n);for(const task of f.sim.tasks().filter(t=>t.state==='BLOCKED'))f.cmd('retry',{id:task.id});f.tick(n);};
const secondSite=f=>{const s=f.cmd('site',{name:'Site B'});f.cmd('resources',{location:s.id,workers:2,machines:1,stepMs:100,speed:100000,jobs:false});return s;};
const secondTruck=(f,name='T02')=>f.cmd('truck',{name,yard:f.yard.id});
const jobsOn=f=>f.cmd('jobsMode',{jobs:true,routineJobs:false});
const refresh=f=>atomic(f.db,()=>f.sim.refreshJobs(f.sim.repo.get(f.yard.id)));
const liveJob=(f,key)=>f.sim.repo.all('job').find(j=>j.key===key&&['OPEN','ASSIGNED','IN_PROGRESS','BLOCKED'].includes(j.state));
const user=(f,email,role)=>{f.auth.addUser(f.user,{name:role,email,password:'demonstration-password',roles:[role]});const u=f.auth.authenticate(f.auth.login({email,password:'demonstration-password'}));return new Simulation(f.db,u);};
const deliverList=(f,id,truck=f.truck.id,site=f.site.id)=>{f.cmd('allocateLoadList',{id,truck});settle(f);f.cmd('dispatch',{id:truck,destination:site});f.tick(5);f.cmd('unload',{id:truck});settle(f,60);};
const MSG={required:'Choose a needed-on date.',format:'Enter the needed-on date as YYYY-MM-DD.',past:'The needed-on date cannot be in the past. Choose today or later.',far:'Choose a needed-on date within the next 12 months.',slot:'Choose a delivery window: any time, morning or afternoon.'};

test('pure day helpers work on the string and never use the UTC date',()=>{
  assert.equal(addDays('2026-09-30',1),'2026-10-01');assert.equal(addDays('2026-10-04',1),'2026-10-05','DST start in Sydney does not shift the day');assert.equal(addDays('2026-03-01',-1),'2026-02-28');
  assert.equal(weekdayOf('2026-09-28'),0);assert.equal(weekdayOf('2026-09-27'),6);assert.equal(mondayOf('2026-09-27'),'2026-09-21');assert.equal(mondayOf('2026-09-28'),'2026-09-28');
  assert.equal(dayLabel('2026-09-28'),'Mon 28 Sep');assert.equal(dayLabel('2026-10-01'),'Thu 1 Oct');
  const cal=calendarNow(new Date(WED));assert.equal(whenWords('2026-09-21',cal),'overdue (was needed Mon 21 Sep)');assert.equal(whenWords(TODAY,cal),'needed today');assert.equal(whenWords(TOMORROW,cal),'needed tomorrow');assert.equal(whenWords('2026-09-30',cal),'needed Wed 30 Sep');assert.equal(whenWords(null,cal),'');
  assert.deepEqual(urgencyOf('2026-09-20',false,cal),{urgency:'OVERDUE',daysLate:3});assert.deepEqual(urgencyOf('2026-09-20',true,cal),{urgency:'DONE',daysLate:0});
  assert.equal(ladderBucket({neededOn:null,truck:null},cal),'NEXT');assert.equal(ladderBucket({neededOn:null,truck:'x'},cal),'NOW');assert.equal(ladderBucket({neededOn:'2026-09-25',truck:null},cal),'LATER');
  assert.equal(parseDay('2027-09-24',{cal}),'2027-09-24','today + 366 is allowed');
});

test('calendar: the server decides today, tomorrow, the next working day and the week start in its own time zone',t=>{
  const f=setup(t);
  assert.deepEqual(f.sim.snapshot().calendar,{today:TODAY,tomorrow:TOMORROW,nextWorkday:TOMORROW,weekStart:'2026-09-21',timeZone:'Australia/Sydney'});
  clock(t,'2026-09-25T00:00:00Z');let c=f.sim.snapshot().calendar;assert.equal(c.today,'2026-09-25');assert.equal(c.tomorrow,'2026-09-26');assert.equal(c.nextWorkday,'2026-09-28','Friday -> Monday');
  clock(t,'2026-09-26T00:00:00Z');c=f.sim.snapshot().calendar;assert.equal(c.nextWorkday,'2026-09-28','Saturday -> Monday');assert.equal(c.weekStart,'2026-09-21');
  clock(t,'2026-09-27T00:00:00Z');c=f.sim.snapshot().calendar;assert.equal(c.nextWorkday,'2026-09-28','Sunday -> Monday');assert.equal(c.weekStart,'2026-09-21');
  clock(t,'2026-09-28T00:00:00Z');c=f.sim.snapshot().calendar;assert.equal(c.nextWorkday,'2026-09-29');assert.equal(c.weekStart,'2026-09-28');
});

test('local midnight, not UTC midnight, rolls the day over',t=>{
  const f=setup(t,Date.parse('2026-09-27T13:59:59Z'));// 23:59:59 Sunday 27 Sep in Sydney
  assert.equal(f.sim.snapshot().calendar.today,'2026-09-27');const list=createList(f,{neededOn:'2026-09-27'});assert.equal(view(f,list.id).urgency,'TODAY');
  clock(t,'2026-09-27T14:00:00Z');// 00:00 Monday 28 Sep
  assert.equal(f.sim.snapshot().calendar.today,'2026-09-28');const v=view(f,list.id);assert.equal(v.urgency,'OVERDUE');assert.equal(v.daysLate,1);
  assert.throws(()=>createList(f,{neededOn:'2026-09-27'}),/cannot be in the past/);
  clock(t,'2026-09-27T20:00:00Z');assert.equal(new Date().toISOString().slice(0,10),'2026-09-27','the UTC date is still the 27th');assert.equal(f.sim.snapshot().calendar.today,'2026-09-28');
  const named=createList(f,{neededOn:'2026-09-28'});assert.equal(named.name,'Yard list 2026-09-28','the default name uses the local day');
});

test('dates are validated on create and on reschedule with exact messages; a bad date writes nothing',t=>{
  const f=setup(t);const counts=()=>[f.sim.repo.all('request').length,f.sim.repo.all('loadList').length];const before=counts();
  const bad=[['2026-02-30',MSG.format],['28/09/2026',MSG.format],[5,MSG.format],['2026-9-28',MSG.format],['2026-09-22',MSG.past],[addDays(TODAY,367),MSG.far]];
  for(const [neededOn,message] of bad){assert.throws(()=>createList(f,{neededOn}),{message},'createLoadList '+neededOn);assert.throws(()=>f.cmd('request',{site:f.site.id,product:f.products[0].id,quantity:1,neededOn}),{message},'request '+neededOn);}
  assert.throws(()=>createList(f,{neededOn:TODAY,slot:'NIGHT'}),{message:MSG.slot});
  assert.deepEqual(counts(),before,'no request or yard list is left behind');
  const list=createList(f,{neededOn:TODAY,slot:'AM'});assert.equal(list.neededOn,TODAY);assert.equal(list.slot,'AM');assert.equal(list.plannedTruck,null);
  assert.ok(createList(f,{neededOn:addDays(TODAY,366)}).id,'today + 366 is accepted');
  for(const [neededOn,message] of bad)assert.throws(()=>f.cmd('reschedule',{id:list.id,neededOn}),{message},'reschedule '+neededOn);
  assert.throws(()=>f.cmd('reschedule',{id:list.id}),{message:MSG.required});assert.throws(()=>f.cmd('reschedule',{id:list.id,neededOn:''}),{message:MSG.required});
  assert.throws(()=>f.cmd('reschedule',{id:list.id,neededOn:TOMORROW,slot:'NIGHT'}),{message:MSG.slot});
  assert.throws(()=>f.cmd('reschedule',{id:f.site.id,neededOn:TOMORROW}),{message:'Choose a yard list or request to schedule.'});
  assert.throws(()=>f.cmd('reschedule',{id:42,neededOn:TOMORROW}),{message:'Choose a yard list or request to schedule.'});
  assert.equal(f.sim.repo.get(list.id).neededOn,TODAY,'refused reschedules change nothing');
});

test('undated yard lists and requests keep working and show as No date',t=>{
  const f=setup(t);const list=createList(f);assert.equal(list.neededOn,null);assert.equal(list.slot,'ANY');assert.equal(list.plannedTruck,null);assert.equal(list.name,'Yard list '+TODAY);
  const v=view(f,list.id);assert.equal(v.urgency,'UNDATED');assert.equal(v.daysLate,0);assert.equal(v.runTruck,null);assert.equal(v.siteName,'Site A');assert.equal(v.schedulable,true);assert.equal(v.canReschedule,true);assert.equal(v.clash,0);assert.deepEqual(v.clashWith,[]);
  // list lines never carry their own date
  const s=f.sim.snapshot(),line=s.requests.find(r=>r.loadList===list.id);assert.equal(line.neededOn,null);assert.equal(line.slot,null);assert.equal(line.urgency,null);assert.equal(line.canReschedule,undefined);
  const raw=f.sim.repo.get(list.lines[0].request);assert.equal(raw.neededOn,null);
  // an old list saved before dates existed
  const old=f.sim.repo.get(list.id);delete old.neededOn;delete old.slot;delete old.plannedTruck;f.sim.repo.save(old);const ov=view(f,list.id);assert.equal(ov.neededOn,null);assert.equal(ov.slot,'ANY');assert.equal(ov.plannedTruck,null);assert.equal(ov.urgency,'UNDATED');
  const r=f.cmd('request',{site:f.site.id,product:f.products[0].id,quantity:5});const rv=view(f,r.id);assert.equal(rv.urgency,'UNDATED');assert.equal(rv.name,'5 × '+f.products[0].name);assert.equal(rv.siteName,'Site A');assert.equal(rv.slot,'ANY');
});

test('urgency: today, tomorrow, later, overdue as the clock moves, and done after cancel or delivery',t=>{
  const f=setup(t);const a=createList(f,{neededOn:TODAY}),b=createList(f,{neededOn:TOMORROW}),c=createList(f,{neededOn:'2026-09-30'});
  assert.deepEqual([a,b,c].map(l=>view(f,l.id).urgency),['TODAY','TOMORROW','LATER']);
  clock(t,'2026-09-25T00:00:00Z');assert.deepEqual([a,b,c].map(l=>view(f,l.id).urgency),['OVERDUE','OVERDUE','LATER']);assert.equal(view(f,a.id).daysLate,2);assert.equal(view(f,b.id).daysLate,1);
  f.cmd('cancelLoadList',{id:b.id,reason:'Not needed'});assert.equal(view(f,b.id).urgency,'DONE');assert.equal(view(f,b.id).schedulable,false);assert.equal(view(f,b.id).canReschedule,false);
  deliverList(f,c.id);const v=view(f,c.id);assert.equal(v.status,'DELIVERED');assert.equal(v.urgency,'DONE');
  // a single request that is delivered is done as well
  const g=setup(t,WED);const r=g.cmd('request',{site:g.site.id,product:g.products[0].id,quantity:100,neededOn:TODAY});assert.equal(view(g,r.id).urgency,'TODAY');g.cmd('allocate',{id:r.id,truck:g.truck.id});settle(g);g.cmd('dispatch',{id:g.truck.id,destination:g.site.id});g.tick(5);g.cmd('unload',{id:g.truck.id});settle(g,60);assert.equal(g.sim.repo.get(r.id).status,'DELIVERED');assert.equal(view(g,r.id).urgency,'DONE');
});

test('reschedule: open, reserved and loaded lists move; departed and cancelled lists, list lines and delivered requests do not',t=>{
  const f=setup(t);const list=createList(f,{neededOn:TOMORROW},100);
  let r=f.cmd('reschedule',{id:list.id,neededOn:'2026-09-25'});assert.equal(r.changed,true);assert.equal(r.kind,'loadList');assert.equal(r.urgency,'LATER');assert.equal(r.slot,'ANY');
  f.cmd('allocateLoadList',{id:list.id,truck:f.truck.id});assert.equal(view(f,list.id).status,'RESERVED');
  r=f.cmd('reschedule',{id:list.id,neededOn:TODAY,slot:'PM'});assert.equal(r.neededOn,TODAY);assert.equal(r.slot,'PM');assert.equal(r.urgency,'TODAY');
  settle(f);assert.equal(view(f,list.id).status,'LOADED');r=f.cmd('reschedule',{id:list.id,neededOn:TOMORROW});assert.equal(r.slot,'PM','a missing slot keeps the current window');
  f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});
  assert.throws(()=>f.cmd('reschedule',{id:list.id,neededOn:TODAY}),{message:'This yard list has left the yard. Its date and truck can no longer change.'});
  assert.equal(view(f,list.id).schedulable,false);assert.equal(view(f,list.id).canReschedule,false);
  const other=createList(f,{neededOn:TODAY});f.cmd('cancelLoadList',{id:other.id,reason:'Changed plan'});assert.throws(()=>f.cmd('reschedule',{id:other.id,neededOn:TOMORROW}),{message:'This yard list is cancelled.'});
  const open=createList(f,{neededOn:TODAY});assert.throws(()=>f.cmd('reschedule',{id:open.lines[0].request,neededOn:TOMORROW}),{message:'This request belongs to a yard list. Change the yard list instead.'});
  assert.throws(()=>f.cmd('bookTruck',{id:open.lines[0].request,truck:f.truck.id}),{message:'This request belongs to a yard list. Change the yard list instead.'});
  // single request: movable until delivered
  const g=setup(t,WED);const req=g.cmd('request',{site:g.site.id,product:g.products[0].id,quantity:100,neededOn:TODAY,slot:'AM'});
  r=g.cmd('reschedule',{id:req.id,neededOn:TOMORROW});assert.equal(r.kind,'request');assert.equal(r.slot,'AM');assert.match(r.message,/100 × .*: now needed Thu 24 Sep \(AM\) \(was Wed 23 Sep\)\./);
  g.cmd('allocate',{id:req.id,truck:g.truck.id});assert.equal(g.cmd('reschedule',{id:req.id,neededOn:TODAY}).changed,true,'an allocated request can still move');
  settle(g);g.cmd('dispatch',{id:g.truck.id,destination:g.site.id});g.tick(5);g.cmd('unload',{id:g.truck.id});settle(g,60);
  assert.throws(()=>g.cmd('reschedule',{id:req.id,neededOn:TOMORROW}),{message:'This request is already delivered or closed.'});
});

test('reschedule: a same-value call writes nothing; a real change writes one site notification and keeps the previous date',t=>{
  const f=setup(t);const list=createList(f,{neededOn:TOMORROW,name:'Level 3 deck'});const n0=notes(f).length,v0=f.sim.repo.get(list.id).version;
  const same=f.cmd('reschedule',{id:list.id,neededOn:TOMORROW,slot:'ANY'});assert.equal(same.changed,false);assert.equal(notes(f).length,n0);assert.equal(f.sim.repo.get(list.id).version,v0,'the list is not saved');
  assert.equal(f.cmd('reschedule',{id:list.id,neededOn:TOMORROW}).changed,false);
  const moved=f.cmd('reschedule',{id:list.id,neededOn:'2026-09-28',slot:'AM'});assert.equal(moved.changed,true);assert.equal(moved.message,'Level 3 deck: now needed Mon 28 Sep (AM) (was Thu 24 Sep).');
  const added=notes(f).slice(n0);assert.equal(added.length,1);assert.equal(added[0].title,'Yard list rescheduled');assert.equal(added[0].body,moved.message);assert.equal(added[0].site,f.site.id);
  const raw=f.sim.repo.get(list.id);assert.equal(raw.previousNeededOn,TOMORROW);assert.equal(raw.neededOn,'2026-09-28');assert.equal(raw.slot,'AM');assert.equal(raw.rescheduledBy,f.user.id);assert.ok(raw.rescheduledAt);
  const undated=createList(f);const first=f.cmd('reschedule',{id:undated.id,neededOn:TODAY});assert.equal(first.message,undated.name+': now needed Wed 23 Sep.');assert.equal(f.sim.repo.get(undated.id).previousNeededOn,null);
});

test('bookTruck plans a truck without reserving stock, even while the truck is away; reserved packs lock the booking',t=>{
  const f=setup(t);const siteB=secondSite(f),t2=secondTruck(f);
  f.cmd('dispatch',{id:f.truck.id,destination:siteB.id});const away=f.sim.repo.get(f.truck.id);assert.equal(away.status,'IN_TRANSIT');
  const list=createList(f,{neededOn:TOMORROW,name:'Deck'});const booked=f.cmd('bookTruck',{id:list.id,truck:f.truck.id});
  assert.deepEqual({...booked,message:undefined},{id:list.id,kind:'loadList',plannedTruck:f.truck.id,plannedTruckName:'T01',clash:0,changed:true,message:undefined});assert.equal(booked.message,'T01 booked for Deck on Thu 24 Sep.');
  const after=f.sim.repo.get(f.truck.id);assert.equal(after.status,'IN_TRANSIT');assert.equal(after.destination,siteB.id,'the truck keeps its own destination');const s=f.sim.snapshot();assert.equal(s.reservedTotal,0);
  const v=s.loadLists.find(l=>l.id===list.id);assert.equal(v.plannedTruck,f.truck.id);assert.equal(v.plannedTruckName,'T01');assert.equal(v.runTruck,f.truck.id);assert.equal(v.runTruckName,'T01');assert.equal(v.truck,null);assert.equal(v.status,'OPEN');
  const n=notes(f).at(-1);assert.equal(n.title,'Truck booked');assert.equal(n.body,'T01 booked for Deck on Thu 24 Sep.');
  const un=f.cmd('bookTruck',{id:list.id,truck:null});assert.equal(un.plannedTruck,null);assert.equal(un.plannedTruckName,null);assert.equal(un.message,'Deck needs a truck again.');assert.equal(notes(f).at(-1).title,'Truck booking removed');assert.equal(view(f,list.id).runTruck,null);
  assert.equal(f.cmd('bookTruck',{id:list.id,truck:''}).plannedTruck,null);
  assert.throws(()=>f.cmd('bookTruck',{id:list.id,truck:7}),{message:'Choose a truck.'});assert.throws(()=>f.cmd('bookTruck',{id:list.id}),{message:'Choose a truck.'});
  // reserving on T02 sets the planned truck; then the booking cannot change
  f.cmd('bookTruck',{id:list.id,truck:f.truck.id});f.cmd('allocateLoadList',{id:list.id,truck:t2.id});const raw=f.sim.repo.get(list.id);assert.equal(raw.truck,t2.id);assert.equal(raw.plannedTruck,t2.id,'reserving onto another truck moves the booking');
  assert.throws(()=>f.cmd('bookTruck',{id:list.id,truck:f.truck.id}),{message:'Packs are already reserved on T02. Cancel the yard list to change its truck.'});
  assert.throws(()=>f.cmd('bookTruck',{id:list.id,truck:null}),{message:'Packs are already reserved on T02. Cancel the yard list to change its truck.'});
  assert.equal(f.cmd('bookTruck',{id:list.id,truck:t2.id}).plannedTruck,t2.id,'re-booking the reserved truck is fine');
  // a single allocated request says "Cancel the request"
  const g=setup(t,WED);const req=g.cmd('request',{site:g.site.id,product:g.products[0].id,quantity:100,neededOn:TODAY});g.cmd('allocate',{id:req.id,truck:g.truck.id});assert.equal(g.sim.repo.get(req.id).plannedTruck,g.truck.id);
  const t3=secondTruck(g,'T03');assert.throws(()=>g.cmd('bookTruck',{id:req.id,truck:t3.id}),{message:'Packs are already reserved on T01. Cancel the request to change its truck.'});
  const single=g.cmd('request',{site:g.site.id,product:g.products[0].id,quantity:1,neededOn:TOMORROW});const b=g.cmd('bookTruck',{id:single.id,truck:t3.id});assert.equal(b.kind,'request');assert.equal(b.message,'T03 booked for 1 × '+g.products[0].name+' on Thu 24 Sep.');
});

test('bookTruck: cancelled and departed lists, retired trucks and unknown records are refused',t=>{
  const f=setup(t);const t2=secondTruck(f);const list=createList(f,{neededOn:TODAY},100);
  f.cmd('retire',{id:t2.id});assert.throws(()=>f.cmd('bookTruck',{id:list.id,truck:t2.id}),{message:'T02 has been removed.'});
  f.cmd('allocateLoadList',{id:list.id,truck:f.truck.id});settle(f);f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});
  assert.throws(()=>f.cmd('bookTruck',{id:list.id,truck:f.truck.id}),{message:'This yard list has left the yard. Its date and truck can no longer change.'});
  const other=createList(f,{neededOn:TODAY});f.cmd('cancelLoadList',{id:other.id,reason:'Not needed'});assert.throws(()=>f.cmd('bookTruck',{id:other.id,truck:f.truck.id}),{message:'This yard list is cancelled.'});
  assert.throws(()=>f.cmd('bookTruck',{id:randomUUID(),truck:f.truck.id}),{status:404});
});

test('permissions: supervisors reschedule their own sites only and cannot book trucks; general managers can do both',t=>{
  const f=setup(t);const siteB=secondSite(f);const sup=user(f,'supervisor@example.com','SUPERVISOR'),gm=user(f,'manager@example.com','GENERAL_MANAGER');
  f.cmd('siteDetails',{id:f.site.id,supervisor:sup.user.id});
  const own=createList(f,{neededOn:TOMORROW},10,sup);assert.equal(own.neededOn,TOMORROW);const theirs=createList(f,{neededOn:TOMORROW,site:siteB.id});
  const r=sup.execute('reschedule',{id:own.id,neededOn:'2026-09-25'},randomUUID());assert.equal(r.changed,true);
  assert.throws(()=>sup.execute('reschedule',{id:theirs.id,neededOn:'2026-09-25'},randomUUID()),/assigned sites/);
  assert.throws(()=>sup.execute('bookTruck',{id:own.id,truck:f.truck.id},randomUUID()),{status:403,message:'Your role does not allow this action.'});
  assert.equal(gm.execute('reschedule',{id:theirs.id,neededOn:TODAY},randomUUID()).changed,true);assert.equal(gm.execute('bookTruck',{id:theirs.id,truck:f.truck.id},randomUUID()).plannedTruck,f.truck.id);
  // same day and truck on another site: the supervisor sees the clash count but never the other site's list
  gm.execute('reschedule',{id:theirs.id,neededOn:'2026-09-25'},randomUUID());gm.execute('bookTruck',{id:own.id,truck:f.truck.id},randomUUID());
  const s=sup.snapshot();assert.deepEqual(s.loadLists.map(l=>l.id),[own.id]);assert.ok(s.requests.every(q=>q.site===f.site.id));
  const v=s.loadLists[0];assert.equal(v.clash,1);assert.deepEqual(v.clashWith,[]);assert.equal(v.canReschedule,true);assert.equal(v.runTruckName,'T01','names come from every truck, visible or not');
  assert.equal(s.calendar.today,TODAY);
  const ops=f.sim.snapshot().loadLists.find(l=>l.id===own.id);assert.equal(ops.clash,1);assert.deepEqual(ops.clashWith.map(x=>x.id),[theirs.id]);
  // a general manager sees every list as reschedulable; a supervisor loses that once the site is reassigned
  assert.ok(gm.snapshot().loadLists.every(l=>l.canReschedule));f.cmd('siteDetails',{id:f.site.id,supervisor:null});assert.deepEqual(sup.snapshot().loadLists,[]);assert.throws(()=>sup.execute('reschedule',{id:own.id,neededOn:TODAY},randomUUID()),/assigned sites/);
});

test('idempotency: reschedule and bookTruck replay the stored result and refuse a reused key for a different date',t=>{
  const f=setup(t);const list=createList(f,{neededOn:TODAY});const n0=notes(f).length;const key=randomUUID();
  const a=f.cmd('reschedule',{id:list.id,neededOn:TOMORROW},key),b=f.cmd('reschedule',{id:list.id,neededOn:TOMORROW},key);assert.deepEqual(b,a);assert.equal(a.changed,true);assert.equal(notes(f).length,n0+1);
  assert.throws(()=>f.cmd('reschedule',{id:list.id,neededOn:'2026-09-25'},key),/idempotency key/);assert.equal(f.sim.repo.get(list.id).neededOn,TOMORROW);
  const k2=randomUUID();const c=f.cmd('bookTruck',{id:list.id,truck:f.truck.id},k2),d=f.cmd('bookTruck',{id:list.id,truck:f.truck.id},k2);assert.deepEqual(d,c);assert.equal(notes(f).length,n0+2);
  assert.throws(()=>f.cmd('bookTruck',{id:list.id,truck:null},k2),/idempotency key/);
});

test('clash: the same run truck on the same day to different sites with overlapping windows is flagged, never refused',t=>{
  const f=setup(t);const siteB=secondSite(f);const a=createList(f,{neededOn:TOMORROW,name:'A deck'}),b=createList(f,{neededOn:TOMORROW,name:'B deck',site:siteB.id});
  assert.equal(f.cmd('bookTruck',{id:a.id,truck:f.truck.id}).clash,0);const booked=f.cmd('bookTruck',{id:b.id,truck:f.truck.id});assert.equal(booked.clash,1);assert.equal(booked.message,'T01 booked for B deck on Thu 24 Sep. Clash: it also runs to another site that day.');
  let s=f.sim.snapshot(),va=s.loadLists.find(l=>l.id===a.id),vb=s.loadLists.find(l=>l.id===b.id);assert.equal(va.clash,1);assert.equal(vb.clash,1);
  assert.deepEqual(va.clashWith,[{id:b.id,kind:'loadList',name:'B deck',siteName:'Site B',slot:'ANY'}]);assert.deepEqual(vb.clashWith.map(x=>x.id),[a.id]);
  f.cmd('reschedule',{id:a.id,neededOn:TOMORROW,slot:'AM'});assert.equal(view(f,a.id).clash,1,'ANY overlaps AM');
  f.cmd('reschedule',{id:b.id,neededOn:TOMORROW,slot:'PM'});assert.equal(view(f,a.id).clash,0,'AM and PM do not overlap');assert.equal(view(f,b.id).clash,0);
  f.cmd('reschedule',{id:b.id,neededOn:TOMORROW,slot:'AM'});assert.equal(view(f,b.id).clash,1,'AM overlaps AM');
  f.cmd('reschedule',{id:b.id,neededOn:'2026-09-25'});assert.equal(view(f,b.id).clash,0,'a different day');
  const same=createList(f,{neededOn:TOMORROW,name:'A deck 2'});f.cmd('bookTruck',{id:same.id,truck:f.truck.id});assert.equal(view(f,same.id).clash,0,'the same site is one run');
  // a single request counts too, and cancelling clears it
  const req=f.cmd('request',{site:siteB.id,product:f.products[0].id,quantity:3,neededOn:TOMORROW});f.cmd('bookTruck',{id:req.id,truck:f.truck.id});s=f.sim.snapshot();
  assert.equal(s.loadLists.find(l=>l.id===a.id).clash,1);const rv=s.requests.find(r=>r.id===req.id);assert.equal(rv.clash,2);assert.deepEqual(rv.clashWith.map(x=>x.kind),['loadList','loadList']);
  f.cmd('cancelRequest',{id:req.id,reason:'Not needed'});assert.equal(view(f,a.id).clash,0);assert.equal(view(f,same.id).clash,0);
  f.cmd('reschedule',{id:b.id,neededOn:TOMORROW,slot:'ANY'});assert.equal(view(f,a.id).clash,1);f.cmd('cancelLoadList',{id:b.id,reason:'Not needed'});assert.equal(view(f,a.id).clash,0,'a cancelled list clashes with nothing');
});

test('trucks list their next runs by date with undated runs last, reserved runs marked and departed runs dropped, capped at six',t=>{
  const f=setup(t);const mk=(neededOn,slot,name)=>{const l=createList(f,{neededOn,slot,name});f.cmd('bookTruck',{id:l.id,truck:f.truck.id});return l;};
  const undated=mk(undefined,undefined,'U'),later=mk('2026-09-30','ANY','L'),pm=mk(TOMORROW,'PM','P'),am=mk(TOMORROW,'AM','M'),today=mk(TODAY,'ANY','T');
  let tr=f.sim.snapshot().trucks.find(x=>x.id===f.truck.id);assert.deepEqual(tr.nextRuns.map(r=>r.name),['T','M','P','L','U']);assert.equal(tr.runsBooked,5);
  const first=tr.nextRuns[0];assert.deepEqual(Object.keys(first).sort(),['clash','id','kind','name','neededOn','pieces','reserved','site','siteName','slot','status','urgency'].sort());assert.equal(first.pieces,10);assert.equal(first.reserved,false);assert.equal(first.status,'OPEN');assert.equal(first.urgency,'TODAY');assert.equal(first.siteName,'Site A');
  f.cmd('allocateLoadList',{id:today.id,truck:f.truck.id});tr=f.sim.snapshot().trucks.find(x=>x.id===f.truck.id);assert.equal(tr.nextRuns[0].reserved,true);assert.equal(tr.nextRuns[0].status,'RESERVED');
  settle(f);f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});tr=f.sim.snapshot().trucks.find(x=>x.id===f.truck.id);assert.deepEqual(tr.nextRuns.map(r=>r.name),['M','P','L','U'],'the departed list drops off');
  const req=f.cmd('request',{site:f.site.id,product:f.products[0].id,quantity:4,neededOn:'2026-09-25'});f.cmd('bookTruck',{id:req.id,truck:f.truck.id});for(const d of ['2026-10-01','2026-10-02','2026-10-05'])mk(d,'ANY','X'+d);
  tr=f.sim.snapshot().trucks.find(x=>x.id===f.truck.id);assert.equal(tr.runsBooked,8);assert.equal(tr.nextRuns.length,6);assert.deepEqual(tr.nextRuns.map(r=>r.name),['M','P','4 × '+f.products[0].name,'L','X2026-10-01','X2026-10-02']);const rr=tr.nextRuns[2];assert.equal(rr.kind,'request');assert.equal(rr.pieces,4);assert.equal(rr.status,'REQUESTED');
  const other=secondTruck(f);assert.deepEqual(f.sim.snapshot().trucks.find(x=>x.id===other.id).nextRuns,[]);
});

test('removing a truck sends its booked runs back to Needs a truck; reserved runs still block removal',t=>{
  const f=setup(t);const t2=secondTruck(f),t3=secondTruck(f,'T03');const list=createList(f,{neededOn:TOMORROW,name:'Deck'});const req=f.cmd('request',{site:f.site.id,product:f.products[0].id,quantity:2,neededOn:TOMORROW});
  f.cmd('bookTruck',{id:list.id,truck:t2.id});f.cmd('bookTruck',{id:req.id,truck:t2.id});const n0=notes(f).length;
  f.cmd('retire',{id:t2.id});assert.equal(f.sim.repo.get(list.id).plannedTruck,null);assert.equal(f.sim.repo.get(req.id).plannedTruck,null);
  const added=notes(f).slice(n0);assert.deepEqual(added.map(n=>n.title),['Truck booking removed','Truck booking removed']);assert.equal(added[0].body,'T02 was removed; Deck needs a truck again.');assert.equal(added[1].body,'T02 was removed; 2 × '+f.products[0].name+' needs a truck again.');
  // quickAdjust -1 removes the last idle 12.5 t truck (T03) the same way when every idle truck has a booking
  f.cmd('bookTruck',{id:list.id,truck:t3.id});f.cmd('bookTruck',{id:req.id,truck:f.truck.id});f.cmd('quickAdjust',{location:f.yard.id,kind:'TRUCK',delta:-1});assert.equal(f.sim.repo.get(t3.id).retired,true);assert.equal(f.sim.repo.get(list.id).plannedTruck,null);
  // packs reserved on T01 block its removal exactly as before
  f.cmd('bookTruck',{id:list.id,truck:f.truck.id});f.cmd('allocateLoadList',{id:list.id,truck:f.truck.id});assert.throws(()=>f.cmd('retire',{id:f.truck.id}),/Unload the truck/);assert.equal(f.sim.repo.get(list.id).plannedTruck,f.truck.id);
});

test('jobs ladder: needed-on dates decide P2 and P3, undated lists keep the old rungs, and a job keeps its id across midnight',t=>{
  const f=setup(t);jobsOn(f);
  const today=createList(f,{neededOn:TODAY,name:'Today list'}),tomorrow=createList(f,{neededOn:TOMORROW,name:'Tomorrow list'}),later=createList(f,{neededOn:'2026-09-28',name:'Later list'}),undated=createList(f,{name:'Undated list'});
  refresh(f);
  let j=liveJob(f,'PRECHECK:'+today.id);assert.equal(j.priority,2);assert.match(j.title,/needed today/);assert.equal(j.title,'Pre-check stock for Today list – 1 line – needed today');
  j=liveJob(f,'PRECHECK:'+tomorrow.id);assert.equal(j.priority,3);assert.match(j.title,/needed tomorrow/);const tomorrowJob=j.id;
  assert.equal(liveJob(f,'PRECHECK:'+later.id),undefined,'a list needed after the next working day waits');
  j=liveJob(f,'PRECHECK:'+undated.id);assert.equal(j.priority,3);assert.equal(j.title,'Pre-check stock for Undated list – 1 line','undated titles are exactly as before');
  let ladder=f.sim.snapshot().ladder[f.yard.id];assert.equal(ladder.find(l=>l.priority===2).open,1);assert.equal(ladder.find(l=>l.priority===3).open,2);
  // after local midnight: today's list is overdue (still P2), tomorrow's is today (P3 -> P2, same job), Monday is not yet within reach on Thursday
  clock(t,'2026-09-23T14:00:00Z');refresh(f);
  j=liveJob(f,'PRECHECK:'+today.id);assert.equal(j.priority,2);assert.match(j.title,/overdue \(was needed Wed 23 Sep\)/);
  j=liveJob(f,'PRECHECK:'+tomorrow.id);assert.equal(j.id,tomorrowJob,'the job keeps its id');assert.equal(j.priority,2);assert.match(j.title,/needed today/);
  assert.equal(liveJob(f,'PRECHECK:'+later.id),undefined);
  // Friday: Monday is the next working day, so Monday's list is P3
  clock(t,'2026-09-25T00:00:00Z');refresh(f);j=liveJob(f,'PRECHECK:'+later.id);assert.equal(j.priority,3);assert.match(j.title,/needed Mon 28 Sep/);
  ladder=f.sim.snapshot().ladder[f.yard.id];assert.equal(ladder.find(l=>l.priority===2).open,2);assert.equal(ladder.find(l=>l.priority===3).open,2);
  // moving a list out of reach expires its job
  const moved=liveJob(f,'PRECHECK:'+tomorrow.id);f.cmd('reschedule',{id:tomorrow.id,neededOn:'2026-10-05'});refresh(f);assert.equal(liveJob(f,'PRECHECK:'+tomorrow.id),undefined);assert.equal(f.sim.repo.get(moved.id).state,'EXPIRED');
});

test('jobs ladder: label jobs are P2 for undated reserved lists and dated lists due now, P3 for later dates',t=>{
  const f=setup(t);const t2=secondTruck(f),t3=secondTruck(f,'T03');for(const c of [['C1',4000,7000],['C2',7000,7000],['C3',10000,7000]]){const x=f.container(...c);f.cmd('opening',{container:x.id,product:f.products[0].id,quantity:100,reason:'DEMO ONLY'});}
  jobsOn(f);const undated=createList(f,{name:'U'},100),later=createList(f,{name:'L',neededOn:'2026-09-30'},100),today=createList(f,{name:'T',neededOn:TODAY},100);
  f.cmd('allocateLoadList',{id:undated.id,truck:f.truck.id});f.cmd('allocateLoadList',{id:later.id,truck:t2.id});f.cmd('allocateLoadList',{id:today.id,truck:t3.id});
  for(const l of [undated,later,today])assert.equal(view(f,l.id).status,'RESERVED');
  refresh(f);
  assert.equal(liveJob(f,'LABEL:'+undated.id).priority,2);assert.equal(liveJob(f,'LABEL:'+undated.id).title,'Label picked packs – U');
  assert.equal(liveJob(f,'LABEL:'+later.id).priority,3);assert.equal(liveJob(f,'LABEL:'+later.id).title,'Label picked packs – L – needed Wed 30 Sep');
  assert.equal(liveJob(f,'LABEL:'+today.id).priority,2);assert.match(liveJob(f,'LABEL:'+today.id).title,/needed today$/);
  const id=liveJob(f,'LABEL:'+later.id).id;f.cmd('reschedule',{id:later.id,neededOn:TODAY});refresh(f);const j=liveJob(f,'LABEL:'+later.id);assert.equal(j.id,id);assert.equal(j.priority,2);
});

test('the yard-list CSV export carries the needed-on date and window',t=>{
  const f=setup(t);createList(f,{neededOn:TOMORROW,slot:'PM',name:'Deck'});const rows=f.sim.export('yardlist').split('\r\n');
  assert.ok(rows[0].startsWith('"Yard list","Status","Needed on","Window","Site","Truck"'));assert.ok(rows[1].startsWith('"Deck","OPEN","2026-09-24","PM",'));
});

// Review fixes
test('a single request that has left the yard is locked like a departed yard list and drops out of runs and clashes',t=>{
  const f=setup(t);const siteB=secondSite(f);const req=f.cmd('request',{site:f.site.id,product:f.products[0].id,quantity:100,neededOn:TODAY});
  f.cmd('allocate',{id:req.id,truck:f.truck.id});settle(f);f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});
  const raw=f.sim.repo.get(req.id);assert.ok(raw.delivery,'dispatch stamps the single request');assert.equal(raw.status,'ALLOCATED');
  const v=view(f,req.id);assert.equal(v.schedulable,false);assert.equal(v.canReschedule,false);
  const msg={message:'This request has left the yard. Its date and truck can no longer change.'};
  assert.throws(()=>f.cmd('reschedule',{id:req.id,neededOn:TOMORROW}),msg);assert.throws(()=>f.cmd('bookTruck',{id:req.id,truck:f.truck.id}),msg);
  assert.deepEqual(f.sim.snapshot().trucks.find(x=>x.id===f.truck.id).nextRuns,[],'a run on the road is no longer a next run');
  const other=createList(f,{neededOn:TODAY,site:siteB.id});assert.equal(f.cmd('bookTruck',{id:other.id,truck:f.truck.id}).clash,0,'no clash against a run already on the road');
  f.tick(5);assert.throws(()=>f.cmd('reschedule',{id:req.id,neededOn:TOMORROW}),msg,'still locked at the site before unloading');
});

test('bookTruck with no change writes nothing; a window-only reschedule names the old window, not the same date',t=>{
  const f=setup(t);const list=createList(f,{neededOn:TODAY,name:'Deck'});const n0=notes(f).length;
  let r=f.cmd('bookTruck',{id:list.id,truck:''});assert.equal(r.changed,false);assert.equal(r.message,'Deck has no truck booked.');assert.equal(notes(f).length,n0);
  f.cmd('bookTruck',{id:list.id,truck:f.truck.id});const n1=notes(f).length,at=f.sim.repo.get(list.id).bookedAt;
  r=f.cmd('bookTruck',{id:list.id,truck:f.truck.id});assert.equal(r.changed,false);assert.equal(r.message,'Deck is already booked on T01.');assert.equal(notes(f).length,n1);assert.equal(f.sim.repo.get(list.id).bookedAt,at);
  f.cmd('allocateLoadList',{id:list.id,truck:f.truck.id});r=f.cmd('bookTruck',{id:list.id,truck:f.truck.id});assert.equal(r.changed,false,'the truck holding the packs is already the booking');
  r=f.cmd('reschedule',{id:list.id,neededOn:TODAY,slot:'PM'});assert.equal(r.message,'Deck: now needed Wed 23 Sep (PM) (was any time).');assert.equal(f.sim.repo.get(list.id).previousNeededOn,undefined,'a window change keeps the previous date untouched');
  r=f.cmd('reschedule',{id:list.id,neededOn:TODAY,slot:'AM'});assert.equal(r.message,'Deck: now needed Wed 23 Sep (AM) (was PM).');
  r=f.cmd('reschedule',{id:list.id,neededOn:TOMORROW});assert.equal(r.message,'Deck: now needed Thu 24 Sep (AM) (was Wed 23 Sep).');assert.equal(f.sim.repo.get(list.id).previousNeededOn,TODAY);
});

test('a supervisor gets the site message before any hint about what another site\'s record is',t=>{
  const f=setup(t);const siteB=secondSite(f);const sup=user(f,'supervisor@example.com','SUPERVISOR');f.cmd('siteDetails',{id:f.site.id,supervisor:sup.user.id});
  const theirs=createList(f,{neededOn:TOMORROW,site:siteB.id});
  for(const id of [theirs.id,theirs.lines[0].request,f.truck.id,f.yard.id])for(const action of ['reschedule','bookTruck'])assert.throws(()=>sup.execute(action,{id,neededOn:TOMORROW,truck:null},randomUUID()),action==='bookTruck'?/does not allow/:/assigned sites/);
  const own=createList(f,{neededOn:TOMORROW},10,sup);assert.throws(()=>sup.execute('reschedule',{id:own.lines[0].request,neededOn:TOMORROW},randomUUID()),/belongs to a yard list/,'on their own site the helpful message stays');
});

test('the trucks -1 button keeps booked trucks when an idle truck with no bookings can go',t=>{
  const f=setup(t);const t2=secondTruck(f);const list=createList(f,{neededOn:TOMORROW,name:'Deck'});f.cmd('bookTruck',{id:list.id,truck:t2.id});const n0=notes(f).length;
  f.cmd('quickAdjust',{location:f.yard.id,kind:'TRUCK',delta:-1});assert.equal(f.sim.repo.get(f.truck.id).retired,true,'the unbooked T01 goes');assert.ok(!f.sim.repo.get(t2.id).retired);
  assert.equal(f.sim.repo.get(list.id).plannedTruck,t2.id);assert.equal(notes(f).length,n0,'no booking was dropped');
});

test('a live pre-check or label job under the old rung key is adopted, not duplicated',t=>{
  const f=setup(t);jobsOn(f);const list=createList(f,{name:'Undated'});refresh(f);
  const job=liveJob(f,'PRECHECK:'+list.id);assert.ok(job);
  // an ASSIGNED job from before the upgrade: no second job appears beside it
  const legacy=f.sim.repo.get(job.id);legacy.key='P3:PRECHECK:'+list.id;legacy.state='ASSIGNED';f.sim.repo.save(legacy);refresh(f);
  assert.equal(f.sim.repo.all('job').filter(j=>j.subject?.id===list.id&&['OPEN','ASSIGNED','IN_PROGRESS','BLOCKED'].includes(j.state)).length,1);
  // an OPEN legacy job is re-keyed in place and keeps its id
  const open=f.sim.repo.get(job.id);open.state='OPEN';f.sim.repo.save(open);refresh(f);
  const now=liveJob(f,'PRECHECK:'+list.id);assert.equal(now?.id,job.id);assert.equal(f.sim.repo.get(job.id).state,'OPEN');
});
