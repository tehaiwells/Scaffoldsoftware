import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Simulation } from '../src/simulation.js';
import { fixture } from './simulation.test.js';

test('loadTruck loads a whole pile top first plus a loose stillage in one request, and the crew completes it',t=>{
  const f=fixture(t);const upper=f.container('U',4000,4000,{support:f.a.id});
  const r=f.cmd('loadTruck',{truck:f.truck.id,containers:[f.a.id,f.b.id]});
  assert.deepEqual(r.tasks.map(x=>x.container),[upper.id,f.a.id,f.b.id],'the top stillage goes first');
  assert.equal(r.tasks[1].dependency,r.tasks[0].id,'the base waits for the stillage above it');assert.equal(r.tasks[0].dependency,null);assert.equal(r.tasks[2].dependency,null);
  assert.match(r.message,/Loading 3 stillages \(U, A, B\) onto T01\. The top one goes first/);
  assert.equal(f.sim.snapshot().balances.find(l=>l.container===f.a.id).reserved,100,'contents are reserved like a normal move');
  f.tick(90);
  for(const task of r.tasks)assert.equal(f.sim.repo.get(task.id).state,'COMPLETE');
  for(const c of [upper,f.a,f.b])assert.equal(f.sim.repo.get(c.id).location,f.truck.id);
  assert.equal(f.total(),200,'no stock created or lost');
});

test('loadTruck refuses cleanly and queues nothing when any stillage cannot go',t=>{
  const f=fixture(t);
  f.cmd('condition',{id:f.empty.id,condition:'DAMAGED',reason:'Bent frame (test)'});
  assert.throws(()=>f.cmd('loadTruck',{truck:f.truck.id,containers:[f.b.id,f.empty.id]}),/Empty is marked damaged/);
  assert.equal(f.sim.tasks().length,0,'all or nothing');
  const atSite=f.container('Far',4000,4000,{location:f.site.id});
  assert.throws(()=>f.cmd('loadTruck',{truck:f.truck.id,containers:[atSite.id]}),/Far is not at Yard, where T01 is/);
  assert.throws(()=>f.cmd('loadTruck',{truck:f.truck.id,containers:[]}),/Choose the stillages/);
  f.cmd('queue',{container:f.a.id,destination:f.truck.id});
  assert.throws(()=>f.cmd('loadTruck',{truck:f.truck.id,containers:[f.a.id]}),/already has a movement/);
});

test('loadTruck is idempotent, needs operations.manage and refuses a travelling truck',t=>{
  const f=fixture(t),key=randomUUID();
  const first=f.cmd('loadTruck',{truck:f.truck.id,containers:[f.b.id]},key),again=f.cmd('loadTruck',{truck:f.truck.id,containers:[f.b.id]},key);
  assert.equal(again.tasks[0].id,first.tasks[0].id);assert.equal(f.sim.tasks().length,1);
  f.auth.addUser(f.user,{name:'Supervisor',email:'sup-load@example.com',password:'demonstration-password',roles:['SUPERVISOR']});
  const sup=new Simulation(f.db,f.auth.authenticate(f.auth.login({email:'sup-load@example.com',password:'demonstration-password'})));
  assert.throws(()=>sup.execute('loadTruck',{truck:f.truck.id,containers:[f.a.id]},randomUUID()),{status:403});
  f.cmd('cancel',{id:first.tasks[0].id});
  const truck=f.sim.repo.get(f.truck.id);truck.status='IN_TRANSIT';f.sim.repo.save(truck);
  assert.throws(()=>f.cmd('loadTruck',{truck:f.truck.id,containers:[f.a.id]}),/T01 is travelling/);
});

test('loadTruck takes every stillage stacked side by side on a base, chains them in the pile, and the crew completes all of them',t=>{
  const f=fixture(t);const base=f.container('BIG',12000,8000,{length:2000,width:2000,envelopeLength:2000,envelopeWidth:2000});
  const x=f.container('X',12000,8000,{support:base.id,length:1000,width:2000}),y=f.container('Y',13000,8000,{support:base.id,length:1000,width:2000});
  const r=f.cmd('loadTruck',{truck:f.truck.id,containers:[base.id]});
  assert.deepEqual(r.tasks.map(task=>task.container),[x.id,y.id,base.id],'both stillages on top go before the base');
  assert.equal(r.tasks[1].dependency,r.tasks[0].id);assert.equal(r.tasks[2].dependency,r.tasks[1].id,'the base waits for the last one on top');
  f.tick(150);
  for(const task of r.tasks)assert.equal(f.sim.repo.get(task.id).state,'COMPLETE');
  for(const c of [x,y,base])assert.equal(f.sim.repo.get(c.id).location,f.truck.id);assert.equal(f.total(),200);
});

test('loading a base while the stillage on top is already being loaded waits for that load instead of refusing',t=>{
  const f=fixture(t);const upper=f.container('U',4000,4000,{support:f.a.id});
  const first=f.cmd('loadTruck',{truck:f.truck.id,containers:[upper.id]});assert.equal(first.tasks.length,1);
  const second=f.cmd('loadTruck',{truck:f.truck.id,containers:[f.a.id]});
  assert.deepEqual(second.tasks.map(task=>task.container),[f.a.id]);assert.equal(second.tasks[0].dependency,first.tasks[0].id);
  f.tick(90);assert.equal(f.sim.repo.get(f.a.id).location,f.truck.id);assert.equal(f.sim.repo.get(upper.id).location,f.truck.id);assert.equal(f.total(),200);
});

test('cancelling the first load of a pile with its dependents cancels the whole chain and releases the stock',t=>{
  const f=fixture(t);const upper=f.container('U',4000,4000,{support:f.a.id});
  const r=f.cmd('loadTruck',{truck:f.truck.id,containers:[f.a.id]});
  assert.throws(()=>f.cmd('cancel',{id:r.tasks[0].id}),/dependent/);
  f.cmd('cancel',{id:r.tasks[0].id,withDependents:true});
  for(const task of r.tasks)assert.equal(f.sim.repo.get(task.id).state,'CANCELLED');
  assert.equal(f.sim.snapshot().balances.find(l=>l.container===f.a.id).reserved,0);assert.equal(f.sim.snapshot().trucks[0].reservedWeight,0);
  assert.equal(f.sim.repo.get(upper.id).support,f.a.id,'nothing moved');
});

test('the snapshot lists what is stacked on each stillage and any live movement of it, and names each task container',t=>{
  const f=fixture(t);const upper=f.container('U',4000,4000,{support:f.a.id}),top=f.container('T',4000,4000,{support:upper.id});
  let s=f.sim.snapshot();assert.deepEqual(s.stacksAbove[f.a.id].map(o=>[o.name,o.task]),[['U',null],['T',null]]);assert.equal(s.stacksAbove[f.b.id],undefined);
  const r=f.cmd('loadTruck',{truck:f.truck.id,containers:[top.id]});s=f.sim.snapshot();
  const t0=s.stacksAbove[f.a.id].find(o=>o.name==='T').task;assert.equal(t0.id,r.tasks[0].id);assert.equal(t0.to,f.truck.id);
  assert.equal(s.tasks.find(task=>task.id===r.tasks[0].id).containerName,'T');
});
