// Remove a site, and change your mind: the server side of the board's one "Remove site" button (public/game-finish.js). Installed with the game
// board (game.js installGame); every command needs operations.manage (GAME_OPS), so a supervisor can never remove, keep or re-open a site.
//   gameRemoveSite  one button for every case:
//                   - never used (nothing ever referred to it, no stock history): it goes completely, as if it was never made; its board-made
//                     crane and crew go and its map block is freed. The answer carries what the board needs to put it back (Undo).
//                   - used, but nothing there and nothing on its way: archived at once (off the map and the lists; kept as history under
//                     Removed sites in the Office, with Open again).
//                   - scaffold still there or a truck on its way: only with bringBack:true (the board asks first). The site is marked finishing
//                     and everything is brought back with the board's own multi-truck Bring back; the autopilot (sfTick, after every engine
//                     tick) archives it when the last stillage is home and no truck, task, request, collection or waiting order is left for it.
//                     Stock never teleports; hire stops as stock comes back (hire.js, from the ledger).
//                   Sends still waiting for a truck are dropped. Something that blocks it is refused in the plain words of sfBlock (shared
//                   with the board, which shows them with the one button that fixes it).
//   gameKeepOpen    stop removing: what already came back stays back; a truck still driving out empty turns round when it gets there.
//   gameReopen      a removed (archived) site back on the map in a free block, with its crane and crew (the Office's Open again, and Undo).
import { requireRule } from './geometry.js';
import { AppError } from '../service.js';
import { active } from './inventory.js';
import { cached,savepoint } from '../database.js';
import { RT_EDITABLE } from './collections.js';
import { sfBlock,sfAsk,SF_OPEN_RT } from '../../public/game-finish.js';
export const SF_OPS=['gameRemoveSite','gameKeepOpen','gameReopen'];
const RETRY_MS=4000,CLOSED=['DELIVERED','CANCELLED','RETURNED'];
// A resource doing something (a task, a job, a load on its forks, a walk): its site is in use.
const BUSY=['task','job','cargo','drive','walk','driver','claimedBy','mountedOn'];
export const SF_FINISH_PROBE="SELECT 1 FROM objects WHERE company_id=? AND kind='site' AND json_type(data,'$.finishing')='object' LIMIT 1";
// Anything that names the site (a truck, a trip, a stillage, a movement, a request, a collection, a yard list, a waiting order, a stocktake, a hire
// rate, a layout ...), other than its own crew standing there, another site or a notification.
const USED="SELECT kind FROM objects WHERE company_id=?1 AND id<>?2 AND kind NOT IN ('site','notification') AND instr(data,?2)>0 AND NOT (kind='resource' AND json_extract(data,'$.location')=?2) LIMIT 1";
// Stock history at the site in the ledger (the site's own admin events do not count).
const HISTORY="SELECT event FROM ledger WHERE company_id=?1 AND (source=?2 OR destination=?2) AND (quantity<>0 OR event NOT IN ('COMMAND','SITE_MAP','SITE_DETAILS','SITE_ARCHIVED','SITE_FINISHING','SITE_KEPT_OPEN','SITE_REOPENED')) LIMIT 1";
const logError=(event,fields)=>{try{console.error(JSON.stringify({event,...fields}));}catch{}};
const brief=s=>({id:s.id,name:s.name});
export const siteFinishMethods={
  // What refers to the site (its stock history in the ledger included), or null when it was never used.
  sfUsed(site){const hit=cached(this.db,USED).get(this.repo.company,site.id);if(hit)return hit.kind;
    if(this.repo.all('resource').some(r=>r.location===site.id&&BUSY.some(k=>r[k])))return 'resource';
    if(cached(this.db,HISTORY).get(this.repo.company,site.id))return 'ledger';return null;},
  // What still ties the site to the yard: stock there, a movement, a truck there / on its way / on a board trip for it, a waiting order, an open
  // collection, request or stocktake. Null: nothing, it can be archived.
  sfBusy(site){const id=site.id;
    if(this.containers().some(c=>c.location===id))return 'stock';
    if(this.tasks().some(t=>active(t)&&(t.from===id||t.to===id||t.handling===id)))return 'task';
    if(this.repo.all('truck').some(t=>!t.retired&&(t.game?.site===id||(t.status==='AT_SITE'&&t.at===id)||(t.status==='IN_TRANSIT'&&(t.destination===id||t.at===id||t.route?.from===id)))))return 'truck';
    if(this.repo.all('gameOrder').some(o=>o.site===id))return 'order';
    if(this.repo.all('collection').some(o=>o.site===id&&SF_OPEN_RT.includes(o.status)))return 'collection';
    if(this.repo.all('request').some(r=>r.site===id&&!CLOSED.includes(r.status)))return 'request';
    if(this.repo.all('count').some(c=>c.state==='OPEN'&&c.scope===id))return 'count';
    return null;},
  // The plain-words reason removing cannot start (public/game-finish.js sfBlock, which the board shows with the one button that fixes it).
  sfBlockFor(site){const here=new Set(this.containers().filter(c=>c.location===site.id).map(c=>c.id));
    return sfBlock(site,{counts:this.repo.all('count'),here,requests:this.repo.all('request'),collections:this.repo.all('collection'),trucks:this.repo.all('truck').filter(t=>!t.retired),tasks:this.tasks().filter(active)});},
  sfFinishing(id){try{return !!this.repo.get(id,'site').finishing;}catch{return false;}},
  // Archive (the logistics rule), note when, and send its crew home (switched off, so the crane leaves the map; gameReopen switches them back on).
  sfArchive(site){this.archive({id:site.id});const s=this.repo.get(site.id,'site');s.finishing=null;s.finishedAt=new Date().toISOString();this.repo.save(s);
    for(const r of this.repo.all('resource'))if(r.location===site.id&&r.enabled&&!BUSY.some(k=>r[k])){r.enabled=false;r.finishedOff=true;this.repo.save(r);}
    return s;},
  // While removing: bring everything back when nothing is on its way for it yet (the board's Bring back; a full truck queues the next one itself).
  sfCollect(site){const s=this.repo.get(site.id,'site');if(!s.finishing||!this.containers().some(c=>c.location===s.id))return;
    const going=this.repo.all('truck').some(t=>t.game?.kind==='COLLECT'&&t.game.site===s.id)||this.repo.all('gameOrder').some(o=>o.type==='COLLECT'&&o.site===s.id)||this.repo.all('collection').some(o=>o.site===s.id&&['REQUESTED','BOOKED','LOADING'].includes(o.status));
    if(going)return;
    const note=problem=>{const f=this.repo.get(s.id,'site');if(!f.finishing||(f.finishing.problem??null)===problem)return;f.finishing={...f.finishing,problem,retryAt:problem?Date.now()+RETRY_MS:null};this.repo.save(f);};
    try{savepoint(this.db,'sf_collect',()=>this.gameCollect({site:s.id,all:true}));note(null);}catch(e){if(!e.status)throw e;note(e.message);}},
  // ---------- commands ----------
  gameRemoveSite(input){const site=this.repo.get(input?.site,'site');requireRule(site.status==='ACTIVE',site.name+' is already removed.');
    if(site.finishing)return {removing:true,site:brief(site),message:'Bringing everything back from '+site.name+'.'};
    const block=this.sfBlockFor(site);if(block)throw new AppError(409,block.why);
    // Sends still waiting for a truck no longer go there (inside the command: a refusal below puts them back)
    for(const o of this.repo.all('gameOrder'))if(o.site===site.id&&o.type==='SEND')this.repo.remove(o.id,'gameOrder');
    if(!this.sfUsed(site)){
      // where it was, so Undo can put it back just the same
      let lot=null;try{const p=this.worldLayoutNow().byId.get(site.id);if(p)lot={col:p.col,row:p.row};}catch(e){logError('sf_lot_error',{message:e?.message});}
      // every other site keeps its block (as archive does), then the site, its crew and its notes go
      try{this.worldPin(this.worldLayoutNow(),site.id);}catch(e){if(e instanceof AppError)throw e;logError('sf_pin_error',{message:e?.message});}
      for(const r of this.repo.all('resource'))if(r.location===site.id)this.repo.remove(r.id,'resource');
      for(const n of this.repo.all('notification'))if(n.site===site.id)this.repo.remove(n.id,'notification');
      this.repo.remove(site.id,'site');this.repo.event(this.user.id,'SITE_REMOVED',{reason:'Removed before it was used: '+site.name,key:this.key});
      return {removed:true,site:brief(site),undo:{name:site.name,...(site.address?{address:site.address}:{}),...(lot??{})},message:site.name+' removed'};}
    if(!this.sfBusy(site)){this.sfArchive(site);return {archived:true,site:brief(site),message:site.name+' removed'};}
    // scaffold still there or a truck on its way: the board asks first
    requireRule(input.bringBack===true,sfAsk(site,this.containers().some(c=>c.location===site.id)));
    site.finishing={since:new Date().toISOString(),by:this.user.id,problem:null,retryAt:null};this.repo.save(site);
    this.repo.event(this.user.id,'SITE_FINISHING',{destination:site.id,reason:'Removing '+site.name+': bringing everything back',key:this.key});
    this.sfCollect(site);return {removing:true,site:brief(site),message:'Bringing everything back from '+site.name+'.'};},
  gameKeepOpen(input){const site=this.repo.get(input?.site,'site');requireRule(site.status==='ACTIVE'&&site.finishing,site.name+' is not being removed.');
    site.finishing=null;this.repo.save(site);
    for(const o of this.repo.all('gameOrder'))if(o.site===site.id&&o.type==='COLLECT')this.repo.remove(o.id,'gameOrder');
    // a truck still driving out empty to fetch everything: its collection is cancelled, so it turns round when it gets there (gameStep)
    for(const t of this.repo.all('truck'))if(t.game?.kind==='COLLECT'&&t.game.site===site.id&&t.game.stage==='OUTBOUND'){let o=null;try{o=this.repo.get(t.game.collection,'collection');}catch{}if(o&&RT_EDITABLE.includes(o.status))this.cancelCollection({id:o.id,reason:'The site is kept'});}
    this.repo.event(this.user.id,'SITE_KEPT_OPEN',{destination:site.id,reason:site.name+' kept',key:this.key});
    return {ok:true,site:brief(site),message:site.name+' stays.'};},
  gameReopen(input){const site=this.repo.get(input?.site,'site');requireRule(site.status==='ARCHIVED',site.name+' is already open.');
    // every site keeps its block; this one goes back to its own block when that is still free, else to the first free one
    const l=this.worldLayoutNow();this.worldPin(l);const taken=new Set(l.places.filter(p=>p.id!==site.id).map(p=>p.col+','+p.row));
    const s=this.repo.get(site.id,'site');if(!(s.map&&Number.isInteger(s.map.col)&&Number.isInteger(s.map.row)&&!taken.has(s.map.col+','+s.map.row)))s.map=null;
    Object.assign(s,{status:'ACTIVE',finishing:null,finishedAt:null});this.repo.save(s);
    const p=this.worldLayoutNow().byId.get(s.id);if(p&&(p.auto||!s.map)){const f=this.repo.get(s.id,'site');f.map={col:p.col,row:p.row};this.repo.save(f);}
    for(const r of this.repo.all('resource'))if(r.location===s.id&&r.finishedOff){r.enabled=true;delete r.finishedOff;this.repo.save(r);}
    this.gameCrew(this.repo.get(s.id,'site'));
    this.repo.event(this.user.id,'SITE_REOPENED',{destination:s.id,reason:s.name+' opened again',key:this.key});
    return {ok:true,site:brief(s),message:s.name+' is back on the map.'};},
  // ---------- after every engine tick ----------
  // Sites being removed: archived (with a calm note) when nothing is left; otherwise everything is fetched (again) when nothing is on its way.
  sfTick(){if(!cached(this.db,SF_FINISH_PROBE).get(this.repo.company))return;const now=Date.now();
    for(const s of this.repo.all('site')){if(!s.finishing||s.status!=='ACTIVE')continue;
      try{savepoint(this.db,'sf_tick',()=>{if(!this.sfBusy(s)){const done=this.sfArchive(s);this.notify('Site removed',done.name+' is finished and removed.',done.id);return;}if(s.finishing.retryAt&&now<s.finishing.retryAt)return;this.sfCollect(s);});}
      catch(error){if(!error.status)logError('sf_tick_error',{site:s.id,message:error.message});}}}
};
