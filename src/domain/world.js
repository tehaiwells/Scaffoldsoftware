// Home world map, server side: where every site sits on the map (lots), the road each truck trip takes and how long it drives, and the compact
// world block of the snapshot. The geometry itself is the shared pure module public/world-layout.js, so the browser draws the road it was timed on.
// Installed on Simulation.prototype by installWorld (simulation.js): it wraps dispatch (a trip gets a route and a travel time from its road length),
// archive (the other sites keep their blocks) and buildSnapshot (adds result.world, and the exact countdown of trucks on the road).
import { requireRule,integer } from './geometry.js';
import { AppError } from '../service.js';
import * as database from '../database.js';
import { worldLayout,worldRoute,tripMs,layoutKey,restPoses,destSlot } from '../../public/world-layout.js';
export const WORLD_OPS=['worldPlace'];
// Trip countdowns between writes, per connection, keyed by truck id and only valid for the trip (delivery) they were counted for. A truck on the
// road is written about every 5 s of counted time instead of every tick, and on arrival; the snapshot reads the exact value from here.
const FLUSH_MS=5000,clocks=new WeakMap();
const clockMap=db=>{let m=clocks.get(db);if(!m)clocks.set(db,m=new Map());return m;};
// Writes every held countdown back (only onto the same trip, still on the road) so a stop or restart never shows a truck further back than it was.
export function flushWorldClocks(db){const m=clocks.get(db);if(!m?.size)return 0;let n=0;database.atomic(db,()=>{for(const [id,e] of m)n+=database.cached(db,"UPDATE objects SET data=json_set(data,'$.remainingMs',?),version=version+1 WHERE id=? AND kind='truck' AND json_extract(data,'$.delivery')=? AND json_extract(data,'$.status')='IN_TRANSIT' AND json_extract(data,'$.remainingMs')>?").run(e.remainingMs,id,e.delivery,e.remainingMs).changes;});m.clear();return n;}
const compact=(c,lines)=>({id:c.id,name:c.name,type:c.type,condition:c.condition,location:c.location,x:c.x,y:c.y,rotation:c.rotation??0,support:c.support??null,envelopeLength:c.envelopeLength,envelopeWidth:c.envelopeWidth,height:c.height,lines:lines.map(l=>[l.product_id,l.quantity])});
const logError=(event,fields)=>{try{console.error(JSON.stringify({event,...fields}));}catch{}};
export const worldMethods={
  worldLayoutNow(){const yard=this.repo.all('yard')[0]??null,all=this.repo.all('site');return worldLayout(yard,all.filter(s=>s.status==='ACTIVE'),null,all.filter(s=>s.status!=='ACTIVE'));},
  // A trip's road and time. Called right after logistics dispatch saved the truck IN_TRANSIT (same transaction). A fault in the map geometry never
  // blocks a dispatch: the trip then keeps the old fixed 3 s and no road (the page draws one itself).
  worldDepart(truck){
    const config=this.repo.all('config')[0]??{};let route=null;
    try{
      const l=this.worldLayoutNow(),all=this.repo.all('truck').filter(t=>!t.retired),from=truck.at,to=truck.destination,atRest=id=>all.filter(t=>t.at===id&&['AT_YARD','AT_SITE'].includes(t.status));
      // Where it stands now (its spot among the trucks at rest there, itself included as it was) and the first free spot where it is going.
      const start=restPoses(l,from,all.filter(t=>t.at===from&&(t.id===truck.id||['AT_YARD','AT_SITE'].includes(t.status))).map(t=>t.id===truck.id?{...t,status:'AT_REST'}:t),all).get(truck.id);
      const slot=destSlot(l,to,atRest(to),all.filter(t=>t.id!==truck.id&&t.status==='IN_TRANSIT'&&t.destination===to),all);
      route=worldRoute(l,truck,from,to,{start,k:slot.k,bayFree:slot.bayFree});
    }catch(error){logError('world_route_error',{truck:truck.id,message:error?.message});route=null;}
    const durationMs=route?tripMs(route.length,config):3000;
    truck.remainingMs=durationMs;truck.route=route?{...route,durationMs,delivery:truck.delivery}:{from:truck.at,to:truck.destination,durationMs,delivery:truck.delivery,points:null};
    return this.repo.save(truck);
  },
  // The engine's countdown for a routed truck on the road (movement.js tick). true: counted here, nothing else to do this tick. false: the legacy
  // path runs (an unrouted truck, or this tick ends the trip: remainingMs is set so the legacy code reaches 0 and runs the arrival exactly as before).
  worldClock(truck,elapsed){
    if(!truck.route)return false;const m=clockMap(this.db);let e=m.get(truck.id);if(e&&e.delivery!==truck.delivery){m.delete(truck.id);e=null;}
    const left=Math.min(e?e.remainingMs:Infinity,truck.remainingMs??0)-elapsed;
    if(left<=0){m.delete(truck.id);truck.remainingMs=elapsed;return false;}
    const since=(e?e.since:0)+elapsed;
    if(since>=FLUSH_MS){truck.remainingMs=left;this.repo.save(truck);m.set(truck.id,{delivery:truck.delivery,remainingMs:left,since:0});}
    else m.set(truck.id,{delivery:truck.delivery,remainingMs:left,since});
    return true;
  },
  // Every auto-placed site keeps the block it has now (site.map), so a later archive, move or new site never shuffles the others.
  worldPin(l,except=null){for(const p of l.places)if(p.kind==='site'&&p.auto&&p.id!==except){const s=this.repo.get(p.id,'site');s.map={col:p.col,row:p.row};this.repo.save(s);}},
  // Move a site to another lot on the map. The first manual move pins every auto-placed site where it is, so moving one never shuffles the others.
  worldPlace(input){
    requireRule(input&&typeof input==='object'&&typeof input.id==='string'&&input.id.length>0,'Choose a site to move.');
    const site=this.repo.get(input.id,'site');requireRule(site.status==='ACTIVE','Choose an active site.');
    const col=integer(input.col,'Map column',-20,20),row=integer(input.row,'Map row',-20,20),l=this.worldLayoutNow(),here=l.byId.get(site.id);requireRule(here,'This site is not on the map.');
    if(here.col===col&&here.row===row&&!here.auto)return {ok:true,site:{id:site.id,map:{col,row}},message:site.name+' is already there.'};
    requireRule(!(col===0&&row===0),'That block is the yard. Choose another block.');
    const other=l.places.find(p=>p.id!==site.id&&p.col===col&&p.row===row);requireRule(!other,'That block is taken by '+(other?.name??'another place')+'. Move it first.');
    const driving=this.repo.all('truck').find(t=>!t.retired&&t.status==='IN_TRANSIT'&&(t.destination===site.id||t.route?.from===site.id));requireRule(!driving,'Wait until '+(driving?.name??'the truck')+' has arrived, then move '+site.name+'.');
    this.worldPin(l,site.id);
    site.map={col,row};this.repo.save(site);
    this.repo.event(this.user.id,'SITE_MAP',{destination:site.id,reason:'Moved on the map to block '+col+','+row,key:this.key});
    return {ok:true,site:{id:site.id,map:site.map},message:site.name+' moved on the map. New trips take the new road.'};
  },
  // result.world: the lots every viewer draws (visible places only) and every stillage at a visible site, on a visible truck or hanging from a site
  // crane (unpaged, so the map never misses cargo or site stock that sits on another page of the list). Supervisors get no yard details.
  worldSnapshot(result){
    const l=this.worldLayoutNow(),siteIds=new Set(result.sites.map(s=>s.id)),yard=l.places.find(p=>p.kind==='yard'),seesYard=!!yard&&(result.yards??[]).some(y=>y.id===yard.id);
    const key=layoutKey(l);key.lots=Object.fromEntries(Object.entries(key.lots).filter(([id])=>(seesYard&&id===yard?.id)||siteIds.has(id)));
    const truckIds=new Set(result.trucks.map(t=>t.id)),cranes=new Set(result.resources.filter(r=>r.type==='CRANE'&&siteIds.has(r.location)).map(r=>r.id));
    const items=this.containers().filter(c=>siteIds.has(c.location)||truckIds.has(c.location)||cranes.has(c.location)).map(c=>compact(c,this.repo.lines(c.id)));
    result.world={...key,items};
    const m=clocks.get(this.db);if(m)for(const t of result.trucks){const e=m.get(t.id);if(e&&t.status==='IN_TRANSIT'&&e.delivery===t.delivery)t.remainingMs=Math.min(t.remainingMs??e.remainingMs,e.remainingMs);}
  }
};
export function installWorld(proto){
  const dispatch=proto.dispatch,build=proto.buildSnapshot,archive=proto.archive;if(typeof dispatch!=='function'||typeof build!=='function')throw new AppError(500,'World map needs dispatch and buildSnapshot.');
  Object.assign(proto,worldMethods);
  proto.dispatch=function(input){return this.worldDepart(dispatch.call(this,input));};
  // Archiving a site frees its block: pin the others first so none of them moves (the same transaction, so a refused archive pins nothing).
  if(typeof archive==='function')proto.archive=function(input){try{const l=this.worldLayoutNow();if(l.byId.get(input?.id)?.kind==='site')this.worldPin(l,input.id);}catch(error){if(error instanceof AppError)throw error;logError('world_pin_error',{message:error?.message});}return archive.call(this,input);};
  proto.buildSnapshot=function(page,opts){const result=build.call(this,page,opts);this.worldSnapshot(result);return result;};
}
