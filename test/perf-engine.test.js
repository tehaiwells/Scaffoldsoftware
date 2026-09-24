import test from 'node:test';
import assert from 'node:assert/strict';
import { atomic } from '../src/database.js';
import { route,carryRoute,ObstacleIndex,anyOverlap,overlap,fitsPolygon } from '../src/domain/geometry.js';
import { fixture } from './simulation.test.js';
import { flushJobTimers } from '../src/domain/jobs.js';

// The breadth-first search route() used before A*: the reference for step counts, reachability and path length.
function bfsRoute(start,end,shape,poly,obstacles,step=500){
  const valid=(x,y)=>{const r={x,y,w:shape.w,h:shape.h};return fitsPolygon(r,poly)&&!obstacles.some(o=>overlap(r,o));};
  const edge=(a,b)=>{const n=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)/100));for(let i=0;i<=n;i++)if(!valid(a.x+(b.x-a.x)*i/n,a.y+(b.y-a.y)*i/n))return false;return true;};
  if(!valid(start.x,start.y)||!valid(end.x,end.y))return null;if(edge(start,end))return [start,end];
  const queue=[start],seen=new Map([[`${start.x},${start.y}`,null]]);let goal=null;
  for(let head=0;head<queue.length&&head<20000;head++){const p=queue[head];if(Math.hypot(p.x-end.x,p.y-end.y)<=step*1.5&&edge(p,end)){goal=p;break;}for(const [dx,dy] of [[step,0],[-step,0],[0,step],[0,-step]]){const next={x:p.x+dx,y:p.y+dy},key=`${next.x},${next.y}`;if(!seen.has(key)&&edge(p,next)){seen.set(key,p);queue.push(next);}}}
  if(!goal)return null;const points=[end];for(let p=goal;p;p=seen.get(`${p.x},${p.y}`))points.push(p);return points.reverse();
}
const length=p=>p.slice(1).reduce((s,q,i)=>s+Math.hypot(q.x-p[i].x,q.y-p[i].y),0);
const rng=seed=>()=>{seed=(seed*1103515245+12345)%2147483648;return seed/2147483648;};
const tick=(f,ms)=>atomic(f.db,()=>f.sim.tick(ms));

test('the obstacle index answers exactly like scanning every obstacle, including odd and oversized rectangles',()=>{
  const rnd=rng(11),list=[];for(let i=0;i<300;i++)list.push({x:Math.floor(rnd()*60000)-5000,y:Math.floor(rnd()*40000)-5000,w:Math.floor(rnd()*4000)-500,h:Math.floor(rnd()*3000)-500});
  list.push({x:0,y:0,w:Infinity,h:10},{x:5,y:NaN,w:10,h:10},{x:-1e9,y:-1e9,w:2e9,h:1},{x:100,y:100,w:undefined,h:5});
  const index=new ObstacleIndex(list);
  for(let i=0;i<5000;i++){const r={x:Math.floor(rnd()*70000)-8000,y:Math.floor(rnd()*50000)-8000,w:i%97===0?-800:Math.floor(rnd()*3000),h:Math.floor(rnd()*3000)};assert.equal(index.hits(r),list.some(o=>overlap(r,o)));assert.equal(anyOverlap(r,index),anyOverlap(r,list));}
  assert.equal(index.hits({x:NaN,y:0,w:1,h:1}),false);assert.equal(index.hits({x:0,y:0,w:1e12,h:5}),list.some(o=>overlap({x:0,y:0,w:1e12,h:5},o)));
});

