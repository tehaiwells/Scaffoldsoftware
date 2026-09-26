import { requireRule } from './geometry.js';
import { cached } from '../database.js';
import { localDay } from './schedule.js';
// Crew phone view (GET /api/crew-day?worker=<id>): what one yard hand has finished today, read from the records the engine already keeps.
// Yard jobs keep their worker, state DONE and completedAt; routine rounds are the same records with origin ROUTINE (counted apart, never listed
// as done work). Forklift moves keep their crew in task.resources; a move's finish time is its last placement in the ledger, and a move of an
// empty stillage (no ledger lines) counts when it was also requested today. "Today" is the server's local calendar day, like the schedule.
const JOBS="SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='job' AND json_extract(data,'$.worker')=? AND json_extract(data,'$.state')='DONE' AND json_extract(data,'$.completedAt')>=? ORDER BY json_extract(data,'$.completedAt')";
const MOVES="SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='task' AND json_extract(data,'$.state')='COMPLETE' AND EXISTS(SELECT 1 FROM json_each(objects.data,'$.resources') r WHERE r.value=?)";
const PLACED="SELECT task_id,MAX(created_at) at FROM ledger WHERE company_id=? AND event IN ('PLACEMENT','TURNED') AND created_at>=? AND task_id IN (SELECT value FROM json_each(?)) GROUP BY task_id";
export const crewMethods={
  crewDay(workerId,now=new Date()){
    requireRule(typeof workerId==='string'&&workerId.length>0&&workerId.length<=100,'Choose a worker.');
    const w=this.repo.get(workerId,'resource');requireRule(w.type==='WORKER','Choose a worker.');
    // The yard office sees every worker; a supervisor only the crew at a site assigned to them (assertSite throws otherwise).
    this.assertSite(w.location);
    const since=new Date(now.getFullYear(),now.getMonth(),now.getDate()).toISOString(),company=this.repo.company;
    const done=cached(this.db,JOBS).all(company,w.id,since).map(row=>this.repo.decode(row));
    const real=done.filter(j=>j.origin!=='ROUTINE'),routine=done.filter(j=>j.origin==='ROUTINE'),ms=j=>Math.max(0,Number(j.durationMs)||0);
    const tasks=cached(this.db,MOVES).all(company,w.id).map(row=>this.repo.decode(row));
    const placed=new Map(tasks.length?cached(this.db,PLACED).all(company,since,JSON.stringify(tasks.map(t=>t.id))).map(r=>[r.task_id,r.at]):[]);
    const moves=[];for(const t of tasks){const at=placed.get(t.id)??null;if(!at&&!(typeof t.createdAt==='string'&&t.createdAt>=since))continue;let title='Forklift move';try{title=this.taskInfo(t).title??title;}catch{}moves.push({id:t.id,title,type:t.type??null,at:at??t.createdAt,exact:!!at});}
    moves.sort((a,b)=>String(a.at).localeCompare(String(b.at)));
    return {worker:w.id,name:w.name,day:localDay(now),since,recorded:true,
      jobs:real.slice(-60).map(j=>({id:j.id,title:j.title,category:j.category,priority:j.priority,origin:j.origin,badge:j.hazard?'HAZARD':j.badge,result:j.result??null,completedAt:j.completedAt,ms:ms(j)})),
      jobsDone:real.length,routine:{count:routine.length,ms:routine.reduce((s,j)=>s+ms(j),0)},moves:moves.slice(-60),movesDone:moves.length,workMs:done.reduce((s,j)=>s+ms(j),0)};
  }
};
