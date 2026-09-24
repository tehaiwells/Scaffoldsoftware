import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './simulation.test.js';
import { normalise,lShape,splitSide,freeZone,sides,slantedSides,sameGround,ringInside } from '../public/shape.js';
const rectPts=(w,h,x=0,y=0)=>[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
const pickedTurn=f=>{for(let i=0;i<40;i++){f.tick(1);const t=f.sim.tasks().find(t=>t.turn&&t.picked&&!['COMPLETE','CANCELLED'].includes(t.state));if(t)return t;}return null;};

test('the shape guard ignores automatic yard saves (sweep, parking) but refuses a stale shape',t=>{const f=fixture(t);const opened=f.sim.repo.get(f.yard.id),rev=opened.shapeRev??0;
 const y=f.sim.repo.get(f.yard.id);y.lastSweep='delivery-1';f.sim.repo.save(y);f.cmd('parking',{id:f.yard.id,side:'LEFT',vehicleLength:8000,vehicleWidth:2500,clearance:500});
 const wider=rectPts(25000,16000);assert.equal(f.sim.boundaryPreview({id:f.yard.id,points:wider,shapeRev:rev}).ok,true);
 const r=f.cmd('yard',{id:f.yard.id,name:opened.name,points:wider,shapeRev:rev});assert.equal(r.lastSweep,'delivery-1');assert.equal(r.parking.side,'LEFT');assert.equal(r.shapeRev,rev+1);
 assert.throws(()=>f.cmd('yard',{id:f.yard.id,points:opened.points,shapeRev:rev}),/Someone else saved Yard while you were editing/);
 assert.equal(f.cmd('fixtures',{id:f.yard.id,fixtures:[{kind:'TOILET',x:12000,y:1000}]}).shapeRev,rev+2);
 const s=f.cmd('siteDetails',{id:f.site.id,name:'Renamed site'});assert.equal(s.shapeRev,1);assert.equal(f.cmd('siteDetails',{id:f.site.id,address:'1 Road'}).shapeRev,1);});

test('a waiting turn whose spot the new shape covers stops before pickup; a turn already on the forks makes the save wait',t=>{const f=fixture(t);const yard=f.sim.repo.get(f.yard.id);
 f.cmd('rotate',{container:f.a.id,rotation:90});const move={id:yard.id,points:yard.points,loading:{x:4000,y:2500}};
 const q=f.sim.boundaryPreview(move);assert.equal(q.ok,true);assert.deepEqual(q.halted.map(h=>[h.name,h.turn]),[['A',true]]);
 const r=f.cmd('yard',move);assert.match(r.message,/re-planned or stopped/);const task=f.sim.tasks().find(t=>t.turn);assert.equal(task.state,'BLOCKED');assert.ok(!task.picked);assert.match(task.reason,/covers the spot A was being turned into/);
 f.tick(20);assert.equal(f.sim.repo.get(f.a.id).location,f.yard.id);f.cmd('cancel',{id:task.id});assert.equal(f.total(),200);
 const g=fixture(t);g.cmd('rotate',{container:g.a.id,rotation:90});const carried=pickedTurn(g);assert.ok(carried,'turn picked up');
 const cover={id:g.yard.id,points:g.sim.repo.get(g.yard.id).points,loading:{x:4000,y:2500}};
 assert.match(g.sim.boundaryPreview(cover).message,/A is on Forklift 1 heading for a spot the new yard shape covers/);assert.throws(()=>g.cmd('yard',cover),/Wait until it has been set down/);
 g.tick(40);assert.deepEqual([g.sim.repo.get(g.a.id).x,g.sim.repo.get(g.a.id).rotation],[4500,90]);});

test('the engine refuses to pick up a load whose destination the location no longer allows, so Cancel still works',t=>{const f=fixture(t);const task=f.cmd('queue',{container:f.empty.id,destination:f.yard.id,position:{x:12000,y:8000,rotation:0,support:null}});
 const y=f.sim.repo.get(f.yard.id);y.fixtures=[{id:'F1',kind:'TOILET',name:'Toilet',x:12500,y:8000,w:1500,h:1500}];f.sim.repo.save(y);
 f.tick(10);const t2=f.sim.repo.get(task.id);assert.equal(t2.state,'BLOCKED');assert.match(t2.reason,/Keep the toilet clear/);assert.ok(!t2.picked);f.cmd('cancel',{id:task.id});assert.equal(f.sim.repo.get(f.empty.id).x,10000);});

test('the full boundary preview is bounded; a tight shrink is refused before any search; the preview reports every stillage at the location',t=>{const f=fixture(t);let n=0;
 for(let y=6000;y<=15000;y+=1000)for(let x=0;x<=18000;x+=2000){try{f.container('P'+(++n),x,y);}catch{}}
 const here=f.sim.containers().filter(c=>c.location===f.yard.id).length;assert.ok(here>=100,'at least 100 stillages: '+here);
 const q=f.sim.boundaryPreview({id:f.yard.id,points:rectPts(20000,15000)});assert.equal(q.stock.length,here);
 const full=f.sim.boundaryPreview({id:f.yard.id,points:rectPts(20000,15000),detail:'full'});assert.equal(full.ok,true,full.message);assert.equal(full.moved.length,q.affected.length);
 const slow=f.sim.boundaryPreview({id:f.yard.id,points:rectPts(20000,15000),detail:'full',budgetMs:0});assert.equal(slow.ok,true);assert.equal(slow.slow,true);assert.equal(slow.moved,null);assert.match(slow.message,/chosen when you save/);
 const tight=f.sim.boundaryPreview({id:f.yard.id,points:rectPts(20000,8000)});assert.equal(tight.ok,false);assert.match(tight.message,/Not enough free ground inside the new yard shape for the \d+ stillages that must move/);});

test('a large relocation previews and saves quickly (384 stillages, 48 and 96 moved)',t=>{const f=fixture(t);const big=f.cmd('yard',{name:'Big',points:rectPts(60000,40000)});f.cmd('resources',{location:big.id,workers:5,machines:2,jobs:false});let n=0;
 for(let y=4000;y<36000;y+=2000)for(let x=4000;x<56000;x+=3000){const c=f.cmd('container',{name:'S'+(++n),location:big.id,type:'STILLAGE',length:2000,width:1000,height:1000,tare:50000,x,y});if(n%3===0)f.cmd('container',{name:'U'+n,location:big.id,type:'STILLAGE',length:2000,width:1000,height:1000,tare:50000,x,y,support:c.id});}
 let t0=performance.now();const q=f.sim.boundaryPreview({id:big.id,points:rectPts(52000,40000)});assert.ok(performance.now()-t0<100,'quick');assert.equal(q.affected.length,48);
 t0=performance.now();const full=f.sim.boundaryPreview({id:big.id,points:rectPts(52000,40000),detail:'full'});assert.ok(performance.now()-t0<500,'full');assert.equal(full.moved.length,48);
 t0=performance.now();const r=f.cmd('yard',{id:big.id,points:rectPts(46000,40000)});assert.ok(performance.now()-t0<2000,'save');assert.equal(r.relocated.length,96);});

test('a pile whose base must be carried out to turn is set down where it does not block that route (Demo yard layout)',t=>{const f=fixture(t);
 const y=f.cmd('yard',{name:'Demo yard',points:rectPts(9000,16000),loading:{x:500,y:2000},gate:{x:1000,y:12000},fixtures:[{kind:'ENTRY',x:500,y:12500,w:4000,h:3000},{kind:'EXIT',x:4500,y:12500,w:4000,h:3000},{kind:'OFFICE',x:2500,y:500,w:6000,h:3000},{kind:'TOILET',x:500,y:500,w:1500,h:1500}]});
 f.cmd('resources',{location:y.id,workers:5,machines:1,stepMs:100,speed:100000,jobs:false});const at=(name,x,yy,extra={})=>f.cmd('container',{name,location:y.id,type:'STILLAGE',length:2000,width:1000,height:1000,tare:50000,x,y:yy,...extra});
 const base=at('S-002',7000,4000);at('S-003',5500,5000);at('S-008',3500,5000);at('S-007',7000,4000,{support:base.id});
 const plan=f.sim.turnPreview({container:base.id});assert.equal(plan.ok,true,plan.message);assert.equal(plan.steps.length,3);assert.deepEqual(plan.steps.map(s=>[s.name,s.park]),[['S-007',true],['S-002',false],['S-007',false]]);});

test('automatic placement works in shapes whose bounding-box corner is outside (L with the top-left cut out)',t=>{const f=fixture(t);
 const pts=normalise(lShape(20000,16000,8000,6000,'TL',{x0:0,y0:0,x1:20000,y1:16000}));const y=f.cmd('yard',{name:'L',points:pts,loading:{x:9000,y:14000}});
 const c=f.cmd('quickAdjust',{location:y.id,kind:'STILLAGE',delta:1});assert.equal(c.location,y.id);});

test('removed stillages cannot be turned and never turn the stillage they sat on',t=>{const f=fixture(t);f.cmd('retire',{id:f.empty.id,reason:'old'});
 const p=f.sim.turnPreview({container:f.empty.id});assert.equal(p.ok,false);assert.match(p.message,/has been removed from storage/);assert.throws(()=>f.cmd('rotate',{container:f.empty.id,rotation:90}),/removed from storage/);
 const u=f.container('U',7000,4000,{support:f.b.id});f.cmd('retire',{id:u.id,reason:'old'});assert.equal(f.sim.turnPreview({container:u.id}).ok,false);assert.equal(f.sim.tasks().length,0);});

test('a legacy 101-corner yard can still be renamed, get fixtures and be previewed',t=>{const f=fixture(t);const s=[];for(let i=0;i<48;i++){s.push({direction:'RIGHT',length:1000});s.push({direction:i%2?'UP':'DOWN',length:500});}s.push({direction:'RIGHT',length:5000},{direction:'DOWN',length:20000},{direction:'LEFT',length:30000},{direction:'LEFT',length:23000});
 const y=f.cmd('yard',{name:'Legacy',segments:s,closed:true});assert.equal(y.points.length,101);assert.equal(f.cmd('yard',{id:y.id,name:'Renamed'}).name,'Renamed');
 assert.equal(f.cmd('fixtures',{id:y.id,fixtures:[]}).points.length,101);assert.equal(f.sim.boundaryPreview({id:y.id,points:y.points}).ok,true);assert.equal(f.cmd('yard',{id:y.id,points:y.points}).points.length,101);});

test('the preview and the save count stopped orders and handed-back jobs the same way; a yard that only grows stops nothing',t=>{
 const walking=f=>{const w=f.sim.repo.all('resource').find(r=>r.type==='WORKER'&&r.location===f.yard.id);f.cmd('workerCommand',{id:w.id,order:'MOVE',x:15000,y:12000});return w;};
 // Squaring up / enlarging: the old ground lies inside the new one, zones and height unchanged -> no stops, no hand-backs, walkers keep walking.
 const f=fixture(t);const w=walking(f);const wider={id:f.yard.id,points:rectPts(22000,16000)};const q=f.sim.boundaryPreview(wider);assert.equal(q.grows,true);assert.equal(q.stops,0);assert.equal(q.jobs,0);
 const r=f.cmd('yard',wider);assert.equal(r.message,'Saved.');assert.ok(f.sim.repo.get(w.id).walk,'still walking');assert.notEqual(f.sim.repo.get(w.id).workerMode,'HOLD');
 // A shrink stops the order, in the preview and in the save.
 const g=fixture(t);const v=walking(g);const smaller={id:g.yard.id,points:rectPts(18000,16000)};const q2=g.sim.boundaryPreview(smaller);assert.equal(q2.grows,false);assert.equal(q2.stops,1);assert.equal(q2.jobs,0);
 assert.match(g.cmd('yard',smaller).message,/1 manual worker\/forklift order\(s\) stopped/);assert.equal(g.sim.repo.get(v.id).walk,null);
 // Same ground but a moved loading zone still stops the order; so does a bigger yard with a moved zone.
 const h=fixture(t);walking(h);const zone={id:h.yard.id,points:h.sim.repo.get(h.yard.id).points,loading:{x:12000,y:10000}};const q3=h.sim.boundaryPreview(zone);assert.equal(q3.stops,1);assert.match(h.cmd('yard',zone).message,/1 manual worker\/forklift order\(s\) stopped/);
 const k=fixture(t);walking(k);assert.equal(k.sim.boundaryPreview({id:k.yard.id,points:rectPts(22000,16000),loading:{x:12000,y:10000}}).stops,1);});

test('a yard that only grows leaves in-flight movements alone; a lower height or a new fixture is not growth',t=>{const f=fixture(t);
 const task=f.cmd('queue',{container:f.empty.id,destination:f.yard.id,position:{x:14000,y:12000,rotation:0,support:null}});
 for(let i=0;i<10&&!['ASSIGNED','TRAVELLING_TO_PICKUP'].includes(f.sim.repo.get(task.id).state);i++)f.tick(1);f.cmd('pause',{paused:true});const before=f.sim.repo.get(task.id);assert.ok(['ASSIGNED','TRAVELLING_TO_PICKUP'].includes(before.state),before.state);
 const slant=[{x:0,y:0},{x:20000,y:0},{x:24000,y:16000},{x:0,y:16000}];const r=f.cmd('yard',{id:f.yard.id,points:slant});assert.equal(r.message,'Saved.');
 const after=f.sim.repo.get(task.id);assert.equal(after.state,before.state);assert.deepEqual(after.resources,before.resources);assert.deepEqual(after.path,before.path);
 f.cmd('pause',{paused:false});f.tick(20);assert.equal(f.sim.repo.get(task.id).state,'COMPLETE');
 const y=f.sim.repo.get(f.yard.id);assert.equal(f.sim.boundaryPreview({id:y.id,points:rectPts(25000,16000),height:9000}).grows,false);assert.equal(f.sim.boundaryPreview({id:y.id,points:rectPts(25000,16000),fixtures:[{kind:'TOILET',x:22000,y:1000}]}).grows,false);assert.equal(f.sim.boundaryPreview({id:y.id,points:rectPts(25000,16000),height:12000}).grows,true);});

test('ringInside: the new ground contains the old one (shared sides allowed, crossings and notches refused)',()=>{const L=[{x:0,y:0},{x:10,y:0},{x:10,y:5},{x:5,y:5},{x:5,y:10},{x:0,y:10}],V=[{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:6,y:10},{x:5,y:5},{x:4,y:10},{x:0,y:10}];
 assert.equal(ringInside(rectPts(10,10),rectPts(10,10)),true);assert.equal(ringInside(rectPts(10,10),rectPts(20,10)),true);assert.equal(ringInside(rectPts(20,10),rectPts(10,10)),false);assert.equal(ringInside(rectPts(4,4,3,3),rectPts(10,10)),true);
 assert.equal(ringInside(L,rectPts(10,10)),true);assert.equal(ringInside(rectPts(10,10),L),false);assert.equal(ringInside([{x:0,y:10},{x:10,y:0},{x:0,y:0}],L),true);assert.equal(ringInside([{x:0,y:10},{x:10,y:0},{x:10,y:10}],L),false);
 assert.equal(ringInside(rectPts(10,10),V),false);assert.equal(ringInside([{x:0,y:0},{x:10,y:0},{x:6,y:10},{x:4,y:10}],V),false,'a side over the notch between two fence corners');
 const owner=[{x:0,y:0},{x:35000,y:0},{x:35000,y:16000},{x:5000,y:16000}];assert.equal(ringInside(owner,rectPts(35000,16000)),true);assert.equal(ringInside(rectPts(35000,16000),owner),false);assert.equal(ringInside(rectPts(10,10,-1,0),rectPts(10,10)),false);assert.equal(ringInside([],rectPts(1,1)),false);});

const pileAt=f=>{const A=f.container('PA',8000,8000),U=f.container('PU',8000,8000,{support:A.id,length:1000,width:1000});const r=f.cmd('rotate',{container:A.id,rotation:90});return {A,U,ids:r.tasks.map(t=>t.id),layout:r.layout.id};};
const until=(f,ok,n=60)=>{for(let i=0;i<n&&!ok();i++)f.tick(1);return ok();};
test('a boundary save that moves the stillage a waiting step stacks onto stops that step before pickup; one already carried makes the save wait',t=>{
 const f=fixture(t);const {A,ids,layout}=pileAt(f);assert.ok(until(f,()=>f.sim.repo.get(ids[1]).state==='COMPLETE'));f.cmd('pause',{paused:true});assert.ok(!f.sim.repo.get(ids[2]).picked);
 const a=f.sim.repo.get(A.id),bin=[{kind:'CUSTOM',name:'Bin',x:a.x+100,y:a.y+1500,w:500,h:400}];
 const q=f.sim.boundaryPreview({id:f.yard.id,points:f.sim.repo.get(f.yard.id).points,fixtures:bin});assert.equal(q.ok,true,q.message);assert.deepEqual(q.halted.map(h=>[h.name,h.why]),[['PU','support']]);
 const r=f.cmd('fixtures',{id:f.yard.id,fixtures:bin});assert.match(r.message,/Moved 1 stillage\(s\) clear of the fixtures: PA/);assert.match(r.message,/1 movement\(s\) re-planned or stopped/);
 const s=f.sim.repo.get(ids[2]);assert.equal(s.state,'BLOCKED');assert.ok(!s.picked);assert.match(s.reason,/PA, which PU was to be stacked on, was moved/);
 const other=f.cmd('queue',{container:f.b.id,destination:f.yard.id,position:{x:14000,y:12000,rotation:0,support:null}});f.cmd('pause',{paused:false});f.tick(30);assert.equal(f.sim.repo.get(other.id).state,'COMPLETE','the yard is not frozen');
 f.cmd('cancelLayout',{id:layout});assert.equal(f.sim.repo.get(ids[2]).state,'CANCELLED');assert.equal(f.total(),200);
 const g=fixture(t);const P=pileAt(g);assert.ok(until(g,()=>g.sim.repo.get(P.ids[2]).picked));g.cmd('pause',{paused:true});const b=g.sim.repo.get(P.A.id),bin2=[{kind:'CUSTOM',name:'Bin',x:b.x+100,y:b.y+1500,w:500,h:400}];
 assert.match(g.sim.boundaryPreview({id:g.yard.id,points:g.sim.repo.get(g.yard.id).points,fixtures:bin2}).message,/PU is on Forklift 1 heading for a stack on PA, which the new yard shape moves\. Wait until it has been set down/);
 assert.throws(()=>g.cmd('fixtures',{id:g.yard.id,fixtures:bin2}),/Wait until it has been set down/);assert.deepEqual([g.sim.repo.get(P.A.id).x,g.sim.repo.get(P.A.id).y],[b.x,b.y]);
 g.cmd('pause',{paused:false});assert.ok(until(g,()=>g.sim.repo.get(P.ids[2]).state==='COMPLETE'));assert.equal(g.sim.repo.get(P.U.id).support,P.A.id);});

test('lowering the height below a planned stack stops the waiting step before pickup; one already carried makes the save wait',t=>{
 const f=fixture(t);const {ids,layout}=pileAt(f);assert.ok(until(f,()=>f.sim.repo.get(ids[0]).state==='COMPLETE'));f.cmd('pause',{paused:true});assert.ok(!f.sim.repo.get(ids[2]).picked);
 const q=f.sim.boundaryPreview({id:f.yard.id,height:1500});assert.equal(q.ok,true,q.message);assert.deepEqual(q.halted.map(h=>[h.name,h.why]),[['PU','height']]);
 const r=f.cmd('yard',{id:f.yard.id,height:1500});assert.match(r.message,/re-planned or stopped/);const s=f.sim.repo.get(ids[2]);assert.equal(s.state,'BLOCKED');assert.ok(!s.picked);assert.match(s.reason,/new height is too low/);
 f.cmd('pause',{paused:false});f.tick(20);assert.ok(!f.sim.repo.get(ids[2]).picked);f.cmd('cancelLayout',{id:layout});assert.equal(f.total(),200);
 const g=fixture(t);const P=pileAt(g);assert.ok(until(g,()=>g.sim.repo.get(P.ids[2]).picked));g.cmd('pause',{paused:true});
 assert.throws(()=>g.cmd('yard',{id:g.yard.id,height:1500}),/PU is on Forklift 1 heading for a stack taller than the new height\. Wait until it has been set down/);});

test('the engine will not lift a load whose stack base has moved or whose stack no longer fits the height, so Cancel still works',t=>{
 for(const change of ['moved','height']){const f=fixture(t);const task=f.cmd('queue',{container:f.empty.id,destination:f.yard.id,position:{x:7000,y:4000,rotation:0,support:f.b.id}});
  if(change==='moved'){const b=f.sim.repo.get(f.b.id);b.x=12000;b.y=9000;f.sim.repo.save(b);}else{const y=f.sim.repo.get(f.yard.id);y.height=1500;f.sim.repo.save(y);}
  f.tick(10);const s=f.sim.repo.get(task.id);assert.equal(s.state,'BLOCKED');assert.ok(!s.picked);assert.match(s.reason,change==='moved'?/was to go on \(B\) is no longer under that spot/:/stack exceeds the configured height/);f.cmd('cancel',{id:task.id});assert.equal(f.sim.repo.get(f.empty.id).x,10000);}});

test('a waiting turn of a stillage the boundary save moves stops instead of carrying it back across the yard',t=>{const f=fixture(t);const w=f.container('W',500,6000);f.cmd('pause',{paused:true});
 const r=f.cmd('rotate',{container:w.id,rotation:90});const cut={id:f.yard.id,points:[{x:800,y:0},{x:20000,y:0},{x:20000,y:16000},{x:800,y:16000}]};
 const q=f.sim.boundaryPreview(cut);assert.equal(q.ok,true,q.message);assert.deepEqual(q.halted.map(h=>[h.name,h.turn,h.why]),[['W',true,'moved']]);
 const s=f.cmd('yard',cut);assert.match(s.message,/Moved 1 stillage\(s\) inside the new boundary: W/);const task=f.sim.repo.get(r.tasks[0].id);assert.equal(task.state,'BLOCKED');assert.match(task.reason,/W was moved by the yard change\. Cancel this turn, then turn W again\./);
 const at=f.sim.repo.get(w.id);f.cmd('pause',{paused:false});f.tick(20);assert.deepEqual([f.sim.repo.get(w.id).x,f.sim.repo.get(w.id).y,f.sim.repo.get(w.id).rotation??0],[at.x,at.y,0]);f.cmd('cancel',{id:task.id});assert.equal(f.sim.turnPreview({container:w.id}).ok,true);});

test('a save that only adds a corner in the middle of a straight side keeps that corner; one without corners keeps the stored ones',t=>{const f=fixture(t);const y=f.sim.repo.get(f.yard.id);
 const split=[{x:0,y:0},{x:10000,y:0},{x:20000,y:0},{x:20000,y:16000},{x:0,y:16000}];assert.equal(f.sim.boundaryPreview({id:y.id,points:split}).points.length,5);const r=f.cmd('yard',{id:y.id,points:split});assert.equal(r.message,'Saved.');assert.equal(f.sim.repo.get(y.id).points.length,5);
 f.cmd('yard',{id:y.id,name:'Renamed'});assert.equal(f.sim.repo.get(y.id).points.length,5);f.cmd('yard',{id:y.id,points:rectPts(20000,16000)});assert.equal(f.sim.repo.get(y.id).points.length,4);});

test('the save message says why each stillage moved: height, loading zone, fixture or boundary',t=>{const f=fixture(t);const u=f.container('U',7000,4000,{support:f.b.id});
 const h=f.cmd('yard',{id:f.yard.id,height:1500});assert.equal(h.message,'Saved. Set down 1 stillage(s) to fit the new 1.5 m height: U.');assert.doesNotMatch(h.message,/boundary/);
 const pts=f.sim.repo.get(f.yard.id).points;const l=f.cmd('yard',{id:f.yard.id,points:pts,loading:{x:3500,y:3500}});assert.match(l.message,/^Saved\. Moved 1 stillage\(s\) off the loading zone: A\./);
 const x=f.cmd('fixtures',{id:f.yard.id,fixtures:[{kind:'OFFICE',x:10000,y:3000,w:2000,h:2000}]});assert.match(x.message,/^Saved\. Moved 1 stillage\(s\) clear of the fixtures: Empty\./);
 const o=f.cmd('yard',{id:f.yard.id,points:rectPts(6000,16000),fixtures:[]});assert.match(o.message,/Moved \d+ stillage\(s\) inside the new boundary/);assert.ok(u);});

test('a height-only save leaves a shared legacy gate alone; the first shape change moves it next to the loading zone',t=>{const f=fixture(t);const y=f.sim.repo.get(f.yard.id);y.gate={...y.loading};f.sim.repo.save(y);
 const h=f.cmd('yard',{id:f.yard.id,height:9000});assert.equal(h.message,'Saved.');assert.deepEqual(h.gate,y.loading);
 const r=f.cmd('yard',{id:f.yard.id,points:rectPts(21000,16000)});assert.deepEqual(r.gate,{x:y.loading.x+2500,y:y.loading.y});assert.match(r.message,/Gate moved to 3.5 m, 1.0 m/);});

test('a dropped gate that no longer fits goes to the nearest clear spot, not the far corner',t=>{const f=fixture(t);const r=f.cmd('yard',{id:f.yard.id,points:rectPts(20000,16000),gate:{x:18800,y:14000}});assert.deepEqual(r.gate,{x:17800,y:14000});
 const s=f.cmd('yard',{id:f.yard.id,points:rectPts(20000,15000)});assert.deepEqual(s.gate,{x:17800,y:13500});assert.match(s.message,/Gate moved to 17.8 m, 13.5 m/);});

test('an unmoved corner in the middle of a side is not a shape change; slanted sides are reported',t=>{const f=fixture(t);const y=f.sim.repo.get(f.yard.id);const w=f.sim.repo.all('resource').find(r=>r.type==='WORKER'&&r.location===f.yard.id);f.cmd('workerCommand',{id:w.id,order:'MOVE',x:15000,y:12000});
 const split=splitSide(normalise(y.points),0);assert.equal(sameGround(split,y.points),true);const q=f.sim.boundaryPreview({id:y.id,points:split});assert.equal(q.unchanged,true);f.cmd('yard',{id:y.id,points:split});assert.ok(f.sim.repo.get(w.id).walk,'still walking');
 const owner=[{x:0,y:0},{x:35000,y:0},{x:35000,y:16000},{x:5000,y:16000}];assert.deepEqual(slantedSides(normalise(owner)).map(s=>[s.i,Math.round(s.length)]),[[3,16763]]);assert.equal(sides(normalise(owner))[3].arrow,null);
 assert.deepEqual(freeZone(rectPts(20000,16000),[{x:1000,y:1000,w:2000,h:1500}],[{x:3500,y:1000}]),{x:3500,y:1000});});

test('pile turn steps carry clear titles and a cancelled pile turn says where the set-down stillage stays',t=>{const f=fixture(t);const u=f.container('U',4000,4000,{support:f.a.id});const r=f.cmd('rotate',{container:f.a.id,rotation:90});
 const titles=f.sim.snapshot().tasks.filter(t=>t.layout===r.layout.id).map(t=>[t.title,t.priority,t.skill]);assert.deepEqual(titles,[['Set U down for a pile turn (step 1)',7,'YARD'],['Pile turn step 2 – A',7,'YARD'],['Pile turn step 3 – U',7,'YARD']]);
 for(let i=0;i<60&&f.sim.repo.get(r.tasks[0].id).state!=='COMPLETE';i++)f.tick(1);const c=f.cmd('cancelLayout',{id:r.layout.id});assert.match(c.message,/U stays set down at/);assert.equal(f.total(),200);assert.ok(u);});

test('the editor instant check (shape.affected on the preview stock list) matches the server for outside, loading, fixture and height',async t=>{const {affected}=await import('../public/shape.js');const f=fixture(t);f.container('U',7000,4000,{support:f.b.id});const tall=f.container('T',14000,9000,{height:3000});f.container('T2',14000,9000,{support:tall.id,height:3000});const y=f.sim.repo.get(f.yard.id);
 const cases=[{points:rectPts(9000,16000)},{points:y.points,loading:{x:3500,y:3500}},{points:y.points,fixtures:[{kind:'OFFICE',x:9000,y:3000,w:3000,h:2000}]},{points:y.points,height:5000}];
 for(const c of cases){const q=f.sim.boundaryPreview({id:y.id,...c});assert.equal(q.ok,true,q.message);const local=affected(c.points,q.stock,c.loading??y.loading,c.fixtures??y.fixtures,c.height??y.height);assert.deepEqual([...local].sort(),q.affected.map(a=>[a.id,a.why]).sort());}});
