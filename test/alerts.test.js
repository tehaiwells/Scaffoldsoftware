process.env.TZ='Australia/Sydney';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { atomic } from '../src/database.js';
import { Simulation } from '../src/simulation.js';
import { catalogueRevision } from '../src/repository.js';
import { fixture } from './simulation.test.js';
import { alFreeInYards,alBelow,alSort } from '../src/domain/alerts.js';
// Alerts and minimum stock levels: the minYard setting (override), the snapshot's derived alerts and the one-off 'below minimum' notification.
const WED=Date.parse('2026-09-23T00:00:00Z'),TODAY='2026-09-23';
const setup=t=>{const f=fixture(t);t.mock.timers.enable({apis:['Date'],now:WED});return f;};
const alerts=(sim,kind)=>sim.snapshot().alerts.items.filter(a=>!kind||a.kind===kind);
const lows=f=>f.sim.repo.all('notification').filter(n=>n.title==='Below minimum stock');
const user=(f,email,role)=>{f.auth.addUser(f.user,{name:role,email,password:'demonstration-password',roles:[role]});const u=f.auth.authenticate(f.auth.login({email,password:'demonstration-password'}));return new Simulation(f.db,u);};
const settle=(f,n=150)=>{f.tick(n);for(const task of f.sim.tasks().filter(t=>t.state==='BLOCKED'))f.cmd('retry',{id:task.id});f.tick(n);};

test('override minYard: a minimum-only save keeps the figures, needs no reason, bumps the catalogue revision and is validated',t=>{
  const f=fixture(t),p=f.products[0],before=f.sim.effective(p.id),rev=catalogueRevision(f.db,f.user.company_id);
  assert.ok(!('minYard' in before),'no minimum: no field');
  f.cmd('override',{product:p.id,minYard:150});
  const after=f.sim.effective(p.id);assert.equal(after.minYard,150);assert.equal(after.unitWeight,before.unitWeight);assert.equal(after.packQuantity,before.packQuantity);
  assert.ok(!('figuresStatus' in after),'a minimum is not company figures: the demo product still reads as demo');assert.notEqual(catalogueRevision(f.db,f.user.company_id),rev);
  assert.equal(f.sim.effectiveProducts().find(x=>x.id===p.id).minYard,150);
  assert.match(f.sim.repo.history(500).filter(l=>l.event==='PRODUCT_OVERRIDE').at(-1).reason,/keep at least 150 in the yard/);
  // a full override later keeps the minimum and now is company figures; an override without minYard keeps it too
  f.cmd('override',{product:p.id,unitWeight:4000,packQuantity:40,reason:'Weighed'});let e=f.sim.effective(p.id);assert.equal(e.minYard,150);assert.equal(e.unitWeight,4000);assert.equal(e.figuresStatus,'COMPANY CONFIGURED');
  f.cmd('override',{product:p.id,minYard:90});e=f.sim.effective(p.id);assert.equal(e.minYard,90);assert.equal(e.unitWeight,4000,'minimum-only save keeps the company weight');assert.equal(e.packQuantity,40);assert.equal(e.figuresStatus,'COMPANY CONFIGURED');
  f.cmd('override',{product:p.id,unitWeight:4100,packQuantity:40,reason:'Weighed again',minYard:120});assert.equal(f.sim.effective(p.id).minYard,120);
  for(const clear of [0,null]){f.cmd('override',{product:p.id,minYard:120});f.cmd('override',{product:p.id,minYard:clear});assert.ok(!('minYard' in f.sim.effective(p.id)),'cleared with '+clear);}
  for(const bad of [-1,1.5,'10',2000000])assert.throws(()=>f.cmd('override',{product:p.id,minYard:bad}),/Minimum in the yard must be a whole number/);
  assert.throws(()=>f.cmd('override',{product:f.products[1].id,unitWeight:10,packQuantity:1,minYard:5}),/Reason/,'a figures save still needs its reason');
  // supervisors cannot set minimums (operations only)
  const sup=user(f,'sup@example.com','SUPERVISOR');assert.throws(()=>sup.execute('override',{product:p.id,minYard:5},randomUUID()),{status:403});
});

