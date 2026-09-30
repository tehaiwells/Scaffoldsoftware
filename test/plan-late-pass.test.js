process.env.TZ='Australia/Sydney';// each test file runs in its own process; the planner's days and times are Sydney's
import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays } from '../src/domain/schedule.js';
import { planFixture,D0,L } from './helpers/plan-fixture.js';

// Phase 0, D8 (the round-4 clock probe re-run): a planner pass that comes late never writes "done" for a booking nobody confirmed or that never ran.
// It is marked MISSED with a plain reason and waits on the calendar, red, for a new day or Cancel, like a list that didn't go.
const W=addDays(D0,2),EVE=addDays(W,-1),D1=addDays(D0,1);
const neverDone=(it,why)=>{assert.equal(it.status,'MISSED');assert.ok(!it.log.some(l=>/^Day done/.test(l.text)),'no "Day done."');assert.equal(it.doneAt??null,null);
  assert.equal(it.problem,"Didn't go: "+why+'. Pick a new day or cancel it.');assert.ok(it.log.some(l=>l.text==="Didn't go: "+why+'.'));};
function setup(t){const f=planFixture(t,{now:L(D0,'09:00')});const site=f.site('Bondi','12 Smith St');
  const people=['Liam','Noah'].map(name=>f.cmd('teamAdd',{name,role:'SCAFFOLDER'}).person.id);return {f,site,people};}

test('the clock probe: workers booked, the app closed all day, one late pass the same evening: not "Day done.", MISSED',t=>{
  const {f,site,people}=setup(t);const w=f.cmd('planWorkers',{day:W,time:'07:00',site:site.id,count:2,people}).item;
  f.clock(W,'18:00');f.pass();
  neverDone(f.item(w.id),'the day passed while the app was closed');const v=f.view(w.id);assert.equal(v.words,"Didn't go");assert.equal(v.flags.red,true);assert.equal(v.canMove,true);
  assert.ok(f.sim.repo.all('resource').filter(r=>r.type==='WORKER').every(r=>!r.away),'nobody was moved');
  // a new day: asked again, and it runs
  f.clock(W,'18:05');f.cmd('planMove',{id:w.id,day:addDays(W,2),time:'07:00'});const moved=f.item(w.id);assert.equal(moved.status,'PLANNED');assert.equal(moved.problem,null);assert.equal(moved.why,null);
});

test('the late pass the next day says the app was closed; a whole missed day never writes done',t=>{
  const {f,site,people}=setup(t);const w=f.cmd('planWorkers',{day:D1,site:site.id,count:1,people:[people[0]]}).item;
  f.clock(addDays(D1,1),'10:00');f.pass();neverDone(f.item(w.id),'the day passed while the app was closed');
});

test('the engine ran all day but nobody said yes: not done, "nobody confirmed they were coming"',t=>{
  const {f,site,people}=setup(t);f.cmd('planReplies',{on:false});const w=f.cmd('planWorkers',{day:W,time:'07:00',site:site.id,count:2,people}).item;
  f.clock(EVE,'15:00');f.pass();assert.equal(f.msgs(w.id).length,2,'asked');f.clock(W,'07:00');f.pass();assert.equal(f.item(w.id).status,'ACTIVE');
  f.clock(W,'17:00');f.pass();neverDone(f.item(w.id),'nobody confirmed they were coming');
});

test('someone went: the day is done as before',t=>{
  const {f,site,people}=setup(t);f.cmd('planReplies',{on:false});const w=f.cmd('planWorkers',{day:W,time:'07:00',site:site.id,count:2,people}).item;
  f.clock(EVE,'15:00');f.pass();const [m]=f.msgs(w.id);f.cmd('messageAnswer',{id:m.id,yes:true});
  f.clock(W,'07:00');f.pass();assert.equal(f.item(w.id).people.filter(p=>p.moved).length,1);
  f.clock(W,'17:00');f.pass();f.clock(W,'17:01');f.pass();assert.equal(f.item(w.id).status,'DONE');
});

test('a truck booking: never ran, or the driver never said yes: MISSED, never done; with a yes it is done',t=>{
  const f=planFixture(t,{now:L(D0,'09:00')});f.cmd('teamStart');f.cmd('planReplies',{on:false});const dave=f.driver('Dave'),sam=f.driver('Sam'),t1=f.truck('T-01'),t2=f.truck('T-02');
  const closed=f.cmd('planTruck',{day:W,truck:t1.id,driver:dave.id}).item,quiet=f.cmd('planTruck',{day:addDays(W,1),truck:t1.id,driver:dave.id}).item;
  const yes=f.cmd('planTruck',{day:addDays(W,1),truck:t2.id,driver:sam.id}).item;f.cmd('messageAnswer',{id:f.msgs(yes.id)[0].id,yes:true});
  f.clock(W,'18:00');f.pass();neverDone(f.item(closed.id),'the day passed while the app was closed');
  const v=f.view(closed.id);assert.equal(v.words,"Didn't go");assert.equal(v.canMove,true,'a missed truck booking can go on a new day');
  f.clock(addDays(W,1),'06:00');f.pass();f.clock(addDays(W,1),'17:00');f.pass();
  neverDone(f.item(quiet.id),'Dave never said yes');assert.equal(f.item(yes.id).status,'DONE');
  f.cmd('planMove',{id:closed.id,day:addDays(W,3)});assert.equal(f.item(closed.id).status,'PLANNED');assert.equal(f.msgs(closed.id).filter(m=>m.status==='SENT').length,1,'Dave is asked again');
});

test('a re-stack whose day passed never ran: MISSED with the reason, not done',t=>{
  const f=planFixture(t,{now:L(D0,'09:00')});const r=f.cmd('planRestack',{day:D1,time:'07:00'}).item;
  f.clock(addDays(D1,1),'08:00');f.pass();neverDone(f.item(r.id),'the day passed while the app was closed');assert.equal(f.view(r.id).words,"Didn't go");
  const X=addDays(W,1),off=f.cmd('planRestack',{day:X,time:'07:00'}).item;f.cmd('jobsMode',{jobs:false});f.clock(X,'07:00');f.pass();f.clock(X,'17:00');f.pass();
  neverDone(f.item(off.id),'yard jobs were switched off');
});
