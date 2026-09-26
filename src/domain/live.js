import { AppError } from '../service.js';
import { cached,atomic,onAtomic } from '../database.js';
// Live movement held in memory between row writes: walking workers (x, y, walk.next), manual forklift drives (x, y, drive.next) and their
// driver (x, y), and forklift-move countdowns (task.due). Per connection, keyed by object id and valid only for the stored version it was
// counted from. Repository.decode applies it, so every read (engine ticks, commands, snapshots, exports) sees exactly the live values, and
// any full save writes them and bumps the version, which retires the entry. The engine writes the held fields with json_set (no rewrite of
// walk.path or anything else) once LIVE_FLUSH_MS of movement has built up; every state change is still a full save; flushLive() runs on
// stop. A hard crash loses at most LIVE_FLUSH_MS of movement. Never used for custody, stock, the ledger or anything a command decides on
// other than where a worker or forklift stands.
export const LIVE_FLUSH_MS=2000;
const maps=new WeakMap(),journals=new WeakMap();let enabled=true;
// Off: holdLive() is a plain repo.save() (the behaviour before the overlay); used by tests and scripts/movement-writes.js as the reference.
export function setLiveOverlay(on){enabled=!!on;}
const PATHS={x:'$.x',y:'$.y',walkNext:'$.walk.next',driveNext:'$.drive.next',due:'$.due'};
const read=(obj,f)=>f==='walkNext'?obj.walk?.next:f==='driveNext'?obj.drive?.next:obj[f];
const entries=db=>{let m=maps.get(db);if(!m)maps.set(db,m=new Map());return m;};
// Inside atomic(): the first change to each entry remembers the old one, so a rolled-back transaction puts it back (see onAtomic below).
function put(db,id,e){const m=entries(db),j=journals.get(db);if(j&&!j.has(id))j.set(id,m.get(id));if(e)m.set(id,e);else m.delete(id);}
onAtomic((db,phase)=>{if(phase==='begin'){journals.set(db,new Map());return;}const j=journals.get(db);journals.delete(db);if(phase==='rollback'&&j){const m=entries(db);for(const [id,e] of j)if(e)m.set(id,e);else m.delete(id);}});

// Repository.decode: the held values over a freshly decoded row of the same version.
export function applyLive(db,obj){
  const e=maps.get(db)?.get(obj.id);if(!e||e.version!==obj.version)return obj;
  if(e.x!==undefined){obj.x=e.x;obj.y=e.y;}if(e.walkNext!==undefined&&obj.walk)obj.walk.next=e.walkNext;if(e.driveNext!==undefined&&obj.drive)obj.drive.next=e.driveNext;if(e.due!==undefined)obj.due=e.due;
  return obj;
}
// In place of repo.save(obj) when only `fields` changed this tick: held in memory, or written (json_set, version+1) once LIVE_FLUSH_MS of
// held movement has built up. obj.version follows the row either way.
export function holdLive(repo,obj,fields,elapsed){
  if(!enabled)return repo.save(obj);
  const db=repo.db,old=maps.get(db)?.get(obj.id),same=old?.version===obj.version,e={company:repo.company,version:obj.version,acc:(same?old.acc:0)+elapsed,fields:[]};
  for(const f of same?new Set([...old.fields,...fields]):fields){const v=read(obj,f);if(v!==undefined){e[f]=v;e.fields.push(f);}}
  if(!e.fields.length)return repo.save(obj);if(e.acc<LIVE_FLUSH_MS){put(db,obj.id,e);return obj;}
  repo.cache=null;if(!write(db,e,obj.id))throw new AppError(409,'This record changed. Refresh and try again.');
  obj.version++;put(db,obj.id,null);return obj;
}
function write(db,e,id){return cached(db,'UPDATE objects SET data=json_set(data,'+e.fields.map(f=>"'"+PATHS[f]+"',json(?)").join(',')+'),version=version+1 WHERE company_id=? AND id=? AND version=?').run(...e.fields.map(f=>JSON.stringify(e[f])),e.company,id,e.version).changes;}
// Writes every held entry back (version-checked: an entry whose row has moved on writes nothing) and forgets them all. Stop / SIGHUP.
export function flushLive(db){const m=maps.get(db);if(!m?.size)return 0;let n=0;atomic(db,()=>{for(const [id,e] of m)n+=write(db,e,id);});m.clear();return n;}
// Start of an engine tick (nothing written yet in its transaction): forget entries of this company whose row changed or is gone.
export function sweepLive(db,company){const m=maps.get(db);if(!m?.size)return;for(const [id,e] of m)if(e.company===company&&cached(db,'SELECT version FROM objects WHERE company_id=? AND id=?').get(company,id)?.version!==e.version)put(db,id,null);}
export function liveStats(db){const m=maps.get(db);return {entries:m?.size??0};}