test('below minimum: the snapshot flags it with the shortfall, counting only free serviceable stock in the yard',t=>{
  const f=fixture(t),p=f.products[0];assert.deepEqual(alerts(f.sim,'LOW_STOCK'),[]);
  f.cmd('override',{product:p.id,minYard:150});assert.deepEqual(alerts(f.sim,'LOW_STOCK'),[],'200 free: fine');
  f.cmd('condition',{id:f.a.id,condition:'DAMAGED',reason:'Bent frame'});
  let s=f.sim.snapshot(),low=s.alerts.items.find(a=>a.kind==='LOW_STOCK');
  assert.deepEqual({free:low.free,min:low.min,short:low.short,severity:low.severity,target:low.target},{free:100,min:150,short:50,severity:'medium',target:{view:'MATERIALS',id:p.id}});
  assert.deepEqual(s.alerts.below,{[p.id]:{min:150,free:100,short:50}});assert.match(low.detail,/100 free in the yard · keep at least 150 · 50 short/);
  const damaged=s.alerts.items.find(a=>a.kind==='DAMAGED');assert.equal(damaged.container,f.a.id);assert.equal(damaged.pieces,100);assert.equal(damaged.target.view,'HOME');assert.match(damaged.title,/is damaged/);
  f.cmd('condition',{id:f.a.id,condition:'SERVICEABLE',reason:'Repaired'});assert.deepEqual(alerts(f.sim,'DAMAGED'),[]);
  // a reservation takes stock out of the free count
  const request=f.cmd('request',{site:f.site.id,product:p.id,quantity:100});f.cmd('allocate',{id:request.id,truck:f.truck.id});
  low=alerts(f.sim,'LOW_STOCK')[0];assert.equal(low.free,100);assert.equal(low.short,50);
  // the snapshot's figure and the check's own company-wide figure agree
  s=f.sim.snapshot();assert.equal(alFreeInYards(s.stock,s.yards.map(y=>y.id)).get(p.id),f.sim.alYardFree(new Set([p.id])).get(p.id));
  f.cmd('override',{product:p.id,minYard:5000});assert.equal(alerts(f.sim,'LOW_STOCK')[0].severity,'medium');
  f.cmd('cancelRequest',{id:request.id,reason:'Not needed'});f.cmd('removeStock',{container:f.a.id,product:p.id,quantity:100,reason:'Sold'});f.cmd('removeStock',{container:f.b.id,product:p.id,quantity:100,reason:'Sold'});
  low=alerts(f.sim,'LOW_STOCK')[0];assert.equal(low.free,0);assert.equal(low.severity,'high','none free is urgent');assert.match(low.detail,/None free in the yard/);
});

test('a material dropping below its minimum adds one notification, only on the transition, never again each tick',t=>{
  const f=fixture(t),p=f.products[0];
  f.cmd('override',{product:p.id,minYard:150});assert.equal(lows(f).length,0);
  f.cmd('removeStock',{container:f.a.id,product:p.id,quantity:40,reason:'Sold'});assert.equal(lows(f).length,0,'160 free: still above');
  f.cmd('removeStock',{container:f.a.id,product:p.id,quantity:20,reason:'Sold'});assert.equal(lows(f).length,1,'140 free: dropped below');
  const [note]=lows(f);assert.equal(note.site,null,'a yard matter: never shown to supervisors');assert.match(note.body,/140 free in the yard, below your minimum of 150\. 10 short\./);
  f.tick(20);assert.equal(lows(f).length,1,'ticks never repeat it');
  f.cmd('removeStock',{container:f.a.id,product:p.id,quantity:10,reason:'Sold'});f.tick(5);assert.equal(lows(f).length,1,'still below: no new one');
  f.cmd('opening',{container:f.empty.id,product:p.id,quantity:50,reason:'Delivery'});assert.equal(lows(f).length,1);assert.deepEqual(f.sim.repo.all('alertState')[0].below,[],'recovered');
  f.cmd('removeStock',{container:f.empty.id,product:p.id,quantity:50,reason:'Sold'});assert.equal(lows(f).length,2,'a second drop is a new transition');
  f.tick(20);assert.equal(lows(f).length,2);
  // setting a minimum above the stock says so in the alerts, but the owner who set it gets no notification for it
  f.cmd('override',{product:f.products[1].id,minYard:10});assert.equal(lows(f).length,2);assert.ok(alerts(f.sim,'LOW_STOCK').some(a=>a.product===f.products[1].id));
  f.cmd('override',{product:f.products[1].id,minYard:20});assert.equal(lows(f).length,2,'raising it while below is still no drop');
  // a drop that happens inside a tick (stock written outside a command) is caught by the tick's own check, once
  f.cmd('opening',{container:f.empty.id,product:p.id,quantity:100,reason:'Delivery'});assert.deepEqual(f.sim.repo.all('alertState')[0].below,[f.products[1].id]);
  atomic(f.db,()=>{f.sim.repo.balance(f.empty.id,p.id,-100);f.sim.repo.event(f.user.id,'STOCK_REMOVED',{container:f.empty.id,product:p.id,quantity:100,reason:'test'});});
  assert.equal(lows(f).length,2);f.tick(1);assert.equal(lows(f).length,3);f.tick(30);assert.equal(lows(f).length,3);
  // the gate: with nothing new in the ledger or catalogue a tick's check does no work
  assert.equal(atomic(f.db,()=>f.sim.alCheck({gate:true})),null);
});

