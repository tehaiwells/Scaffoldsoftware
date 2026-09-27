import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase,atomic,cached,savepoint } from '../src/database.js';
import { Service } from '../src/service.js';
import { Simulation,startScheduler,tickCompany } from '../src/simulation.js';
import { setLiveOverlay,flushLive,liveStats,holdLive,LIVE_FLUSH_MS } from '../src/domain/live.js';

// Live movement overlay (src/domain/live.js): walking workers, manual forklift drives and forklift-move countdowns are held in memory
// between row writes. Every check below runs the same yard twice, tick by tick: A with the overlay, B with it switched off (every
// position written each tick, the behaviour before), and compares what a snapshot shows.
function build(t,{jobs=false}={}){
  const db=openDatabase(':memory:');t.after(()=>db.close());const auth=new Service(db);
  const user=auth.authenticate(auth.register({name:'Owner',companyName:'Demo',email:randomUUID()+'@example.com',password:'demonstration-password',systems:['quickstage']}));
  const sim=new Simulation(db,user),cmd=(action,input={})=>sim.execute(action,input,randomUUID());
  const yard=cmd('yard',{name:'Yard',segments:[{direction:'RIGHT',length:30000},{direction:'DOWN',length:20000},{direction:'LEFT',length:30000}],closed:true});
  const products=cmd('seed');cmd('resources',{location:yard.id,workers:6,machines:3,stepMs:700,speed:4000,jobs,routineJobs:jobs});
  const box=(name,x,y)=>cmd('container',{name,location:yard.id,type:'STILLAGE',length:2000,width:1000,height:1000,tare:50000,x,y});
  // A wall of stillages down the middle (gap at the bottom): walks across it detour through many waypoints.
  for(let i=0;i<9;i++)box('Wall '+(i+1),14000,1000+i*1500);
  const load=box('Load',4000,16000);cmd('opening',{container:load.id,product:products[0].id,quantity:40,reason:'DEMO ONLY opening'});
  for(const [i,[x,y]] of [[3000,4000],[6000,9000],[22000,5000]].entries()){const c=box('Stock '+(i+1),x,y);cmd('opening',{container:c.id,product:products[i%products.length].id,quantity:5+i,reason:'DEMO ONLY opening'});}
  const byName=name=>sim.repo.all('resource').find(r=>r.enabled&&r.name===name);
  const tick=(n=1)=>{for(let i=0;i<n;i++)atomic(db,()=>sim.tick(250));};
  tick();// parking spots and standing places
  return {db,user,sim,cmd,yard,load,byName,tick,raw:id=>{const r=cached(db,'SELECT data,version FROM objects WHERE id=?').get(id);return {...JSON.parse(r.data),version:r.version};}};
}
// The same step on both yards: A with the overlay on, B with it off (the reference).
const both=(A,B,fn)=>{setLiveOverlay(true);const a=fn(A);setLiveOverlay(false);let b;try{b=fn(B);}finally{setLiveOverlay(true);}return [a,b];};
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,ISO=/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g;
// Ids become names (they differ between the two databases), times become 'T'; versions are left out (fewer writes = fewer bumps, by design).
function names(f){const m=new Map([[f.user.id,'owner'],[f.yard.id,'yard']]);for(const k of ['resource','container'])for(const o of f.sim.repo.all(k))m.set(o.id,o.name);for(const o of f.sim.repo.all('job'))m.set(o.id,'job:'+o.title);for(const o of f.sim.tasks())m.set(o.id,'task:'+m.get(o.container));return m;}
const norm=(f,value)=>{const m=names(f);return JSON.parse(JSON.stringify(value,(k,v)=>k==='version'||k==='key'?undefined:v).replace(UUID,id=>m.get(id)??'id').replace(ISO,'T'));};
function view(f){
  const s=f.sim.snapshot(0,{lean:true});
  return norm(f,{resources:s.resources.map(r=>({name:r.name,x:r.x,y:r.y,walk:r.walk??null,drive:r.drive??null,mode:r.workerMode??null,reason:r.workerReason??r.manualReason??null,job:r.job??null,task:r.task??null,mountedOn:r.mountedOn??null,mountTarget:r.mountTarget??null,driver:r.driver??null,claimedBy:r.claimedBy??null,cargo:r.cargo??null,board:r.board?.now??null})),
    tasks:s.tasks.map(t=>({container:t.container,state:t.state,due:t.due,picked:!!t.picked,reason:t.reason??null,machine:t.machine??null})),containers:s.containers.map(c=>({name:c.name,x:c.x,y:c.y,location:c.location})),
    jobs:(s.jobs??[]).map(j=>({title:j.title,state:j.state,worker:j.worker,progress:j.progress})),ledger:f.sim.repo.history(200).map(l=>[l.event,l.product_id,l.container_id,l.quantity,l.source,l.destination])});
}
const same=(A,B,label)=>assert.deepEqual(view(A),view(B),label);
const tickBoth=(A,B,n,label)=>{for(let i=0;i<n;i++){both(A,B,f=>f.tick());same(A,B,label+' tick '+(i+1));}};

