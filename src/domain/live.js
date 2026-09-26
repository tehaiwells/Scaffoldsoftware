import { AppError } from '../service.js';
import { cached,atomic,onAtomic } from '../database.js';
// Live movement held in memory between row writes: walking workers (x, y, walk.next), manual forklift drives (x, y, drive.next) and their
// driver (x, y), and forklift-move countdowns (task.due). Per connection, keyed by object id and valid only for the stored version it was
// counted from. Repository.decode applies it, so every read (engine ticks, commands, snapshots, exports) sees exactly the live values, and
// any full save writes them and bumps the version, which retires the entry. The engine writes the held fields with json_set (walk.path and
// the rest are not re-serialised, though SQLite still rewrites the row) once LIVE_FLUSH_MS of movement has built up; every state change is
// still a full save; an entry the engine did not hold again on a tick (movement that ended without a full save, e.g. the driver of a
// STOPped drive) is written at the start of the next tick; pausing writes the company's entries; flushLive() runs on stop. A hard crash
// loses at most LIVE_FLUSH_MS of movement. Never used for custody, stock, the ledger or anything a command decides on other than where a
// worker or forklift stands.
export const LIVE_FLUSH_MS=2000;
const maps=new WeakMap(),stacks=new WeakMap();let enabled=true;
// Off: holdLive() is a plain repo.save() (the behaviour before the overlay); used by tests and scripts/movement-writes.js as the reference.
export function setLiveOverlay(on){enabled=!!on;}
const PATHS={x:'$.x',y:'$.y',walkNext:'$.walk.next',driveNext:'$.drive.next',due:'$.due'};
const read=(obj,f)=>f==='walkNext'?obj.walk?.next:f==='driveNext'?obj.drive?.next:obj[f];
const entries=db=>{let m=maps.get(db);if(!m)maps.set(db,m=new Map());return m;};
// Rollback journal: one frame per atomic() transaction and per savepoint() inside it (database.js). The first change to an entry in a
// frame remembers the old one; ROLLBACK puts every frame back, ROLLBACK TO the savepoint's frame, RELEASE hands it to the frame below.
// A raw db.exec('SAVEPOINT ...') is not seen here: holdLive and settleLive must only run inside savepoint() or outside any savepoint.
function put(db,id,e){const m=entries(db),s=stacks.get(db),j=s?.[s.length-1];if(j&&!j.has(id))j.set(id,m.get(id));if(e)m.set(id,e);else m.delete(id);}
const undo=(db,j)=>{const m=entries(db);for(const [id,e] of j)if(e)m.set(id,e);else m.delete(id);};
onAtomic((db,phase)=>{
  let s=stacks.get(db);if(phase==='begin'||phase==='savepoint'){if(!s)stacks.set(db,s=[]);s.push(new Map());return;}
  if(!s)return;const j=s.pop();
  if(phase==='rollback'){undo(db,j);while(s.length)undo(db,s.pop());}
  else if(phase==='rollback-to')undo(db,j);
  else if(phase==='release'&&s.length){const below=s[s.length-1];for(const [id,e] of j)if(!below.has(id))below.set(id,e);}
  if(!s.length||phase==='commit'||phase==='rollback')stacks.delete(db);
});

// Repository.decode: the held values over a freshly decoded row of the same version.
export function applyLive(db,obj){
  const e=maps.get(db)?.get(obj.id);if(!e||e.version!==obj.version)return obj;
  if(e.x!==undefined){obj.x=e.x;obj.y=e.y;}if(e.walkNext!==undefined&&obj.walk)obj.walk.next=e.walkNext;if(e.driveNext!==undefined&&obj.drive)obj.drive.next=e.driveNext;if(e.due!==undefined)obj.due=e.due;
  return obj;
}
// In place of repo.save(obj) when only `fields` changed this tick: held in memory, or written (json_set, version+1) once LIVE_FLUSH_MS of
// held movement has built up. obj.version follows the row either way. `held` marks it as moved on this tick (see settleLive).
export function holdLive(repo,obj,fields,elapsed){
  if(!enabled)return repo.save(obj);
  const db=repo.db,old=maps.get(db)?.get(obj.id),same=old?.version===obj.version,e={company:repo.company,version:obj.version,acc:(same?old.acc:0)+elapsed,held:true,fields:[]};
  for(const f of same?new Set([...old.fields,...fields]):fields){const v=read(obj,f);if(v!==undefined){e[f]=v;e.fields.push(f);}}
  if(!e.fields.length)return repo.save(obj);if(e.acc<LIVE_FLUSH_MS){put(db,obj.id,e);return obj;}
  repo.cache=null;if(!write(db,e,obj.id))throw new AppError(409,'This record changed. Refresh and try again.');
  obj.version++;put(db,obj.id,null);return obj;
}
function write(db,e,id){return cached(db,'UPDATE objects SET data=json_set(data,'+e.fields.map(f=>"'"+PATHS[f]+"',json(?)").join(',')+'),version=version+1 WHERE company_id=? AND id=? AND version=?').run(...e.fields.map(f=>JSON.stringify(e[f])),e.company,id,e.version).changes;}
// Writes every held entry (of one company, or all) back (version-checked: an entry whose row has moved on writes nothing) and forgets them.
// Stop / SIGHUP. Inside a transaction use settleLive(db,company,true) instead.
export function flushLive(db,company){const m=maps.get(db);if(!m?.size)return 0;let n=0;atomic(db,()=>{for(const [id,e] of m)if(company===undefined||e.company===company){n+=write(db,e,id);put(db,id,null);}});return n;}
// Once at the start of each engine tick of `company` (inside its transaction, nothing moved yet): entries whose row changed or is gone are
// forgotten; entries not held again since the previous tick are written and forgotten (their movement ended without a full save, e.g. the
// driver of a drive that was STOPped or blocked), so a row never keeps a stale position once nothing holds it; the rest start the new tick
// unheld. all=true writes every entry of the company (pausing). Returns the rows written.
export function settleLive(db,company,all=false){
  const m=maps.get(db);if(!m?.size)return 0;let n=0;
  for(const [id,e] of [...m])if(e.company===company){
    if(cached(db,'SELECT version FROM objects WHERE company_id=? AND id=?').get(company,id)?.version!==e.version)put(db,id,null);
    else if(all||!e.held){n+=write(db,e,id);put(db,id,null);}
    else put(db,id,{...e,held:false});
  }
  return n;
}
export function liveStats(db){const m=maps.get(db);return {entries:m?.size??0};}