test('the tick check writes nothing when no minimum is set',t=>{
  const f=fixture(t);f.tick(3);assert.equal(f.sim.repo.all('alertState').length,0);assert.equal(lows(f).length,0);assert.deepEqual(f.sim.snapshot().alerts,{count:0,counts:{high:0,medium:0,low:0},items:[],below:{}});
});

test('yard lists: due today and not reserved, overdue, and trucks booked twice the same day',t=>{
  const f=setup(t),p=f.products[0];
  const today=f.cmd('createLoadList',{site:f.site.id,neededOn:TODAY,name:'Deck',lines:[{product:p.id,quantity:10}]});
  let a=alerts(f.sim).find(x=>x.id==='DUE_TODAY:'+today.id);assert.equal(a.severity,'medium');assert.deepEqual(a.target,{view:'SCHEDULE',id:today.id,day:TODAY});assert.match(a.detail,/Yard list for Site A · needed today · nothing reserved yet/);
  f.cmd('allocateLoadList',{id:today.id,truck:f.truck.id});assert.equal(alerts(f.sim,'DUE_TODAY').length,0,'reserved: nothing to flag today');
  const single=f.cmd('request',{site:f.site.id,product:f.products[1].id,quantity:5,neededOn:TODAY});assert.equal(alerts(f.sim,'DUE_TODAY')[0].target.id,single.id);
  // the next day both are overdue: the reserved list still is (it has not left the yard)
  t.mock.timers.setTime(Date.parse('2026-09-24T00:00:00Z'));const over=alerts(f.sim,'OVERDUE');
  assert.deepEqual(over.map(x=>x.target.id).sort(),[today.id,single.id].sort());assert.ok(over.every(x=>x.severity==='high'&&x.daysLate===1));assert.match(over.find(x=>x.target.id===today.id).detail,/was needed Wed 23 Sep \(1 day late\) · reserved on T01/);
  // a clash: the truck booked to two sites the same day
  const siteB=f.cmd('site',{name:'Site B'});const x=f.cmd('createLoadList',{site:f.site.id,neededOn:'2026-09-25',lines:[{product:p.id,quantity:5}]}),y=f.cmd('createLoadList',{site:siteB.id,neededOn:'2026-09-25',lines:[{product:p.id,quantity:5}]});
  f.cmd('bookTruck',{id:x.id,truck:f.truck.id});assert.equal(alerts(f.sim,'CLASH').length,0);f.cmd('bookTruck',{id:y.id,truck:f.truck.id});
  const clash=alerts(f.sim,'CLASH');assert.equal(clash.length,1,'one alert per truck and day');assert.equal(clash[0].title,'T01 booked twice on Fri 25 Sep');assert.match(clash[0].detail,/Runs to Site A and Site B/);assert.equal(clash[0].severity,'medium');
  // order: most severe first
  const all=alerts(f.sim);assert.deepEqual(all,[...all].sort(alSort));assert.equal(all[0].severity,'high');
});

test('blocked moves are alerts that point at the movement',t=>{
  const f=fixture(t);f.cmd('resources',{location:f.yard.id,workers:0,machines:0});const task=f.cmd('queue',{container:f.a.id,destination:f.truck.id});f.tick();
  const a=alerts(f.sim,'BLOCKED')[0];assert.equal(a.task,task.id);assert.equal(a.severity,'high');assert.deepEqual(a.target,{view:'ACTIVITY',id:task.id});assert.match(a.title,/^A move is blocked$/);assert.match(a.detail,/forklift/);
});

