// Home world map, server side: where every site sits on the map (lots), the road each truck trip takes and how long it drives, and the compact
// world block of the snapshot. The geometry itself is the shared pure module public/world-layout.js, so the browser draws the road it was timed on.
// Installed on Simulation.prototype by installWorld (simulation.js): it wraps dispatch (a trip gets a route and a travel time from its road length),
// archive (the other sites keep their blocks) and buildSnapshot (adds result.world). The drive itself is counted down by the engine (movement.js) on the live overlay (live.js):
// remainingMs is held in memory between writes (one write about every 2 s of engine time, and on arrival), every read sees the exact value,
// a pause writes it and a stop flushes it (flushLive), so the snapshot, the Today page and the map all read one clock.
import { requireRule,integer } from './geometry.js';
import { AppError } from '../service.js';
import { WORLD,worldLayout,worldRoute,tripMs,tripLength,layoutKey,restPoses,destSlot } from '../../public/world-layout.js';
export const WORLD_OPS=['worldPlace'];
// One stillage on the map as a short array (public/world.js wmWorldMerge reads it back): [id, name, type, condition, x, y, rotation, support, length,
// width, height, pieces, lines [[product, quantity]]]. Grouped by where it is (a site, a truck, a crane hook), each group with a revision.
const compact=(c,lines)=>{const l=lines.map(x=>[x.product_id,x.quantity]);return [c.id,c.name,c.type,c.condition,c.x,c.y,c.rotation??0,c.support??null,c.envelopeLength,c.envelopeWidth,c.height,l.reduce((n,x)=>n+(x[1]>0?x[1]:0),0),l];};
const revOf=str=>{let h=2166136261;for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(36)+str.length.toString(36);};
const logError=(event,fields)=>{try{console.error(JSON.stringify({event,...fields}));}catch{}};
export const worldMethods={
  // The places on the map: the first yard and every active site, plus an archived site a truck is still driving to or from or parked at (drawn
  // faded, so that truck and its load never vanish from the map and can still be sent back). Other archived sites only size the blocks.
  worldLayoutNow(){const yard=this.repo.all('yard')[0]??null,all=this.repo.all('site'),busy=this.worldEngaged(),shown=s=>s.status==='ACTIVE'||busy.has(s.id);return worldLayout(yard,all.filter(shown),null,all.filter(s=>!shown(s)));},
  worldEngaged(){const out=new Set();for(const t of this.repo.all('truck')){if(t.retired)continue;if(t.status==='AT_SITE')out.add(t.at);else if(t.status==='IN_TRANSIT'){out.add(t.at);out.add(t.destination);if(t.route?.from)out.add(t.route.from);}}return out;},
  // A trip's road and time. Called right after logistics dispatch saved the truck IN_TRANSIT (same transaction). A fault in the map geometry never
  // blocks a dispatch: the trip then keeps the old fixed 3 s and no road (the page draws one itself). A trip to or from a place that is not on the map
  // (a second yard) has no road either, and takes the time of a typical trip (WORLD.fallbackLength) rather than 3 s.
  worldDepart(truck){
    const config=this.repo.all('config')[0]??{};let route=null,l=null,fault=false;
    try{
      l=this.worldLayoutNow();const all=this.repo.all('truck').filter(t=>!t.retired),from=truck.at,to=truck.destination,atRest=id=>all.filter(t=>t.at===id&&['AT_YARD','AT_SITE'].includes(t.status));
      // Where it stands now (its spot among the trucks at rest there, itself included as it was) and the first free spot where it is going.
      const start=restPoses(l,from,all.filter(t=>t.at===from&&(t.id===truck.id||['AT_YARD','AT_SITE'].includes(t.status))).map(t=>t.id===truck.id?{...t,status:'AT_REST'}:t),all).get(truck.id);
      const slot=destSlot(l,to,atRest(to),all.filter(t=>t.id!==truck.id&&t.status==='IN_TRANSIT'&&t.destination===to),all);
      route=worldRoute(l,truck,from,to,{start,k:slot.k,bayFree:slot.bayFree});
    }catch(error){logError('world_route_error',{truck:truck.id,message:error?.message});route=null;fault=true;}
    const durationMs=route?tripMs(tripLength(route,l),config):fault?3000:tripMs(WORLD.fallbackLength,config);
    truck.remainingMs=durationMs;truck.route=route?{...route,durationMs,delivery:truck.delivery}:{from:truck.at,to:truck.destination,durationMs,delivery:truck.delivery,points:null};
    return this.repo.save(truck);
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
    // next to the others (at most two blocks out), so one far-away site never shrinks the rest of the map to a corner
    const rest=l.places.filter(p=>p.id!==site.id),near=(v,k)=>v>=Math.min(...rest.map(p=>p[k]))-2&&v<=Math.max(...rest.map(p=>p[k]))+2;requireRule(near(col,'col')&&near(row,'row'),'That block is too far out. Choose a block at most two blocks from the others.');
    this.worldPin(l,site.id);
    site.map={col,row};this.repo.save(site);
    this.repo.event(this.user.id,'SITE_MAP',{destination:site.id,reason:'Moved on the map to block '+col+','+row,key:this.key});
    return {ok:true,site:{id:site.id,map:site.map},message:site.name+' moved on the map. New trips take the new road.'};
  },
  // result.world, only for the Home map's poll (?world=): the lots every viewer draws (visible places only) and every stillage at a visible site, on a
  // visible truck or hanging from a site crane (unpaged, so the map never misses cargo or site stock that sits on another page of the list), in
  // groups by location. `want` lists the group revisions the page already has ('.'-separated); those groups come back as {loc, rev, same} only,
  // so a poll while nothing on the map changed is a few hundred bytes. Supervisors get no yard details.
  worldSnapshot(result,want){
    const l=this.worldLayoutNow(),siteIds=new Set(result.sites.map(s=>s.id)),yard=l.places.find(p=>p.kind==='yard'),seesYard=!!yard&&(result.yards??[]).some(y=>y.id===yard.id);
    const key=layoutKey(l);key.lots=Object.fromEntries(Object.entries(key.lots).filter(([id])=>(seesYard&&id===yard?.id)||siteIds.has(id)));
    const truckIds=new Set(result.trucks.map(t=>t.id)),cranes=new Set(result.resources.filter(r=>r.type==='CRANE'&&siteIds.has(r.location)).map(r=>r.id));
    const groups=new Map();for(const c of this.containers()){if(!(siteIds.has(c.location)||truckIds.has(c.location)||cranes.has(c.location)))continue;let g=groups.get(c.location);if(!g)groups.set(c.location,g=[]);g.push(compact(c,this.repo.lines(c.id)));}
    const have=new Set(String(want??'').split('.').filter(Boolean));
    result.world={...key,groups:[...groups.keys()].sort().map(loc=>{const items=groups.get(loc),rev=revOf(JSON.stringify([loc,items]));return have.has(rev)?{loc,rev,same:1}:{loc,rev,items};})};
  }
};
export function installWorld(proto){
  const dispatch=proto.dispatch,build=proto.buildSnapshot,archive=proto.archive;if(typeof dispatch!=='function'||typeof build!=='function')throw new AppError(500,'World map needs dispatch and buildSnapshot.');
  Object.assign(proto,worldMethods);
  proto.dispatch=function(input){return this.worldDepart(dispatch.call(this,input));};
  // Archiving a site: pin every site first so none of them moves, the archived one included (it comes back to its block while a truck is still
  // on its way there or parked there). The same transaction, so a refused archive pins nothing.
  if(typeof archive==='function')proto.archive=function(input){try{const l=this.worldLayoutNow();if(l.byId.get(input?.id)?.kind==='site')this.worldPin(l);}catch(error){if(error instanceof AppError)throw error;logError('world_pin_error',{message:error?.message});}return archive.call(this,input);};
  // The world block only when the Home map asks for it (opts.world, from ?world= on its poll): the Stock, Today and Schedule polls, supervisors'
  // phones and exports never pay for it. A viewer without operations.manage gets a truck's trip clock but not its road through the yard.
  proto.buildSnapshot=function(page,opts){const result=build.call(this,page,opts);if(opts?.world)this.worldSnapshot(result,opts.world);
    if(!this.auth.permissions(this.user).includes('operations.manage'))result.trucks=result.trucks.map(t=>t.route?{...t,route:{from:t.route.from,to:t.route.to,durationMs:t.route.durationMs,delivery:t.route.delivery}}:t);
    return result;};
}