test('live overlay: walks, a mount, a manual drive and a forklift move match the write-every-tick reference tick by tick',t=>{
  const A=build(t),B=build(t);same(A,B,'start');
  both(A,B,f=>{f.cmd('workerCommand',{id:f.byName('Worker 1').id,order:'MOVE',x:25000,y:3000});f.cmd('workerCommand',{id:f.byName('Worker 2').id,order:'MOVE',x:24000,y:12000,resume:true});f.cmd('workerCommand',{id:f.byName('Worker 3').id,order:'MOUNT',forklift:f.byName('Forklift 3').id});f.cmd('queue',{container:f.load.id,destination:f.yard.id,position:{x:9000,y:17000,rotation:0,support:null}});});
  same(A,B,'after the orders');
  const w1=A.byName('Worker 1');assert.ok(w1.walk.path.length>4,'Worker 1 detours round the wall ('+w1.walk.path.length+' points)');
  tickBoth(A,B,6,'walking');
  const live=A.byName('Worker 1'),stored=A.raw(live.id);assert.ok(live.x!==stored.x||live.y!==stored.y,'the overlay is in use: the row lags the live position');assert.equal(stored.version,live.version);
  // Commands mid-walk: HOLD stops where the worker is now; a new MOVE (resume) starts from there; AUTO ends a plain walk.
  const [ha,hb]=both(A,B,f=>f.cmd('workerCommand',{id:f.byName('Worker 1').id,order:'HOLD'}));assert.deepEqual([ha.x,ha.y,ha.workerMode,ha.walk],[hb.x,hb.y,hb.workerMode,hb.walk]);assert.deepEqual(A.raw(ha.id).x,ha.x,'the command wrote the live position');
  tickBoth(A,B,3,'holding');
  both(A,B,f=>f.cmd('workerCommand',{id:f.byName('Worker 1').id,order:'MOVE',x:26000,y:17000,resume:true}));tickBoth(A,B,5,'moving again');
  const [aa,ab]=both(A,B,f=>f.cmd('workerCommand',{id:f.byName('Worker 1').id,order:'AUTO'}));assert.deepEqual(norm(A,{...aa,version:0}),norm(B,{...ab,version:0}));
  both(A,B,f=>f.cmd('workerCommand',{id:f.byName('Worker 1').id,order:'MOVE',x:2000,y:2000}));
  // Until Worker 3 is mounted, then drive by hand, stop mid-drive, drive again, and get off when it has stopped.
  let n=0;while(!A.byName('Worker 3').mountedOn&&n++<200){both(A,B,f=>f.tick());same(A,B,'to the forklift '+n);}assert.ok(A.byName('Worker 3').mountedOn,'Worker 3 mounted');
  both(A,B,f=>f.cmd('workerCommand',{id:f.byName('Worker 3').id,order:'MOVE',x:2000,y:1000}));tickBoth(A,B,5,'driving');
  const d=A.byName('Forklift 3'),dr=A.raw(d.id);assert.ok(d.drive&&(d.x!==dr.x||d.drive.next!==dr.drive.next),'the drive is held in memory');
  const [sa,sb]=both(A,B,f=>f.cmd('workerCommand',{id:f.byName('Worker 3').id,order:'STOP'}));assert.deepEqual([sa.x,sa.y,sa.drive],[sb.x,sb.y,sb.drive]);tickBoth(A,B,2,'stopped');
  both(A,B,f=>f.cmd('workerCommand',{id:f.byName('Worker 3').id,order:'MOVE',x:2000,y:1000}));n=0;while(A.byName('Forklift 3').drive&&n++<300){both(A,B,f=>f.tick());same(A,B,'drive '+n);}
  const [da,db]=both(A,B,f=>f.cmd('workerCommand',{id:f.byName('Worker 3').id,order:'DISMOUNT',resume:true}));assert.deepEqual([da.x,da.y,da.workerMode],[db.x,db.y,db.workerMode]);
  tickBoth(A,B,120,'to the end');
  assert.equal(A.sim.tasks()[0].state,'COMPLETE','the forklift move finished');assert.equal(A.sim.repo.get(A.load.id).x,9000);
});