test('A* routes are never longer than the old breadth-first routes, reach the same targets and keep every leg clear',()=>{
  const rnd=rng(5);let compared=0,multi=0;
  for(let n=0;n<120;n++){
    const W=10000+Math.floor(rnd()*20)*1000,H=8000+Math.floor(rnd()*12)*1000;
    const poly=n%3===0?[{x:0,y:0},{x:W,y:0},{x:W,y:H/2},{x:W/2,y:H/2},{x:W/2,y:H},{x:0,y:H}]:[{x:0,y:0},{x:W,y:0},{x:W,y:H},{x:0,y:H}];
    const obstacles=[];for(let i=0,k=Math.floor(rnd()*W*H/8e6);i<k;i++){const r=rnd()<0.5;obstacles.push({x:Math.floor(rnd()*W),y:Math.floor(rnd()*H),w:r?1000:2000,h:r?2000:1000});}
    if(n%4===0)obstacles.push({x:Math.floor(W/2),y:-1000,w:600,h:Math.floor(H*0.8)});
    const shape=n%5===0?{w:1500,h:1000}:{w:500,h:500},pt=()=>({x:Math.round(rnd()*(W-shape.w)*10)/10,y:Math.round(rnd()*(H-shape.h)*10)/10});
    const start=pt(),end=n%2?pt():{x:Math.round(rnd()*(W-shape.w)),y:Math.round(rnd()*(H-shape.h))};
    const old=bfsRoute(start,end,shape,poly,obstacles),path=route(start,end,shape,poly,obstacles),viaIndex=route(start,end,shape,poly,new ObstacleIndex(obstacles));
    assert.deepEqual(viaIndex,path,'an index and the plain list route the same');assert.equal(!!path,!!old,'same reachability');if(!old)continue;compared++;if(old.length>2)multi++;
    assert.deepEqual(path[0],start);assert.deepEqual(path.at(-1),end);assert.equal(path.length,old.length,'same number of grid steps');assert.ok(length(path)<=length(old)+1e-6,'never longer');
    const clear=(x,y)=>{const r={x,y,...shape};return fitsPolygon(r,poly)&&!obstacles.some(o=>overlap(r,o));};
    for(let i=1;i<path.length;i++){const a=path[i-1],b=path[i],k=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)/100));for(let j=0;j<=k;j++)assert.ok(clear(a.x+(b.x-a.x)*j/k,a.y+(b.y-a.y)*j/k),'every swept sample is clear');}
  }
  assert.ok(compared>40&&multi>20,'the sample exercises real detours ('+compared+' found, '+multi+' with turns)');
  const poly=[{x:0,y:0},{x:20000,y:0},{x:20000,y:10000},{x:0,y:10000}],wall=[{x:9000,y:-10,w:1000,h:10020}];
  assert.equal(route({x:1000,y:1000},{x:15000,y:1000},{w:500,h:500},poly,wall),null,'a walled-off target is unreachable');
  assert.deepEqual(carryRoute({x:1000,y:1000},{x:15000,y:6000},{w:2000,h:1000},poly,[]),carryRoute({x:1000,y:1000},{x:15000,y:6000},{w:2000,h:1000},poly,new ObstacleIndex([])));
});

test('the tick orders movements by the same priority as taskInfo without building titles, and caches kinds only for the sort',t=>{
  const f=fixture(t);const tasks=[f.cmd('queue',{container:f.a.id,destination:f.truck.id}),f.cmd('queue',{container:f.b.id,destination:f.yard.id,position:{x:13000,y:10000,rotation:0}})];
  for(const task of f.sim.tasks())assert.equal(f.sim.taskPriority(task),f.sim.taskInfo(task).priority);
  assert.equal(f.sim.taskPriority(tasks[0]),1);assert.equal(f.sim.taskPriority(tasks[1]),5);
  let gets=0;const get=f.sim.repo.get.bind(f.sim.repo);f.sim.repo.get=(...a)=>{gets++;return get(...a);};
  f.sim.taskKinds=new Map();for(let i=0;i<5;i++)f.sim.taskPriority(tasks[1]);f.sim.taskKinds=null;assert.equal(gets,new Set([tasks[1].from,tasks[1].to]).size,'one lookup per id within a pass');
  f.sim.repo.get=get;tick(f,250);assert.equal(f.sim.taskKinds,null);
});

test('liveJobs reads exactly the live jobs of one yard in row order, and the snapshot job lists are unchanged',t=>{
  const f=fixture(t);f.cmd('jobsMode',{jobs:true,routineJobs:true});f.tick(12);
  const all=f.sim.repo.all('job');assert.ok(all.some(j=>!['OPEN','ASSIGNED','IN_PROGRESS','BLOCKED'].includes(j.state)),'some closed jobs exist');
  assert.deepEqual(f.sim.liveJobs(f.yard.id),all.filter(j=>j.yard===f.yard.id&&['OPEN','ASSIGNED','IN_PROGRESS','BLOCKED'].includes(j.state)));
  assert.deepEqual(f.sim.liveJobs('no-such-yard'),[]);
  const s=f.sim.snapshot(),live=all.filter(j=>['OPEN','ASSIGNED','IN_PROGRESS','BLOCKED'].includes(j.state));
  assert.deepEqual(s.jobs.map(j=>j.id),[...live].sort((a,b)=>a.priority-b.priority||a.createdAt.localeCompare(b.createdAt)).slice(0,200).map(j=>j.id));
  assert.deepEqual(s.recentJobs.map(j=>j.id),all.filter(j=>!['OPEN','ASSIGNED','IN_PROGRESS','BLOCKED'].includes(j.state)&&j.origin!=='ROUTINE'&&j.state!=='EXPIRED').slice(-20).map(j=>j.id));
});

