import { requireRule } from './geometry.js';
import { cached } from '../database.js';
import { localDay } from './schedule.js';
// Crew phone view (GET /api/crew-day?worker=<id>): what one yard hand has finished today.
// The engine keeps only the newest 100 closed yard jobs (and 10 routine rounds) per yard, so finished work is tallied as it happens in a small
// 'crewDay' record per worker per day (crewTally, called by jobs.js when a job is DONE and when a started job is taken off the worker). That record
// is never pruned by the engine: it holds the exact counts, the time spent on jobs (finished and interrupted) and the newest 60 finished jobs.
// Jobs finished today before the tally existed still count from the job records. Forklift moves keep their crew in task.resources; a move's finish
// time is its last placement in the ledger, and a move of an empty stillage (no ledger lines) counts when it was also requested today.
// "Today" is the server's local calendar day, like the schedule.
const JOBS="SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='job' AND json_extract(data,'$.worker')=? AND json_extract(data,'$.state')='DONE' AND json_extract(data,'$.completedAt')>=? ORDER BY json_extract(data,'$.completedAt')";
const MOVES="SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='task' AND json_extract(data,'$.state')='COMPLETE' AND EXISTS(SELECT 1 FROM json_each(objects.data,'$.resources') r WHERE r.value=?)";
const PLACED="SELECT task_id,MAX(created_at) at FROM ledger WHERE company_id=? AND event IN ('PLACEMENT','TURNED') AND created_at>=? AND task_id IN (SELECT value FROM json_each(?)) GROUP BY task_id";
const TALLY="SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='crewDay' AND json_extract(data,'$.worker')=? AND json_extract(data,'$.day')=? LIMIT 1";
const OLD_TALLIES="SELECT id FROM objects WHERE company_id=? AND kind='crewDay' AND json_extract(data,'$.worker')=? AND json_extract(data,'$.day')<?";
const KEEP_ITEMS=60,KEEP_DAYS=40;
const ms=j=>Math.max(0,Number(j?.durationMs)||0);
const item=(j,at,spent)=>({id:j.id,title:j.title,category:j.category??null,priority:j.priority??null,origin:j.origin??null,badge:j.hazard?'HAZARD':j.badge??null,result:j.result??null,completedAt:at,ms:spent});
export const crewMethods={
  // One line of a worker's day: a finished job (done=true) or the counted time of a started job that was taken off them (done=false).
  // A tally that cannot be written never stops the job itself (it is only the phone view's day count).
  crewTally(workerId,job,opts={}){try{return this.crewTallyLine(workerId,job,opts);}catch(error){if(!error.status)console.error(JSON.stringify({event:'crew_tally_error',worker:workerId,message:error.message}));return null;}},
  crewTallyLine(workerId,job,{at=new Date().toISOString(),spentMs=0,done=false}={}){
    if(typeof workerId!=='string'||!job)return null;const when=new Date(at);if(Number.isNaN(when.getTime()))return null;
    const day=localDay(when),company=this.repo.company,spent=Math.max(0,Math.round(Number(spentMs)||0));if(!done&&!spent)return null;
    const row=cached(this.db,TALLY).get(company,workerId,day);let t=row?this.repo.decode(row):null;
    if(!t){for(const old of cached(this.db,OLD_TALLIES).all(company,workerId,localDay(new Date(when.getTime()-KEEP_DAYS*86400000))))this.repo.remove(old.id,'crewDay');
      t=this.repo.add('crewDay',{worker:workerId,day,firstAt:at,jobsDone:0,routine:{count:0,ms:0},workMs:0,cutMs:0,items:[],ids:[]});}
    t.workMs=(t.workMs??0)+spent;
    if(!done)t.cutMs=(t.cutMs??0)+spent;
    else if(!(t.ids??[]).includes(job.id)){t.ids=[...(t.ids??[]).slice(-(KEEP_ITEMS*3)),job.id];
      if(job.origin==='ROUTINE')t.routine={count:(t.routine?.count??0)+1,ms:(t.routine?.ms??0)+spent};
      else{t.jobsDone=(t.jobsDone??0)+1;t.items=[...(t.items??[]),item(job,at,spent)].slice(-KEEP_ITEMS);}}
    return this.repo.save(t);
  },
  crewDay(workerId,now=new Date()){
    requireRule(typeof workerId==='string'&&workerId.length>0&&workerId.length<=100,'Choose a worker.');
    const w=this.repo.get(workerId,'resource');requireRule(w.type==='WORKER','Choose a worker.');
    // The yard office sees every worker; a supervisor only the crew at a site assigned to them (assertSite throws otherwise).
    this.assertSite(w.location);
    const since=new Date(now.getFullYear(),now.getMonth(),now.getDate()).toISOString(),company=this.repo.company,day=localDay(now);
    const trow=cached(this.db,TALLY).get(company,w.id,day),tally=trow?this.repo.decode(trow):null;
    // Jobs the tally has not counted (finished before it started, e.g. an upgrade in the middle of the day) come from the job records the yard still keeps.
    const counted=new Set(tally?.ids??[]),done=cached(this.db,JOBS).all(company,w.id,since).map(row=>this.repo.decode(row)).filter(j=>!counted.has(j.id));
    const real=done.filter(j=>j.origin!=='ROUTINE'),routine=done.filter(j=>j.origin==='ROUTINE');
    const tasks=cached(this.db,MOVES).all(company,w.id).map(row=>this.repo.decode(row));
    const placed=new Map(tasks.length?cached(this.db,PLACED).all(company,since,JSON.stringify(tasks.map(t=>t.id))).map(r=>[r.task_id,r.at]):[]);
    const moves=[];for(const t of tasks){const at=placed.get(t.id)??null;if(!at&&!(typeof t.createdAt==='string'&&t.createdAt>=since))continue;let title='Forklift move';try{title=this.taskInfo(t).title??title;}catch{}moves.push({id:t.id,title,type:t.type??null,at:at??t.createdAt,exact:!!at});}
    moves.sort((a,b)=>String(a.at).localeCompare(String(b.at)));
    const jobs=[...real.map(j=>item(j,j.completedAt,ms(j))),...(tally?.items??[])].sort((a,b)=>String(a.completedAt).localeCompare(String(b.completedAt)));
    // the phone view's "Your messages" and the role under the name (src/domain/plan.js, team.js)
    const role=typeof this.roleOf==='function'?this.roleOf(w):null,ops=this.auth.permissions(this.user).includes('operations.manage'),messages=(typeof this.personMessages==='function'?this.personMessages('worker',w.id):[]).filter(m=>{if(ops)return true;try{return !!m.site&&this.repo.get(m.site).supervisor===this.user.id;}catch{return false;}});
    return {worker:w.id,name:w.name,role,roleWords:role?{YARDSMAN:'Yardsman',SCAFFOLDER:'Scaffolder',LEADING_HAND:'Leading hand'}[role]:null,messages,away:w.away?{site:w.location,since:w.away.since}:null,day,since,recorded:true,
      // partial: some of today's jobs came from the kept job records (the yard keeps the newest 100), so earlier ones may be missing.
      partial:done.some(j=>!tally||String(j.completedAt)<String(tally.firstAt)),tallySince:tally?.firstAt??null,
      jobs:jobs.slice(-KEEP_ITEMS),jobsDone:(tally?.jobsDone??0)+real.length,
      routine:{count:(tally?.routine?.count??0)+routine.length,ms:(tally?.routine?.ms??0)+routine.reduce((s,j)=>s+ms(j),0)},
      moves:moves.slice(-KEEP_ITEMS),movesDone:moves.length,workMs:(tally?.workMs??0)+done.reduce((s,j)=>s+ms(j),0),cutMs:tally?.cutMs??0};
  }
};