test('live overlay: automatic yard jobs, reassigning and taking a worker off a job mid-walk match the reference',t=>{
  const A=build(t,{jobs:true}),B=build(t,{jobs:true});same(A,B,'start');
  let walking=0;for(let i=0;i<40;i++){both(A,B,f=>f.tick());same(A,B,'auto tick '+i);walking+=A.sim.repo.all('resource').filter(r=>r.walk).length;}
  assert.ok(walking>20,'workers walked to jobs ('+walking+' walking ticks)');
  const walker=()=>A.sim.repo.all('resource').find(r=>r.walk?.job&&r.type==='WORKER')?.name;
  for(let i=0;i<40&&!walker();i++)both(A,B,f=>f.tick());const name=walker();assert.ok(name,'someone is walking to a job');
  // Reassign the walking worker to a new manual job at the gate, then take them off it, then put them on the next job.
  both(A,B,f=>f.cmd('createJob',{yard:f.yard.id,category:'YARD',title:'Sweep the gate',seconds:5,where:{kind:'gate'},worker:f.byName(name).id}));same(A,B,'reassigned');tickBoth(A,B,6,'after reassign');
  const job=A.sim.repo.all('job').find(j=>j.title==='Sweep the gate'),jb=B.sim.repo.all('job').find(j=>j.title==='Sweep the gate');
  if(['ASSIGNED','IN_PROGRESS'].includes(job.state)){setLiveOverlay(true);A.cmd('takeOffJob',{id:job.id});setLiveOverlay(false);try{B.cmd('takeOffJob',{id:jb.id});}finally{setLiveOverlay(true);}same(A,B,'taken off');}
  tickBoth(A,B,4,'after take off');both(A,B,f=>f.cmd('nextJob',{id:f.byName(name).id}));same(A,B,'next job');
  tickBoth(A,B,60,'auto');
});

test('live overlay: a rolled-back tick puts the held positions back, exactly as a rolled-back write did',t=>{
  const A=build(t),B=build(t);
  both(A,B,f=>f.cmd('workerCommand',{id:f.byName('Worker 1').id,order:'MOVE',x:25000,y:3000}));tickBoth(A,B,3,'walking');
  both(A,B,f=>{assert.throws(()=>atomic(f.db,()=>{f.sim.tick(250);throw new Error('boom');}),/boom/);});same(A,B,'after the rollback');
  const before=A.byName('Worker 1');tickBoth(A,B,2,'after the rollback');assert.notDeepEqual([A.byName('Worker 1').x,A.byName('Worker 1').y],[before.x,before.y],'and the walk carries on');
});

test('live overlay: rows lag at most LIVE_FLUSH_MS, walk.path is not re-serialised, and stop() writes everything held',t=>{
  const A=build(t),id=A.byName('Worker 1').id;A.cmd('workerCommand',{id,order:'MOVE',x:25000,y:3000});
  const start=A.raw(id),history=[];let fullRows=0;const path=JSON.stringify(start.walk.path);
  for(let i=0;i<21&&A.byName('Worker 1').walk;i++){A.tick();const live=A.byName('Worker 1'),row=A.raw(id);history.push([live.x,live.y,live.walk?.next]);
    if(row.walk)assert.equal(JSON.stringify(row.walk.path),path,'the stored path is never rewritten');
    // A restart would resume from the row: a position the worker really had within the last LIVE_FLUSH_MS.
    const back=history.slice(-(LIVE_FLUSH_MS/250)-1).map(p=>JSON.stringify(p));assert.ok(back.includes(JSON.stringify([row.x,row.y,row.walk?.next]))||row.version===start.version&&i<LIVE_FLUSH_MS/250,'row within '+LIVE_FLUSH_MS+' ms at tick '+i);
    fullRows=row.version-start.version;}
  assert.ok(fullRows<=Math.ceil(21*250/LIVE_FLUSH_MS),'a handful of writes instead of one per tick ('+fullRows+')');
  // Graceful stop (SIGINT / SIGHUP go through the scheduler's stop): what is held reaches the row and the snapshot does not move.
  const shown=A.sim.snapshot(0,{lean:true}).resources.find(r=>r.id===id);assert.ok(liveStats(A.db).entries>0);
  const stop=startScheduler(A.db);stop();const row=A.raw(id);assert.deepEqual([row.x,row.y,row.walk?.next],[shown.x,shown.y,shown.walk?.next],'stop wrote the live position');
  assert.equal(liveStats(A.db).entries,0);const again=A.sim.snapshot(0,{lean:true}).resources.find(r=>r.id===id);assert.deepEqual([again.x,again.y],[shown.x,shown.y]);assert.equal(flushLive(A.db),0,'nothing left to write');
});