test('a job countdown is written once per counted second, shown exactly in between, and kept by a command that writes the job',t=>{
  const f=fixture(t);f.cmd('jobsMode',{jobs:true,routineJobs:false});
  const w=f.sim.repo.all('resource').find(r=>r.enabled&&r.type==='WORKER'&&r.location===f.yard.id);
  const job=f.cmd('createJob',{yard:f.yard.id,category:'YARD',title:'Sweep the gate',seconds:10,worker:w.id});assert.equal(job.state,'IN_PROGRESS');
  const stored=()=>f.sim.repo.get(job.id),v0=stored().version,shown=()=>f.sim.snapshot().jobs.find(j=>j.id===job.id);
  for(let i=0;i<3;i++)tick(f,250);
  assert.equal(stored().remainingMs,10000,'not written yet');assert.equal(stored().version,v0,'no row write for the countdown');
  assert.equal(f.sim.getJob(job.id).remainingMs,9250,'the engine reads the counted value');assert.equal(shown().progress,Math.round(100*(1-9250/10000)),'the snapshot shows the counted progress');
  tick(f,250);assert.equal(stored().remainingMs,9000,'written after a second of counted time');assert.equal(stored().version,v0+1);
  for(let i=0;i<2;i++)tick(f,250);
  const off=f.cmd('takeOffJob',{id:job.id});assert.equal(off.state,'OPEN');assert.equal(stored().remainingMs,8500,'a command that writes the job keeps the counted time');
  // A value held for an older version is ignored: the stored row wins.
  const again=f.cmd('assignJob',{id:job.id,worker:w.id});assert.equal(again.state,'IN_PROGRESS');tick(f,250);tick(f,250);
  const row=stored();row.title='Sweep the gate again';f.sim.repo.save(row);assert.equal(f.sim.getJob(job.id).remainingMs,8500);
  // 1000 ms ticks (tests, catch-up) write every tick as before.
  tick(f,1000);assert.equal(stored().remainingMs,7500);
  for(let i=0;i<8;i++)tick(f,1000);assert.equal(stored().state,'DONE');assert.equal(stored().remainingMs,0);
});

test('a cooldown that ends is written at once, and a failed advance pass keeps no counted time',t=>{
  const f=fixture(t);f.cmd('jobsMode',{jobs:true,routineJobs:false});
  for(const w of f.sim.repo.all('resource').filter(r=>r.enabled&&r.type==='WORKER'))f.cmd('workerCommand',{id:w.id,order:'HOLD'});
  const job=f.cmd('createJob',{yard:f.yard.id,category:'YARD',title:'Tidy straps',seconds:5});const row=f.sim.repo.get(job.id);row.cooldownMs=600;f.sim.repo.save(row);const v=row.version;
  tick(f,250);assert.equal(f.sim.repo.get(job.id).version,v);assert.equal(f.sim.getJob(job.id).cooldownMs,350);
  // A pass that throws after counting this job (a poisoned second row) is rolled back by the phase, and so is the counted time.
  const live=f.sim.liveJobs;f.sim.liveJobs=function(id){return [...live.call(this,id),{get cooldownMs(){throw new Error('boom');}}];};
  const err=console.error;console.error=()=>{};try{tick(f,250);}finally{console.error=err;}delete f.sim.liveJobs;
  assert.equal(f.sim.getJob(job.id).cooldownMs,350,'the rolled-back pass counted nothing');
  tick(f,250);assert.equal(f.sim.getJob(job.id).cooldownMs,100);tick(f,250);assert.equal(f.sim.repo.get(job.id).cooldownMs,0,'written when it reaches zero');assert.equal(f.sim.repo.get(job.id).version,v+1);
});

test('walking workers share one obstacle list per location for a pass, and it is dropped afterwards',t=>{
  const f=fixture(t);f.tick(1);const crew=f.sim.repo.all('resource').filter(r=>r.enabled&&r.type==='WORKER'&&r.location===f.yard.id);assert.ok(crew.every(w=>Number.isFinite(w.x)));
  f.cmd('workerCommand',{id:crew[0].id,order:'MOVE',x:15000,y:12000});f.cmd('workerCommand',{id:crew[1].id,order:'MOVE',x:16000,y:13000});
  let built=0;const occupied=f.sim.occupied;f.sim.occupied=function(...a){built++;return occupied.apply(this,a);};
  atomic(f.db,()=>f.sim.advanceWorkers(250));f.sim.occupied=occupied;
  assert.equal(built,1,'built once for two walkers');assert.equal(f.sim.passObstacles,null);
  assert.ok(f.sim.repo.get(crew[0].id).walk&&f.sim.repo.get(crew[1].id).walk,'both still walking');
});
test('stopping the engine saves held job countdowns, so a restart never shows progress going backwards',t=>{
  const f=fixture(t);f.cmd('jobsMode',{jobs:true,routineJobs:false});
  const w=f.sim.repo.all('resource').find(r=>r.enabled&&r.type==='WORKER'&&r.location===f.yard.id);
  const job=f.cmd('createJob',{yard:f.yard.id,category:'YARD',title:'Sweep the gate',seconds:10,worker:w.id});
  for(let i=0;i<3;i++)tick(f,250);
  const shown=f.sim.snapshot().jobs.find(j=>j.id===job.id).progress;assert.equal(f.sim.repo.get(job.id).remainingMs,10000,'held in memory, not written yet');
  assert.equal(flushJobTimers(f.db),1);const stored=f.sim.repo.get(job.id);assert.equal(stored.remainingMs,9250,'the held countdown is saved');
  assert.equal(f.sim.snapshot().jobs.find(j=>j.id===job.id).progress,shown,'progress unchanged after the save');assert.equal(flushJobTimers(f.db),0,'nothing left to save');
  tick(f,250);assert.equal(f.sim.getJob(job.id).remainingMs,9000,'counting carries on from the saved value');
});
