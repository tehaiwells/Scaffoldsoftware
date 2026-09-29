process.env.TZ='Australia/Sydney';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Simulation } from '../src/simulation.js';
import { createApp } from '../src/server.js';
import { addDays,dayLabel } from '../src/domain/schedule.js';
import { planFixture,D0,L } from './helpers/plan-fixture.js';
const D1=addDays(D0,1),D2=addDays(D0,2);

test('GET /api/plan: a 42-day month with plan items, yard lists, collections and deliveries on it, what is taken each day, and the lists the forms need',t=>{
  const f=planFixture(t,{now:L(D0,'16:00')});f.cmd('teamStart');const a=f.site('Bondi','12 Smith St'),b=f.site('Parramatta');const demo=f.cmd('seed');f.cmd('gameCatalogue');const {p,per}=f.stock(2);const pack=demo.find(x=>f.sim.effective(x.id).packQuantity>0);
  f.cmd('gameAddStock',{lines:[{product:pack.id,quantity:100}]});
  const tr=f.cmd('planTruck',{day:D1,truck:f.truck('T-01').id,driver:f.driver('Dave').id});f.cmd('planMaterials',{day:D1,site:a.id,lines:[{product:p.id,quantity:per}],truckPlan:tr.item.id});
  const liam=f.cmd('teamAdd',{name:'Liam',role:'SCAFFOLDER'}).person.id;f.cmd('planWorkers',{day:D1,site:a.id,count:1,people:[liam]});f.cmd('planRestack',{day:D2});const gone=f.cmd('planRestack',{day:addDays(D0,3)});f.cmd('planCancel',{id:gone.item.id});
  f.cmd('createLoadList',{site:b.id,lines:[{product:pack.id,quantity:100}],neededOn:D1,slot:'AM'});
  f.cmd('gameSend',{site:b.id,lines:[{product:pack.id,quantity:100}]});assert.ok(f.until(()=>f.sim.repo.all('delivery').some(d=>d.status==='DELIVERED'),600));
  f.cmd('requestCollection',{site:b.id,neededOn:D2});
  const m=f.sim.planMonth(D0.slice(0,7));
  assert.equal(m.month,'2026-10');assert.equal(m.grid.length,42);assert.equal(m.grid[0],'2026-09-28');assert.equal(m.today,D0);assert.equal(m.prev,'2026-09');assert.equal(m.next,'2026-11');assert.equal(m.canPlan,true);assert.equal(m.paused,false);assert.equal(m.replies,true);
  assert.deepEqual(m.items.map(i=>i.type),['TRUCK','MATERIALS','WORKERS','RESTACK'],'cancelled ones are not shown; by day and time');
  const truck=m.items[0];assert.equal(truck.truckName,'T-01');assert.equal(truck.driverName,'Dave');assert.equal(truck.big,true);assert.deepEqual(truck.loads.map(x=>x.siteName),['Bondi']);assert.equal(truck.canMove,true);assert.equal(truck.canCancel,true);
  const mat=m.items[1];assert.equal(mat.siteName,'Bondi');assert.equal(mat.lines[0].name,p.name);assert.equal(mat.pieces,per);assert.equal(mat.truckPlanName,'T-01 · Dave');assert.equal(mat.words,'Worker 1 packs it on the day');assert.equal(mat.canEdit,true);
  const wk=m.items[2];assert.equal(wk.people[0].name,'Liam');assert.equal(wk.people[0].answer,'WAITING');assert.equal(wk.flags.needsAnswer,true);
  const list=m.runs.find(r=>r.kind==='loadList');assert.equal(list.day,D1);assert.equal(list.slot,'AM');assert.equal(list.siteName,'Parramatta');assert.equal(list.pieces,100);
  const rt=m.runs.find(r=>r.kind==='collection');assert.equal(rt.day,D2);assert.equal(rt.open,true);
  assert.ok(m.delivered.some(d=>d.day===D0&&d.siteName==='Parramatta'&&d.pieces===100));
  assert.deepEqual(m.taken[D1].trucks,[f.truck('T-01').id]);assert.deepEqual(m.taken[D1].drivers,[f.driver('Dave').id]);assert.deepEqual(m.taken[D1].people,[liam]);assert.equal(m.taken[D2].restack,true);
  assert.deepEqual(m.trucks.map(x=>x.name),['T-01','T-02']);assert.deepEqual(m.drivers.map(d=>d.name),['Dave','Sam']);assert.equal(m.team.needsStart,false);assert.deepEqual(m.sites.map(s=>s.name),['Bondi','Parramatta']);assert.equal(m.pickerLift,1500000);
  assert.equal(f.sim.planMonth(null).month,'2026-10','no month: this month');assert.equal(f.sim.planMonth('2027-10').grid.length,42,'a year ahead');
  // overdue open runs show on today whatever month is open
  f.clock(addDays(D0,3),'09:00');const later=f.sim.planMonth('2026-10');assert.ok(later.overdue.some(r=>r.kind==='loadList'),'the yard list is overdue');
});

