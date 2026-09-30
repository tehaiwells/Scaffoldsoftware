process.env.TZ='Australia/Sydney';
import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays } from '../src/domain/schedule.js';
import { normMobile,mobileWords } from '../src/domain/team.js';
import { paperStatus } from '../src/domain/paperwork.js';
import { alSort } from '../src/domain/alerts.js';
import { planFixture,D0,L } from './helpers/plan-fixture.js';

test('the team: yard hands and site crew are workers with a role (yardsman at the yard, scaffolder on site unless set), drivers are their own rows',t=>{
  const f=planFixture(t);const site=f.site('Bondi');
  let v=f.sim.teamView();assert.equal(v.needsStart,true,'no drivers yet');const yardHands=v.people.filter(p=>p.kind==='worker'&&p.where==='Main yard');assert.equal(yardHands.length,4);assert.ok(yardHands.every(p=>p.role==='YARDSMAN'&&p.demoName&&!p.roleSet));
  assert.ok(v.people.filter(p=>p.where==='Bondi').every(p=>p.role==='SCAFFOLDER'),'site crew');
  const liam=f.cmd('teamAdd',{name:'  Liam  ',role:'SCAFFOLDER',mobile:'0412 345 678'});assert.equal(liam.message,'Liam is in your team as a scaffolder.');assert.equal(liam.person.mobile,'+61412345678');assert.equal(liam.person.mobileWords,'0412 345 678');
  const w=f.sim.repo.get(liam.person.id,'resource');assert.equal(w.type,'WORKER');assert.equal(w.location,f.yard.id);assert.equal(w.role,'SCAFFOLDER');assert.equal(w.enabled,true);
  const lh=f.cmd('teamAdd',{name:'Jack',role:'LEADING_HAND'});assert.equal(f.sim.repo.get(lh.person.id,'resource').role,'LEADING_HAND');
  const d=f.cmd('teamAdd',{name:'Dave',role:'DRIVER',mobile:'+61 412 000 111'});assert.equal(d.person.kind,'driver');const dr=f.sim.repo.get(d.person.id,'driver');assert.equal(dr.active,true);assert.equal(dr.mobile,'+61412000111');assert.equal(f.sim.repo.all('resource').some(r=>r.name==='Dave'),false,'a driver is never a yard resource');
  assert.throws(()=>f.cmd('teamAdd',{name:'liam',role:'YARDSMAN'}),/There's already a liam in your team/);assert.throws(()=>f.cmd('teamAdd',{name:'Zed',role:'BOSS'}),/Choose Yardsman, Scaffolder, Leading hand or Driver/);assert.throws(()=>f.cmd('teamAdd',{name:'',role:'YARDSMAN'}),/Enter a name/);
  // edits: rename, role, mobile; a worker cannot become a driver, a driver stays a driver
  const one=v.people.find(p=>p.name==='Worker 1'&&p.where==='Main yard');const ren=f.cmd('teamUpdate',{id:one.id,name:'Jack Smith',role:'LEADING_HAND'});assert.equal(ren.message,'Worker 1 is now Jack Smith.');assert.equal(f.sim.repo.get(one.id,'resource').role,'LEADING_HAND');
  assert.throws(()=>f.cmd('teamUpdate',{id:one.id,role:'DRIVER'}),/Add them again as a driver\./);assert.throws(()=>f.cmd('teamUpdate',{id:dr.id,role:'YARDSMAN'}),/Drivers stay drivers/);
  f.cmd('teamUpdate',{id:liam.person.id,mobile:''});assert.equal(f.sim.repo.get(liam.person.id,'resource').mobile,null);assert.equal(f.cmd('teamUpdate',{id:liam.person.id,name:'Liam'}).changed,false);
  v=f.sim.teamView();assert.equal(v.needsStart,false);assert.equal(v.people.at(-1).kind,'driver','drivers last');assert.equal(v.people.find(p=>p.id===one.id).demoName,false,'renamed: no longer a demo name');assert.ok(v.people.find(p=>p.id===one.id).phoneView.startsWith('?view=CREW&worker='));
});

test('mobiles: Australian mobiles are stored in E.164 and shown the way people write them; anything else is refused in plain words',()=>{
  for(const [input,out] of [['0412 345 678','+61412345678'],['0412-345-678','+61412345678'],['(04) 1234 5678','+61412345678'],['+61 412 345 678','+61412345678'],['+61 0412 345 678','+61412345678'],['+44 7700 900123','+447700900123'],['',null],[null,null]])assert.equal(normMobile(input),out,String(input));
  for(const bad of ['12345','0212345678','+61 2 9999 9999','04123456789','abc','0412 345 67a','+1','++61412345678','61+412345678'])assert.throws(()=>normMobile(bad),/Enter a mobile number like 0412 345 678\./,bad);
  assert.equal(mobileWords('+61412345678'),'0412 345 678');assert.equal(mobileWords('+447700900123'),'+447700900123');assert.equal(mobileWords(null),null);
});

test('leaving the team: a busy worker waits; a driver with a truck booked leaves it needing a driver; demo drivers are added once',t=>{
  const f=planFixture(t);const first=f.cmd('teamStart');assert.equal(first.added,2);assert.match(first.message,/Dave and Sam/);assert.equal(f.cmd('teamStart').added,0);
  const drivers=f.sim.repo.all('driver');assert.deepEqual(drivers.map(d=>d.name).sort(),['Dave','Sam']);assert.ok(drivers.every(d=>d.demo));assert.equal(f.sim.teamView().people.find(p=>p.name==='Dave').demo,true);
  const liam=f.cmd('teamAdd',{name:'Liam',role:'YARDSMAN'}).person.id;const w=f.sim.repo.get(liam,'resource');w.task='a-move';f.sim.repo.save(w);
  assert.throws(()=>f.cmd('teamRemove',{id:liam}),/Liam is busy on a job, try again in a moment\./);const x=f.sim.repo.get(liam,'resource');x.task=null;f.sim.repo.save(x);
  assert.equal(f.cmd('teamRemove',{id:liam}).message,'Liam has left the team.');assert.equal(f.sim.repo.get(liam,'resource').enabled,false);assert.throws(()=>f.cmd('teamRemove',{id:liam}),/already left/);
  const dave=f.driver('Dave'),tr=f.cmd('planTruck',{day:addDays(D0,3),truck:f.truck('T-01').id,driver:dave.id});f.cmd('teamRemove',{id:dave.id});
  const it=f.item(tr.item.id);assert.equal(it.driver,null);assert.equal(it.needsDriver,true);assert.equal(it.problem,'Needs a driver. Pick one.');assert.equal(f.view(it.id).words,'Needs a driver');
  for(const d of f.sim.repo.all('driver').filter(d=>d.active))f.cmd('teamRemove',{id:d.id});assert.equal(f.cmd('teamStart').added,0,'never twice, even with no drivers left');
  assert.throws(()=>f.cmd('planTruck',{day:addDays(D0,3),truck:f.truck('T-02').id,driver:dave.id}),/Choose a driver from your team/);
});

test('paperwork status: expired before today, due within 14 days (today included), good after that',()=>{
  const today='2026-10-13';
  assert.deepEqual(paperStatus(addDays(today,-1),today),{status:'EXPIRED',days:-1,words:'Expired yesterday'});assert.equal(paperStatus(addDays(today,-3),today).words,'Expired 3 days ago');
  assert.deepEqual(paperStatus(today,today),{status:'SOON',days:0,words:'Expires today'});assert.equal(paperStatus(addDays(today,1),today).words,'Expires tomorrow');
  assert.deepEqual(paperStatus(addDays(today,14),today),{status:'SOON',days:14,words:'Expires in 14 days'});
  assert.deepEqual(paperStatus(addDays(today,15),today),{status:'OK',days:15,words:'Good until 28 Oct'});assert.equal(paperStatus('2027-03-12',today).words,'Good until 12 Mar 2027');
});

test('paperwork: add, renew and remove SWMS, JHSA and permits per site or for the whole company; sites with gear or plans and no SWMS are named',t=>{
  const f=planFixture(t);const a=f.site('Bondi'),b=f.site('Parramatta'),c=f.site('Manly');const {p,per}=f.stock(1);
  f.cmd('gameSend',{site:a.id,lines:[{product:p.id,quantity:per}]});assert.ok(f.until(()=>f.piecesAt(a.id,p.id)>0,600));f.cmd('planWorkers',{day:addDays(D0,2),site:b.id,count:1});
  let v=f.sim.todayView().paperwork;assert.deepEqual(v.missing.map(m=>m.siteName),['Bondi','Parramatta'],'gear on site or something planned, no SWMS');assert.equal(v.words,'Nothing on file yet');
  const old=f.cmd('paperworkAdd',{type:'SWMS',site:a.id,expiresOn:addDays(D0,-3),reference:'SW-12'});assert.equal(old.message,'SWMS for Bondi saved. Its review is overdue.','a SWMS is reviewed, it never "expires" (Phase 0, D15)');
  const soon=f.cmd('paperworkAdd',{type:'JHSA',site:b.id,expiresOn:addDays(D0,5)});assert.equal(soon.message,'JHSA for Parramatta saved. Expires in 5 days.');
  f.cmd('paperworkAdd',{type:'PERMIT',title:'Council footpath permit',site:c.id,expiresOn:addDays(D0,60),note:'Hoarding on Smith St'});
  assert.throws(()=>f.cmd('paperworkAdd',{type:'PERMIT',expiresOn:addDays(D0,60)}),/Give the permit a name/);assert.throws(()=>f.cmd('paperworkAdd',{type:'SWMS',expiresOn:'2026-02-30'}),/Choose the expiry date/);assert.throws(()=>f.cmd('paperworkAdd',{type:'SWMS',site:a.id}),/Choose the day it was last reviewed/);assert.throws(()=>f.cmd('paperworkAdd',{type:'WHS',expiresOn:D0}),/Choose SWMS, JHSA, Permit or Other/);
  v=f.sim.todayView().paperwork;assert.deepEqual(v.items.map(i=>i.status),['EXPIRED','SOON','OK']);assert.deepEqual(v.counts,{expired:0,review:1,soon:1,ok:1});assert.equal(v.words,'1 SWMS due for review · 1 due soon');assert.deepEqual(v.missing.map(m=>m.siteName),['Parramatta'],'a SWMS due for review shows as that, not missing');
  assert.equal(v.items[0].words,'Review overdue');assert.equal(v.items[0].review,true);
  assert.equal(v.items[0].reference,'SW-12');assert.equal(v.items[2].typeWords,'Permit');assert.equal(v.canAddCompany,true);
  const renew=f.cmd('paperworkUpdate',{id:old.paperwork.id,reviewedOn:D0});assert.match(renew.message,/^SWMS marked as reviewed on .+\. Next review due 13 Oct 2027.$/);const r=f.sim.repo.get(old.paperwork.id,'paperwork');assert.ok(r.renewedAt);assert.equal(r.reviewedOn,D0);assert.equal(f.sim.todayView().paperwork.counts.review,0);
  f.cmd('paperworkAdd',{type:'SWMS',reviewedOn:addDays(D0,-30)});v=f.sim.todayView().paperwork;assert.deepEqual(v.missing.map(m=>m.siteName),['Parramatta'],'a company-wide SWMS never clears a site warning');assert.equal(v.companySwms,true);
  f.cmd('paperworkRemove',{id:soon.paperwork.id});assert.equal(f.sim.todayView().paperwork.items.length,3);assert.throws(()=>f.cmd('paperworkRemove',{id:soon.paperwork.id}),/already removed/);
});

test('alerts: expired paperwork (high), paperwork due soon (low), and people who can\'t make it or haven\'t answered for today or tomorrow (medium), sorted with the rest',t=>{
  const f=planFixture(t,{now:L(D0,'16:00')});f.cmd('teamStart');const a=f.site('Bondi');f.cmd('planReplies',{on:false});
  f.cmd('paperworkAdd',{type:'SWMS',site:a.id,expiresOn:addDays(D0,-1)});f.cmd('paperworkAdd',{type:'JHSA',site:a.id,expiresOn:addDays(D0,10)});f.cmd('paperworkAdd',{type:'SWMS',expiresOn:addDays(D0,40)});
  const liam=f.cmd('teamAdd',{name:'Liam',role:'SCAFFOLDER'}).person.id;const w=f.cmd('planWorkers',{day:addDays(D0,1),site:a.id,count:1,people:[liam]});f.cmd('messageAnswer',{id:f.msgs(w.item.id)[0].id,yes:false,reason:'Crook, not feeling well'});
  const tr=f.cmd('planTruck',{day:D0,time:'17:00',truck:f.truck('T-01').id,driver:f.driver('Dave').id});
  let al=f.sim.snapshot().alerts;const pw=al.items.filter(x=>x.kind==='PAPERWORK');assert.equal(pw.length,2);assert.equal(pw.find(x=>/Review overdue/.test(x.detail)).severity,'medium','a SWMS due for review is flagged, not "expired"');assert.match(pw.find(x=>/Review overdue/.test(x.detail)).detail,/mark it reviewed on the Today page/);assert.equal(pw.find(x=>/Expires in 10 days/.test(x.detail)).severity,'low');assert.deepEqual(pw[0].target,{view:'TODAY',day:D0});
  const ans=al.items.filter(x=>x.kind==='ANSWER');assert.equal(ans.length,1);assert.equal(ans[0].severity,'medium');assert.equal(ans[0].title,"Liam can't make it");assert.match(ans[0].detail,/Crook, not feeling well/);
  f.clock(D0,'17:00');al=f.sim.snapshot().alerts;assert.ok(al.items.some(x=>x.kind==='ANSWER'&&x.title==="Dave hasn't answered"));
  for(let i=0;i<al.items.length;i++)for(let j=0;j<al.items.length;j++)assert.ok(!Number.isNaN(alSort(al.items[i],al.items[j])),'every kind has a rank');
  assert.deepEqual([...al.items].sort(alSort).map(x=>x.id),al.items.map(x=>x.id),'already in order');
  f.cmd('planCancel',{id:tr.item.id});assert.ok(!f.sim.snapshot().alerts.items.some(x=>x.title==="Dave hasn't answered"),'called off: no alert');
});