test('live overlay: a held position is dropped when its row version changes, and a full save keeps the live position',t=>{
  const A=build(t),id=A.byName('Worker 1').id;A.cmd('workerCommand',{id,order:'MOVE',x:25000,y:3000});A.tick(3);
  const live=A.byName('Worker 1'),row=A.raw(id);assert.notDeepEqual([live.x,live.y],[row.x,row.y]);
  // Another writer changed the row (version bump without our fields): the held values no longer apply, readers see the row.
  cached(A.db,'UPDATE objects SET version=version+1 WHERE id=?').run(id);const now=A.byName('Worker 1');assert.deepEqual([now.x,now.y,now.walk.next],[row.x,row.y,row.walk.next]);
  const shown=A.sim.snapshot(0,{lean:true}).resources.find(r=>r.id===id);assert.deepEqual([shown.x,shown.y],[row.x,row.y],'the snapshot shows the row');
  A.tick();assert.ok(liveStats(A.db).entries>=1);const moved=A.byName('Worker 1');assert.ok(Math.hypot(moved.x-row.x,moved.y-row.y)<=350.001,'the walk carries on from the row');
  // A command that saves the worker (skills) writes the live position and bumps the version; the entry retires and nothing jumps.
  A.tick(2);const before=A.byName('Worker 1');A.cmd('workerSkills',{id,skills:{SAFETY:false}});const saved=A.raw(id);assert.deepEqual([saved.x,saved.y,saved.walk.next],[before.x,before.y,before.walk.next]);
  assert.deepEqual([A.byName('Worker 1').x,A.byName('Worker 1').y],[before.x,before.y]);A.tick();assert.ok(A.byName('Worker 1').x!==before.x||A.byName('Worker 1').y!==before.y);
});

test('live overlay: a lean snapshot a second apart shows a second of walking even when nothing reached the row',t=>{
  const A=build(t),B=build(t);both(A,B,f=>f.cmd('workerCommand',{id:f.byName('Worker 2').id,order:'MOVE',x:10000,y:18000}));
  const pos=f=>{const r=f.sim.snapshot(0,{lean:true}).resources.find(r=>r.name==='Worker 2');return [r.x,r.y,r.walk?.next];};
  const first=pos(A);both(A,B,f=>f.tick(4));const [a,b]=[pos(A),pos(B)];assert.deepEqual(a,b,'same as the reference');assert.notDeepEqual(a,first,'it moved');
  const row=A.raw(A.byName('Worker 2').id);assert.notDeepEqual([row.x,row.y],[a[0],a[1]],'while the row still holds an older position');
});

// Review fixes: movement that ends without a full save (the driver of a STOPped drive) reaches its row on the next tick, pausing writes
// what is held, and a rolled-back savepoint() puts back what holdLive held or wrote inside it.
test('live overlay: a hand drive STOPped before the first flush leaves driver and forklift rows 600/350 apart within two ticks',t=>{
  const A=build(t),B=build(t),owner=f=>({company_id:f.user.company_id,id:f.user.id}),tc=f=>{let mode;atomic(f.db,()=>{mode=tickCompany(f.db,owner(f),250);});return mode;};
  both(A,B,f=>f.cmd('workerCommand',{id:f.byName('Worker 3').id,order:'MOUNT',forklift:f.byName('Forklift 3').id}));
  let n=0;while(!A.byName('Worker 3').mountedOn&&n++<200)both(A,B,tc);assert.ok(A.byName('Worker 3').mountedOn,'Worker 3 mounted');
  both(A,B,f=>f.cmd('workerCommand',{id:f.byName('Worker 3').id,order:'MOVE',x:2000,y:1000}));
  for(let i=0;i<7;i++)both(A,B,tc);// 1.75 s: under LIVE_FLUSH_MS, nothing of the drive written yet
  const w=A.byName('Worker 3'),m=A.byName('Forklift 3');assert.notDeepEqual([A.raw(w.id).x,A.raw(w.id).y],[w.x,w.y],'the driver is held');
  both(A,B,f=>f.cmd('workerCommand',{id:f.byName('Worker 3').id,order:'STOP'}));
  // The first tick after the stop does not hold the driver; the next one (start of tick, 250 ms later) writes it.
  for(let i=0;i<2;i++){const [ma,mb]=both(A,B,tc);assert.deepEqual([ma,mb],['jobs','jobs'],'nothing else moves: the jobs-only tick settles too');}
  for(const f of [A,B]){const dr=f.raw(f.byName('Worker 3').id),fl=f.raw(f.byName('Forklift 3').id);assert.deepEqual([dr.x-fl.x,dr.y-fl.y],[600,350],'driver row beside the forklift row');}
  assert.deepEqual([A.raw(w.id).x,A.raw(w.id).y,A.raw(m.id).x,A.raw(m.id).y],[B.raw(B.byName('Worker 3').id).x,B.raw(B.byName('Worker 3').id).y,B.raw(B.byName('Forklift 3').id).x,B.raw(B.byName('Forklift 3').id).y],'rows as the reference wrote them');
  assert.equal(liveStats(A.db).entries,0,'nothing left held');same(A,B,'after the stop');
});