test('GET /api/today: sites with a stage word and a bar, who is in, yesterday and where we begin, the head sentence',t=>{
  const f=planFixture(t,{now:L(D0,'16:00')});f.cmd('teamStart');f.cmd('planReplies',{on:false});const a=f.site('Bondi'),b=f.site('Parramatta'),c=f.site('Manly'),q=f.site('Quiet St');const {p,per}=f.stock(3);
  const liam=f.cmd('teamAdd',{name:'Liam',role:'SCAFFOLDER'}).person.id,noah=f.cmd('teamAdd',{name:'Noah',role:'SCAFFOLDER'}).person.id;
  // Bondi: gear there and more to go; Parramatta: waiting for its first gear; Manly: all there, then coming down
  f.cmd('gameSend',{site:a.id,lines:[{product:p.id,quantity:per}]});assert.ok(f.until(()=>f.piecesAt(a.id,p.id)===per,800));f.cmd('gameSend',{site:c.id,lines:[{product:p.id,quantity:per}]});assert.ok(f.until(()=>f.piecesAt(c.id,p.id)===per,800));
  f.cmd('planMaterials',{day:D1,site:a.id,lines:[{product:p.id,quantity:per}]});f.cmd('planMaterials',{day:D2,site:b.id,lines:[{product:p.id,quantity:10}]});
  const w=f.cmd('planWorkers',{day:D1,site:a.id,count:2,people:[liam,noah]});const tr=f.cmd('planTruck',{day:D1,truck:f.truck('T-02').id,driver:f.driver('Sam').id});
  let v=f.sim.todayView();const row=name=>v.sites.find(s=>s.name===name);
  assert.equal(row('Bondi').stage,'Going up');assert.equal(row('Bondi').on,per);assert.equal(row('Bondi').toGo,per);assert.equal(row('Bondi').bar,0.5);assert.equal(row('Bondi').dayWords,'Day 1 on site');assert.equal(row('Bondi').next.words,'Next: materials '+dayLabel(D1)+', 7:00 am');
  assert.equal(row('Parramatta').stage,'Waiting for gear');assert.equal(row('Parramatta').bar,0);assert.equal(row('Manly').stage,'All gear on site');assert.equal(row('Manly').bar,1);assert.equal(row('Quiet St').stage,'Quiet');assert.equal(row('Quiet St').bar,null);
  assert.equal(row('Bondi').whoWords,'2 site crew');assert.equal(v.summary.sentence,'Nothing planned today. Tomorrow: 3 things.');assert.equal(v.roster.tomorrow.words,"3 people haven't answered for tomorrow");
  assert.equal(v.roster.atYard.length,6,'every yard hand, with what they are doing');assert.ok(v.roster.atYard.every(r=>r.state.length===2));assert.ok(v.roster.notBooked.some(r=>r.kind==='driver'&&r.name==='Dave'));
  f.cmd('requestCollection',{site:c.id,neededOn:D1});assert.equal(f.sim.todayView().sites.find(s=>s.name==='Manly').stage,'Coming down');
  // the next day: who is in, where we begin, yesterday
  f.cmd('messageAnswer',{id:f.msgs(w.item.id).find(m=>m.person===liam).id,yes:true});f.cmd('messageAnswer',{id:f.msgs(tr.item.id)[0].id,yes:false,reason:'Family thing on'});
  f.clock(D1,'07:30');f.pass();v=f.sim.todayView();
  assert.equal(v.yesterday,D0);assert.ok(v.yesterdayDone.lines.some(l=>l.words==='Delivered to Bondi: '+per+' pieces'),JSON.stringify(v.yesterdayDone.lines));assert.equal(v.yesterdayDone.quiet,false);
  assert.deepEqual(v.roster.onSite.map(r=>r.words),['Liam · Bondi from 7:00 am']);assert.equal(v.roster.onSite[0].here,true);
  assert.deepEqual(v.roster.waiting.map(r=>[r.name,r.answer]),[['Sam','NO'],['Noah','NO_ANSWER']],"can't make it first");assert.equal(v.roster.waiting[0].words,"Can't make it: Family thing on");
  assert.equal(v.roster.driving[0].words,'Sam · T-02 from 7:00 am');assert.ok(v.sites.find(s=>s.name==='Bondi').who.includes('Liam'));
  assert.deepEqual(v.beginToday.items.map(i=>i.when),['7:00 am','7:00 am','7:00 am','Any time'],'plan items at their time, the collection any time');assert.match(v.summary.sentence,/^4 things today · 2 people haven't answered$/);
  assert.equal(v.sites[0].today,true,'sites with something today first');
  f.clock(addDays(D0,5),'09:00');assert.equal(f.sim.todayView().yesterdayDone.words,'A quiet day, nothing moved.');
});

test('phone views: a worker sees their messages (open first) and answers them; a driver has their own view; crew-day carries the messages and the role',t=>{
  const f=planFixture(t,{now:L(D0,'16:00')});f.cmd('teamStart');f.cmd('planReplies',{on:false});const a=f.site('Bondi','12 Smith St');const liam=f.cmd('teamAdd',{name:'Liam',role:'LEADING_HAND'}).person.id;
  const w=f.cmd('planWorkers',{day:D1,site:a.id,count:1,people:[liam]});const pv=f.sim.personView('worker',liam);
  assert.equal(pv.person.roleWords,'Leading hand');assert.equal(pv.messages.length,1);const m=pv.messages[0];assert.equal(m.canAnswer,true);assert.equal(m.siteName,'Bondi');assert.equal(m.address,'12 Smith St');assert.equal(m.directions,'https://maps.google.com/?q=12%20Smith%20St');assert.equal(m.words,'Can you make it?');
  const cd=f.sim.crewDay(liam);assert.equal(cd.role,'LEADING_HAND');assert.equal(cd.roleWords,'Leading hand');assert.equal(cd.messages[0].id,m.id);
  const ans=f.cmd('messageAnswer',{id:m.id,yes:true,via:'PHONE_VIEW'});assert.equal(ans.message,'Thanks. See you there.');assert.equal(ans.messageView.words,'You said yes, see you there');
  assert.equal(f.sim.personView('worker',liam).messages[0].answer,'YES');
  const no=f.cmd('messageAnswer',{id:m.id,yes:false,reason:'Something came up',via:'PHONE_VIEW'});assert.equal(no.messageView.words,"You said you can't make it",'they can change their mind before the time');
  const tr=f.cmd('planTruck',{day:D1,truck:f.truck('T-01').id,driver:f.driver('Dave').id});
  f.clock(D1,'08:00');const dv=f.sim.personView('driver',f.driver('Dave').id);assert.equal(dv.person.kind,'driver');assert.equal(dv.messages[0].subject,'DRIVE');assert.equal(dv.messages[0].answer,'NO_ANSWER');assert.equal(dv.today.truck.name,'T-01');assert.equal(dv.today.truck.where,'At the yard');
  assert.throws(()=>f.sim.personView('boss',liam),/Choose a worker or a driver/);f.cmd('planCancel',{id:tr.item.id});assert.equal(f.sim.personView('driver',f.driver('Dave').id).messages[0].words,'Called off');
  // a PACK message: Got it
  const {p,per}=f.stock(1);f.cmd('planMaterials',{day:D1,time:'10:00',site:a.id,lines:[{product:p.id,quantity:per}]});const packer=f.worker('Worker 1');const pm=f.sim.personView('worker',packer.id).messages.find(x=>x.subject==='PACK');
  assert.equal(pm.canSee,true);assert.throws(()=>f.cmd('messageAnswer',{id:pm.id,yes:true}),/doesn't need an answer/);assert.equal(f.cmd('messageSeen',{id:pm.id}).messageView.words,'Got it');
});

test('/api/state carries only result.plan: the plan revision (bumped by planner writes) and today\'s counts; team edits bump it too',t=>{
  const f=planFixture(t,{now:L(D0,'09:00')});f.cmd('teamStart');f.cmd('planReplies',{on:false});
  const s0=f.sim.snapshot();assert.deepEqual(s0.plan.today,{items:0,waiting:0,red:0});const r0=s0.plan.rev;
  f.cmd('planTruck',{day:D0,time:'10:00',truck:f.truck('T-01').id,driver:f.driver('Dave').id});const s1=f.sim.snapshot();assert.notEqual(s1.plan.rev,r0);assert.deepEqual(s1.plan.today,{items:1,waiting:1,red:0});
  f.cmd('teamUpdate',{id:f.worker('Worker 2').id,name:'Jack'});assert.notEqual(f.sim.snapshot().plan.rev,s1.plan.rev,'a rename of a yard hand shows on Today');
  f.clock(D0,'10:00');assert.deepEqual(f.sim.snapshot().plan.today,{items:1,waiting:0,red:1},'no answer by the time: red');
});

test('HTTP: /api/plan, /api/today, /api/person and /api/team for the office; supervisors get their own share and 403 where it is not theirs; /plan-cal.js is served',async t=>{
  const f=planFixture(t,{now:L(D0,'09:00')});f.cmd('teamStart');const a=f.site('Bondi'),b=f.site('Parramatta');const liam=f.cmd('teamAdd',{name:'Liam',role:'SCAFFOLDER'}).person.id;
  f.auth.addUser(f.user,{name:'Sue',email:'sue-api@example.com',password:'demonstration-password',roles:['SUPERVISOR']});const sueToken=f.auth.login({email:'sue-api@example.com',password:'demonstration-password'});const sue=f.auth.authenticate(sueToken);
  f.cmd('siteDetails',{id:a.id,supervisor:sue.id});f.cmd('planWorkers',{day:D1,site:b.id,count:1,people:[liam]});
  const server=createApp(f.db);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const base='http://127.0.0.1:'+server.address().port;
  const owner={cookie:'session='+f.auth.login({email:f.user.email,password:'demonstration-password'})},sup={cookie:'session='+sueToken};
  const get=async(path,headers)=>{const r=await fetch(base+path,{headers});return {status:r.status,body:r.headers.get('content-type')?.includes('json')?await r.json():await r.text()};};
  assert.equal((await get('/api/plan?month=2026-10')).status,401);
  const plan=await get('/api/plan?month=2026-10',owner);assert.equal(plan.status,200);assert.equal(plan.body.grid.length,42);assert.equal(plan.body.items.length,1);
  assert.equal((await get('/api/plan?month=2030-01',owner)).status,409);
  const today=await get('/api/today',owner);assert.equal(today.status,200);assert.ok(today.body.business.money);assert.ok(Array.isArray(today.body.sites));
  assert.equal((await get('/api/team',owner)).body.people.some(p=>p.name==='Liam'),true);assert.equal((await get('/api/team',sup)).status,403);
  assert.equal((await get('/api/person?kind=worker&id='+liam,owner)).status,200);assert.equal((await get('/api/person?kind=worker&id='+liam,sup)).status,403,'Liam is at the yard and only asked for Parramatta');
  const supPlan=await get('/api/plan?month=2026-10',sup);assert.equal(supPlan.status,200);assert.equal(supPlan.body.items.length,0);assert.equal((await get('/api/today',sup)).body.business,null);
  const js=await fetch(base+'/plan-cal.js');assert.equal(js.status,200);assert.match(js.headers.get('content-type'),/javascript/);assert.match(await js.text(),/export function monthGrid/);
  const cmd=await fetch(base+'/api/commands/planRestack',{method:'POST',headers:{...owner,'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify({day:D1})});assert.equal(cmd.status,200);assert.match((await cmd.json()).message,/Re-stack booked/);
  const denied=await fetch(base+'/api/commands/planRestack',{method:'POST',headers:{...sup,'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify({day:D2})});assert.equal(denied.status,403);
});