test('supervisors see only the alerts of their own sites, and never minimum stock',t=>{
  const f=setup(t),p=f.products[0],siteB=f.cmd('site',{name:'Site B'});const sup=user(f,'sup@example.com','SUPERVISOR');f.cmd('siteDetails',{id:f.site.id,supervisor:sup.user.id});
  f.cmd('override',{product:p.id,minYard:1000});
  const mine=f.cmd('createLoadList',{site:f.site.id,neededOn:TODAY,lines:[{product:p.id,quantity:5}]}),theirs=f.cmd('createLoadList',{site:siteB.id,neededOn:TODAY,lines:[{product:p.id,quantity:5}]});
  f.cmd('condition',{id:f.b.id,condition:'QUARANTINED',reason:'Inspection'});
  const own=sup.snapshot().alerts;assert.deepEqual(own.items.map(a=>a.id),['DUE_TODAY:'+mine.id]);assert.deepEqual(own.below,{});
  const ops=f.sim.snapshot().alerts.items.map(a=>a.kind).sort();assert.deepEqual(ops,['DAMAGED','DUE_TODAY','DUE_TODAY','LOW_STOCK']);
  // a clash with another site's run: the supervisor learns there is one, not which site
  f.cmd('bookTruck',{id:mine.id,truck:f.truck.id});f.cmd('bookTruck',{id:theirs.id,truck:f.truck.id});
  const c=sup.snapshot().alerts.items.find(a=>a.kind==='CLASH');assert.ok(c);assert.match(c.detail,/Runs to Site A and another site/);assert.ok(!JSON.stringify(sup.snapshot().alerts).includes('Site B'));
  // the stillage moved to their site with its stock: now theirs to see
  f.cmd('condition',{id:f.b.id,condition:'SERVICEABLE',reason:'Cleared'});f.cmd('queue',{container:f.b.id,destination:f.truck.id});settle(f);f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});f.tick(5);f.cmd('unload',{id:f.truck.id});settle(f,60);
  const box=f.sim.repo.get(f.b.id);assert.equal(box.location,f.site.id);f.cmd('condition',{id:f.b.id,condition:'DAMAGED',reason:'Dropped'});
  const d=sup.snapshot().alerts.items.find(a=>a.kind==='DAMAGED');assert.equal(d.container,f.b.id);assert.deepEqual(d.target,{view:'SITES',id:f.b.id,at:f.site.id,page:0});
});

test('pure helpers: free in yards clamps each yard on its own, below ignores retired and unset minimums',()=>{
  const stock={y1:{rows:[{product:'a',quantity:10,reserved:4,unserviceable:0,free:6}]},y2:{rows:[{product:'a',quantity:3,reserved:5,unserviceable:0}]},s1:{rows:[{product:'a',quantity:99,free:99}]}};
  assert.deepEqual([...alFreeInYards(stock,['y1','y2'])],[['a',6]]);
  const free=new Map([['a',6],['b',0]]);
  assert.deepEqual([...alBelow([{id:'a',minYard:10},{id:'b',minYard:1,retired:true},{id:'c',minYard:0},{id:'d'},{id:'e',minYard:2}],free)],[['a',{min:10,free:6,short:4}],['e',{min:2,free:0,short:2}]]);
});

test('a failing alert check never costs the command: it is logged and undone on its own',t=>{
  const f=fixture(t),p=f.products[0];f.cmd('override',{product:p.id,minYard:150});
  const real=f.sim.alYardFree;f.sim.alYardFree=function(){this.notify('half-written','x',null);throw new Error('boom');};const log=t.mock.method(console,'error',()=>{});
  try{f.cmd('removeStock',{container:f.a.id,product:p.id,quantity:60,reason:'Sold'});}finally{f.sim.alYardFree=real;}
  assert.equal(f.sim.repo.quantity(f.a.id,p.id),40,'the removal stands');assert.equal(f.sim.repo.all('notification').filter(n=>n.title==='half-written').length,0,'the check wrote nothing');
  assert.ok(log.mock.calls.some(c=>String(c.arguments[0]).includes('alert_check_error')));
  f.cmd('removeStock',{container:f.a.id,product:p.id,quantity:1,reason:'Sold'});assert.equal(lows(f).length,1,'the next command catches the drop');
});

test('a damaged stillage beyond the first 100 carries the snapshot page that holds it, so the alert link can open that page',t=>{
  const f=setup(t),big=f.cmd('yard',{name:'Big',segments:[{direction:'RIGHT',length:60000},{direction:'DOWN',length:40000},{direction:'LEFT',length:60000}],closed:true});let last;
  for(let i=0;i<105;i++)last=f.cmd('container',{name:'P'+String(i).padStart(3,'0'),location:big.id,type:'STILLAGE',length:2000,width:1000,height:1000,tare:50000,x:(i%15)*3000+8000,y:Math.floor(i/15)*2500+8000});
  f.cmd('opening',{container:last.id,product:f.products[0].id,quantity:12,reason:'Demo'});f.cmd('condition',{id:last.id,condition:'QUARANTINED',reason:'Inspection'});
  const a=alerts(f.sim,'DAMAGED').find(x=>x.container===last.id);assert.ok(a);assert.equal(a.target.page,1);assert.equal(a.target.view,'HOME');
  assert.ok(!f.sim.snapshot(0).containers.some(c=>c.id===last.id)&&f.sim.snapshot(1).containers.some(c=>c.id===last.id),'page 1 really holds it');
  f.cmd('condition',{id:f.b.id,condition:'DAMAGED',reason:'Dropped'});assert.equal(alerts(f.sim,'DAMAGED').find(x=>x.container===f.b.id).target.page,0);
});