test('live overlay: pausing writes every held position of the company',t=>{
  const A=build(t),id=A.byName('Worker 1').id;A.cmd('workerCommand',{id,order:'MOVE',x:25000,y:3000});A.tick(3);
  const live=A.byName('Worker 1');assert.notDeepEqual([A.raw(id).x,A.raw(id).y],[live.x,live.y]);
  A.cmd('pause',{paused:true});const row=A.raw(id);assert.deepEqual([row.x,row.y,row.walk.next],[live.x,live.y,live.walk.next]);assert.equal(liveStats(A.db).entries,0);
  A.cmd('pause',{paused:false});A.tick(2);const on=A.byName('Worker 1');assert.ok(on.x!==live.x||on.y!==live.y,'and walks on when resumed');
});

test('live overlay: ROLLBACK TO a savepoint() puts back what holdLive held or wrote inside it; RELEASE keeps it for the transaction',t=>{
  const A=build(t),id=A.byName('Worker 1').id;A.cmd('workerCommand',{id,order:'MOVE',x:25000,y:3000});A.tick(3);
  const repo=A.sim.repo,state=()=>{const l=A.byName('Worker 1'),r=A.raw(id);return {live:[l.x,l.y,l.walk.next,l.version],row:[r.x,r.y,r.walk.next,r.version],entries:liveStats(A.db).entries};};
  const before=state();assert.notDeepEqual(before.live.slice(0,2),before.row.slice(0,2),'held');
  const nudge=ms=>{const w=repo.get(id);w.x+=10;holdLive(repo,w,['x','y','walkNext'],ms);};
  // A flush (acc past LIVE_FLUSH_MS: json_set write, entry retired) inside a savepoint that rolls back: row and entry both come back.
  atomic(A.db,()=>{assert.throws(()=>savepoint(A.db,'sp_test',()=>{nudge(LIVE_FLUSH_MS);assert.equal(A.raw(id).version,before.row[3]+1);throw new Error('step failed');}),/step failed/);});
  assert.deepEqual(state(),before,'flush rolled back to the savepoint');
  atomic(A.db,()=>{assert.throws(()=>savepoint(A.db,'sp_test',()=>{nudge(0);throw new Error('step failed');}),/step failed/);});
  assert.deepEqual(state(),before,'held change rolled back to the savepoint');
  // Released inside a transaction that then rolls back: back to before as well.
  assert.throws(()=>atomic(A.db,()=>{savepoint(A.db,'sp_test',()=>nudge(LIVE_FLUSH_MS));savepoint(A.db,'sp_two',()=>nudge(0));throw new Error('tick failed');}),/tick failed/);
  assert.deepEqual(state(),before,'released savepoints undone by the outer rollback');
  // Released and committed: the flush stands and the second hold is held over it.
  atomic(A.db,()=>{savepoint(A.db,'sp_test',()=>nudge(LIVE_FLUSH_MS));savepoint(A.db,'sp_two',()=>nudge(0));});
  const after=state();assert.deepEqual(after.row,[before.live[0]+10,before.live[1],before.live[2],before.row[3]+1]);assert.deepEqual(after.live,[before.live[0]+20,before.live[1],before.live[2],before.row[3]+1]);
});
