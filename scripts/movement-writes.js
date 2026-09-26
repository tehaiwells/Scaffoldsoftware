// Database writes while the yard moves: a busy synthetic yard (8 workers on automatic yard jobs, two forklift moves queued back to back,
// one worker driving a forklift by hand) ticked like the scheduler for a while, with a lean snapshot every second like the browser poll.
// Counts write statements, rows, bound bytes and WAL pages, plus tick and snapshot times. Temporary database only; DEMO data.
//   node scripts/movement-writes.js [--seconds=60] [--warmup=20]      LIVE_OVERLAY=off: every position written each tick (reference)
import { StatementSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statSync,rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { openDatabase,atomic,cached } from '../src/database.js';
import { Service } from '../src/service.js';
import { Simulation,tickCompany } from '../src/simulation.js';
const arg=(name,d)=>Number(process.argv.find(a=>a.startsWith('--'+name+'='))?.split('=')[1]??d);
const SECONDS=arg('seconds',60),WARMUP=arg('warmup',20),TICK=250;
let live=null;try{live=await import('../src/domain/live.js');if(process.env.LIVE_OVERLAY==='off')live.setLiveOverlay(false);}catch{}

// Every INSERT/UPDATE/DELETE statement run (also through RETURNING), with its bound bytes and changed rows, per phase.
const WRITE=/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i;let phase='setup';const stats=new Map();
const bucket=()=>{let s=stats.get(phase);if(!s)stats.set(phase,s={statements:0,rows:0,boundBytes:0,byStatement:new Map()});return s;};
const bytesOf=args=>args.reduce((n,a)=>n+(typeof a==='string'?Buffer.byteLength(a):a==null?0:8),0);
for(const m of ['run','get','all']){const orig=StatementSync.prototype[m];StatementSync.prototype[m]=function(...args){const r=orig.apply(this,args);const sql=this.sourceSQL;if(WRITE.test(sql)){const s=bucket();s.statements++;const rows=m==='run'?r.changes:m==='get'?(r?1:0):r.length;s.rows+=rows;const b=bytesOf(args);s.boundBytes+=b;const k=sql.replace(/\s+/g,' ').slice(0,70);const e=s.byStatement.get(k)??{n:0,bytes:0};e.n++;e.bytes+=b;s.byStatement.set(k,e);}return r;};}

const path=join(tmpdir(),'sy-movement-'+randomUUID()+'.sqlite');
const db=openDatabase(path);db.exec('PRAGMA wal_autocheckpoint=0');
try{
  const auth=new Service(db),user=auth.authenticate(auth.register({name:'Benchmark',companyName:'Movement benchmark (DEMO)',email:randomUUID()+'@example.test',password:'benchmark-password',systems:['quickstage']}));
  const sim=new Simulation(db,user),cmd=(action,input={})=>sim.execute(action,input,randomUUID());
  const yard=cmd('yard',{name:'Yard',segments:[{direction:'RIGHT',length:40000},{direction:'DOWN',length:30000},{direction:'LEFT',length:40000}],closed:true});
  const products=cmd('seed');cmd('resources',{location:yard.id,workers:8,machines:3,stepMs:700,speed:4000,jobs:true});
  const box=(name,x,y)=>cmd('container',{name,location:yard.id,type:'STILLAGE',length:2000,width:1000,height:1000,tare:50000,x,y});
  // Stock on a grid (cycle counts, consolidation and sorting give the crew real walks); two stillages shuttle between far spots.
  let n=0;for(let row=0;row<3;row++)for(let col=0;col<6;col++){const c=box('S'+(++n),6000+col*4500,5000+row*5000);if(n%3)cmd('opening',{container:c.id,product:products[n%products.length].id,quantity:10+n,reason:'DEMO ONLY opening'});}
  const shuttles=[{c:box('Shuttle A',4000,24000),spots:[{x:4000,y:24000},{x:30000,y:24000}],at:0},{c:box('Shuttle B',8000,27000),spots:[{x:8000,y:27000},{x:34000,y:27000}],at:0}];
  const resources=()=>sim.repo.all('resource').filter(r=>r.enabled&&r.location===yard.id);
  const machine=resources().filter(r=>r.type==='FORKLIFT')[2],driver=resources().filter(r=>r.type==='WORKER')[7];
  atomic(db,()=>tickCompany(db,{company_id:user.company_id,id:user.id},TICK));// forklifts get parking spots
  cmd('workerCommand',{id:driver.id,order:'MOUNT',forklift:machine.id});
  const drives=[{x:20000,y:1500},{x:2000,y:1500}];let leg=0;
  const keepBusy=()=>{
    for(const s of shuttles){if(sim.tasks().some(t=>t.container===s.c.id&&!['COMPLETE','CANCELLED','FAILED'].includes(t.state)))continue;s.at=1-s.at;try{cmd('queue',{container:s.c.id,destination:yard.id,position:{...s.spots[s.at],rotation:0,support:null}});}catch{}}
    const w=sim.repo.get(driver.id,'resource');if(w.mountedOn){const m=sim.repo.get(w.mountedOn,'resource');if(!m.drive){try{const p=drives[leg++%2];cmd('workerCommand',{id:w.id,order:'MOVE',x:p.x,y:p.y});}catch{}}}
  };
  const row={company_id:user.company_id,id:user.id},tickMs=[],snapMs=[];let snapBytes=0;
  const run=(seconds,measure)=>{for(let i=0;i<seconds*1000/TICK;i++){
    phase=measure?'tick':'warmup';const t0=performance.now();atomic(db,()=>tickCompany(db,row,TICK));if(measure)tickMs.push(performance.now()-t0);
    phase=measure?'commands':'warmup';keepBusy();
    if(i%4===3){phase=measure?'snapshot':'warmup';const s0=performance.now();const s=sim.snapshot(0,{lean:true});if(measure){snapMs.push(performance.now()-s0);snapBytes+=Buffer.byteLength(JSON.stringify(s));}}
  }};
  run(WARMUP,false);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');const versions=()=>new Map(cached(db,'SELECT kind,SUM(version) v,COUNT(*) n FROM objects WHERE company_id=? GROUP BY kind').all(user.company_id).map(r=>[r.kind,r.v]));const v0=versions();
  let moving=0,walking=0,driving=0,carrying=0;const origTick=Simulation.prototype.tick;Simulation.prototype.tick=function(e){const rs=this.repo.all("resource").filter(r=>r.enabled);walking+=rs.filter(r=>r.walk&&!r.task).length;driving+=rs.filter(r=>r.drive).length;carrying+=this.tasks().filter(t=>t.due>0&&!["COMPLETE","CANCELLED","FAILED","BLOCKED"].includes(t.state)).length;moving+=rs.filter(r=>r.walk||r.drive).length;return origTick.call(this,e);};
  run(SECONDS,true);Simulation.prototype.tick=origTick;
  const v1=versions(),wal=statSync(path+'-wal').size,frames=Math.max(0,(wal-32)/(4096+24));
  const pct=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return +s[Math.min(s.length-1,Math.floor(p*s.length))].toFixed(2);};
  const per=s=>s&&{statementsPerSec:+(s.statements/SECONDS).toFixed(1),rowsPerSec:+(s.rows/SECONDS).toFixed(1),boundKBPerSec:+(s.boundBytes/SECONDS/1024).toFixed(1),top:[...s.byStatement].sort((a,b)=>b[1].bytes-a[1].bytes).slice(0,6).map(([k,e])=>({sql:k,perSec:+(e.n/SECONDS).toFixed(1),KBPerSec:+(e.bytes/SECONDS/1024).toFixed(1)}))};
  const bumps={};for(const [k,v] of v1)bumps[k]=+((v-(v0.get(k)??0))/SECONDS).toFixed(1);
  const liveNow=live?.liveStats?.(db)??null;
  console.log(JSON.stringify({overlay:live?(process.env.LIVE_OVERLAY==='off'?'off':'on'):'absent',seconds:SECONDS,tickMs:TICK,avgPerTick:Object.fromEntries(Object.entries({walkingWorkers:walking,manualDrives:driving,taskCountdowns:carrying}).map(([k,v])=>[k,+(v/(SECONDS*1000/TICK)).toFixed(2)])),
    writes:{tick:per(stats.get('tick')),commands:per(stats.get('commands')),snapshot:per(stats.get('snapshot'))},versionBumpsPerSecByKind:bumps,
    walPagesPerSec:+(frames/SECONDS).toFixed(1),walKBPerSec:+(frames*4096/SECONDS/1024).toFixed(1),
    tick:{meanMs:+(tickMs.reduce((a,b)=>a+b,0)/tickMs.length).toFixed(2),p50Ms:pct(tickMs,.5),p95Ms:pct(tickMs,.95)},
    snapshot:{meanMs:+(snapMs.reduce((a,b)=>a+b,0)/snapMs.length).toFixed(2),p50Ms:pct(snapMs,.5),p95Ms:pct(snapMs,.95),avgKB:+(snapBytes/snapMs.length/1024).toFixed(1)},liveEntries:liveNow},null,1));
}finally{db.close();for(const s of ['','-wal','-shm'])rmSync(path+s,{force:true});}
