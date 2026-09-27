process.env.TZ='Australia/Sydney';// the server's local day is Sydney's
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Simulation } from '../src/simulation.js';
import { fixture } from './simulation.test.js';

// Scheduled returns after review: a collection with nothing left to collect closes itself (no overdue alert for an empty site), and cancelling a
// collection that is already loading is office work.
const WED=Date.parse('2026-09-23T00:00:00Z');// Wednesday 23 Sep 2026, 10:00 in Sydney
const setup=t=>{const f=fixture(t);t.mock.timers.enable({apis:['Date'],now:WED});return f;};
const settle=(f,n=150)=>{f.tick(n);for(const task of f.sim.tasks().filter(t=>t.state==='BLOCKED'))f.cmd('retry',{id:task.id});f.tick(n);};
const user=(f,email,role)=>{f.auth.addUser(f.user,{name:'Sam Supervisor',email,password:'demonstration-password',roles:[role]});return new Simulation(f.db,f.auth.authenticate(f.auth.login({email,password:'demonstration-password'})));};
const as=(sim,action,input)=>sim.execute(action,input,randomUUID());
const stockOnSite=f=>{f.cmd('loadTruck',{truck:f.truck.id,containers:[f.a.id,f.b.id]});settle(f);f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});f.tick(5);f.cmd('unload',{id:f.truck.id});settle(f);};
const DAY=86400000;

test('an open collection whose stillages went back another way closes itself instead of raising an overdue alert',t=>{const f=setup(t);stockOnSite(f);
 const all=f.cmd('requestCollection',{site:f.site.id,neededOn:'2026-09-24',truck:f.truck.id});
 // the older path: someone drags both stillages onto the truck at the site and takes them to the yard
 f.cmd('returnStock',{container:f.a.id,truck:f.truck.id});settle(f);
 assert.equal(f.sim.repo.get(all.id,'collection').status,'BOOKED','one stillage is still on site; the truck is still parked there');
 f.cmd('returnStock',{container:f.b.id,truck:f.truck.id});settle(f);
 assert.equal(f.sim.repo.get(all.id,'collection').status,'BOOKED','both on the truck, but it has not left the site yet');
 f.cmd('dispatch',{id:f.truck.id,destination:f.yard.id});f.tick(5);f.cmd('unload',{id:f.truck.id});settle(f);
 const o=f.sim.repo.get(all.id,'collection');assert.equal(o.status,'CANCELLED');assert.match(o.reason,/Nothing left on site to collect/);
 t.mock.timers.setTime(WED+3*DAY);const s=f.sim.snapshot();assert.ok(!s.alerts.items.some(i=>i.id.includes(all.id)),'no overdue alert for it');
 assert.ok(f.sim.repo.all('notification').some(n=>n.title==='Collection closed'));
});

test('a collection of chosen stillages closes when none of them is on site any more, and stays open while one is',t=>{const f=setup(t);stockOnSite(f);
 const one=f.cmd('requestCollection',{site:f.site.id,scope:'SELECTED',containers:[f.a.id],neededOn:'2026-09-24'});
 f.cmd('returnStock',{container:f.b.id,truck:f.truck.id});settle(f);f.cmd('dispatch',{id:f.truck.id,destination:f.yard.id});f.tick(5);
 assert.equal(f.sim.repo.get(one.id,'collection').status,'REQUESTED','A (the one it collects) is still on site');
 f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});f.tick(5);f.cmd('returnStock',{container:f.a.id,truck:f.truck.id});settle(f);f.cmd('dispatch',{id:f.truck.id,destination:f.yard.id});f.tick(5);
 assert.equal(f.sim.repo.get(one.id,'collection').status,'CANCELLED');
});

test('a supervisor can cancel a collection before loading, but not one the office is loading',t=>{const f=setup(t);stockOnSite(f);
 const sup=user(f,'sup@example.com','SUPERVISOR');f.cmd('siteDetails',{id:f.site.id,supervisor:sup.user.id});
 const c=f.cmd('requestCollection',{site:f.site.id,neededOn:'2026-09-23',truck:f.truck.id});const r=f.cmd('loadCollection',{id:c.id});
 assert.equal(sup.snapshot().collections.find(x=>x.id===c.id).canCancel,false,'no Cancel button for the supervisor while it loads');
 assert.equal(f.sim.snapshot().collections.find(x=>x.id===c.id).canCancel,true,'the office keeps it');
 assert.throws(()=>as(sup,'cancelCollection',{id:c.id}),/Ask the yard office/);
 assert.ok(f.sim.tasks().filter(x=>r.tasks.some(y=>y.id===x.id)).every(x=>x.state!=='CANCELLED'),'the loading moves are untouched');
 f.cmd('cancelCollection',{id:c.id});assert.equal(f.sim.repo.get(c.id,'collection').status,'CANCELLED');
 const d=as(sup,'requestCollection',{site:f.site.id,neededOn:'2026-09-25'});assert.equal(sup.snapshot().collections.find(x=>x.id===d.id).canCancel,true);
 assert.equal(as(sup,'cancelCollection',{id:d.id}).status,'CANCELLED');
});
