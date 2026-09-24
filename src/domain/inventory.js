import { integer,requireRule,polygon,polygonFromPoints,rect,overlap,contains,fitsPolygon,sameGround,freeZone,ringArea,ringInside } from './geometry.js';
// Stored boundaries were validated when they were saved: a save that sends no geometry keeps them as they are (even a legacy 101-corner ring).
const outlineOf=(input,old)=>{requireRule(input.points===undefined||input.segments===undefined,'Send the boundary as corners or as lines, not both.');if(input.points!==undefined)return polygonFromPoints(input.points,old?.points??[]);if(input.segments!==undefined)return polygon(input.segments,input.closed);requireRule(old,'Draw the boundary first.');return {points:old.points,area:old.area??ringArea(old.points)};};
const zoneBox=p=>({x:p.x,y:p.y,w:2000,h:1500});const samePoint=(a,b)=>!!a&&!!b&&a.x===b.x&&a.y===b.y;const sameBox=(a,b)=>!!a&&!!b&&a.kind===b.kind&&a.x===b.x&&a.y===b.y&&a.w===b.w&&a.h===b.h;
export { freeZone };
// The part of the placement rules that depends only on the location's shape (boundary, loading zone, fixtures). Same messages as validatePlacement.
export function spotProblem(r,loc){if(!fitsPolygon(r,loc.points))return 'The entire footprint must fit inside the storage polygon.';if(loc.loading&&overlap(r,zoneBox(loc.loading)))return 'Keep the loading position clear.';for(const f of loc.fixtures??[])if(overlap(r,f))return 'Keep the '+f.name.toLowerCase()+' clear.';return null;}
// What a boundary change does to the crew at a location. The quick preview and the real save both use this, so they always agree.
const crewImpact=resources=>({stops:resources.reduce((n,r)=>n+((r.walk&&!r.walk.job)||r.mountTarget?1:0)+(r.drive?1:0),0),jobs:resources.filter(r=>r.job).length});
import { label,nullable } from './catalogue.js';
import { fixtureList,solidFixture } from './fixtures.js';
export const active=t=>!['COMPLETE','CANCELLED','FAILED'].includes(t.state);
export const inventoryMethods={
  parking(input){
    const yard=this.repo.get(input.id,'yard');
    requireRule(['LEFT','RIGHT'].includes(input.side),'Choose the left or right side of the yard.');
    const vehicleLength=integer(input.vehicleLength,'Overall truck length',1000,30000),vehicleWidth=integer(input.vehicleWidth,'Overall truck width',1000,5000),clearance=integer(input.clearance,'Clearance on each side',0,10000);
    yard.parking={side:input.side,vehicleLength,vehicleWidth,clearance,length:vehicleLength+2*clearance,width:vehicleWidth+2*clearance};
    return this.repo.save(yard);
  },
  containerSettings(input){const c=this.repo.get(input.id,'container');this.assertFree(c);c.tare=nullable(input.tare,'Tare (g)');c.capacity=input.capacity===undefined?c.capacity:nullable(input.capacity,'Loaded capacity (g)');c.envelopeLength=integer(input.envelopeLength,'Loaded length',c.length);c.envelopeWidth=integer(input.envelopeWidth,'Loaded width',c.width);this.validatePlacement(c,c.location,c);this.repo.save(c);this.repo.event(this.user.id,'CONTAINER_SETTINGS',{container:c.id,reason:label(input.reason,'Reason'),key:this.key});return c;},
  yard(input,opts={}){
    const old=input.id?this.repo.get(input.id,'yard'):null;
    if(old)return this.reshape(old,input,opts);
    const geometry=outlineOf(input,null);const height=integer(input.height??10000,'Yard height',1,100000);
    const fit=p=>{integer(p.x,'Position x',-1000000);integer(p.y,'Position y',-1000000);requireRule(fitsPolygon(zoneBox(p),geometry.points),'Gate and loading position need a clear 2 m × 1.5 m footprint inside the yard.');return p;};
    const fixtures=fixtureList(input.fixtures??[],geometry.points),loading=fit(input.loading??{x:1000,y:1000});for(const f of fixtures)if(solidFixture(f))requireRule(!overlap(f,zoneBox(loading)),f.name+' overlaps the loading zone.');
    const gate=input.gate!==undefined?fit(input.gate):freeZone(geometry.points,[zoneBox(loading),...fixtures.filter(solidFixture)],[{x:loading.x+2500,y:loading.y}],loading)??loading;
    return this.repo.add('yard',{name:label(input.name),segments:input.points!==undefined?null:input.segments,closed:true,...geometry,height,gate,loading,fixtures,shapeRev:1,mode:'DEMO ONLY'});
  },
  siteBoundary(input,opts={}){const site=this.repo.get(input.id,'site');this.assertSite(site.id);requireRule(site.status==='ACTIVE','Choose an active site.');return this.reshape(site,input,opts);},
  // Change a yard or site: name, height, boundary, loading zone, gate, fixtures. opts.dryRun 'quick' answers what would happen without writing.
  // opts.deadline (performance.now() ms) bounds the relocation search of a preview; past it positionFor throws an AppError with .slow.
  reshape(old,input,opts={}){
    // Guard on the shape revision, not the record version: automatic work (sweeps, parking) saves the yard record too.
    requireRule(input.shapeRev===undefined||input.shapeRev===(old.shapeRev??0),'Someone else saved '+old.name+' while you were editing. Nothing was changed.');
    const geometry=outlineOf(input,old);const height=integer(input.height??old.height??10000,'Storage height',1,100000);const notes=[];const where=old.kind==='site'?'site':'yard';
    const fixtures=fixtureList(input.fixtures??old.fixtures??[],geometry.points),solids=fixtures.filter(solidFixture);
    const rawLoading=input.loading??old.loading??{x:1000,y:1000},rawGate=input.gate??old.gate??{x:1000,y:1000};
    const oldFixtures=old.fixtures??[];
    const shapeChanged=!sameGround(geometry.points,old.points)||!samePoint(rawLoading,old.loading)||!samePoint(rawGate,old.gate)||fixtures.length!==oldFixtures.length||fixtures.some((f,i)=>!sameBox(f,oldFixtures[i]));
    const heightChanged=height!==(old.height??10000);
    const segments=input.points!==undefined?null:input.segments!==undefined?input.segments:(old.segments??null);
    const name=label(input.name??old.name),shapeRev=(old.shapeRev??0)+1;
    const stored=this.containers().filter(c=>c.location===old.id);
    const stock=()=>stored.map(c=>({id:c.id,name:c.name,...rect(c),rotation:c.rotation??0,support:c.support??null,height:c.height}));
    const sentGround=input.points!==undefined||input.segments!==undefined;
    if(!shapeChanged&&!heightChanged){
      // Same ground (at most a corner added or removed in the middle of a straight side): keep the corners exactly as the owner sent them.
      if(opts.dryRun==='quick')return {quick:true,unchanged:true,points:geometry.points,area:geometry.area,height,loading:old.loading,gate:old.gate,fixtures,loadingMoved:false,gateMoved:false,affected:[],stops:0,jobs:0,incoming:0,halted:[],stock:stock(),notes:[]};
      const loc=this.repo.save({...old,name,segments,...(sentGround?{points:geometry.points,area:geometry.area}:{}),fixtures,shapeRev});return {...loc,relocated:[],relocatedIds:[],message:'Saved.'};
    }
    // Loading zone and gate stay where they are unless the new shape covers them; then the nearest clear spot (a gate sharing the loading spot prefers 2.5 m to its right).
    const fitPoint=(p,what,avoid,prefer=[])=>{integer(p.x,'Position x',-1000000);integer(p.y,'Position y',-1000000);if(fitsPolygon(zoneBox(p),geometry.points)&&!avoid.some(o=>overlap(zoneBox(p),o)))return p;const q=freeZone(geometry.points,avoid,prefer,p);requireRule(q,'The '+where+' is too small: it must fit the 2 × 1.5 m loading zone and a separate 2 × 1.5 m gate.');notes.push(what+' moved to '+(q.x/1000).toFixed(1)+' m, '+(q.y/1000).toFixed(1)+' m '+(fitsPolygon(zoneBox(p),geometry.points)?'to keep it clear of the '+(what==='Gate'?'loading zone and ':'')+'fixtures':'to stay inside the boundary'));return q;};
    const loading=shapeChanged?fitPoint(rawLoading,'Loading zone',solids):old.loading;
    const gate=shapeChanged?fitPoint(rawGate,'Gate',[zoneBox(loading),...solids],overlap(zoneBox(rawGate),zoneBox(loading))?[{x:loading.x+2500,y:loading.y}]:[]):old.gate;
    for(const f of solids)requireRule(!overlap(f,zoneBox(loading)),f.name+' overlaps the loading zone. Move it first.');
    const next={points:geometry.points,loading,fixtures};
    // The new ground only adds to the old one (same loading zone, gate and fixtures, height not lowered): every spot and route that was valid
    // stays valid, so the crew keeps working and nothing in flight is re-planned.
    const grows=shapeChanged&&samePoint(loading,old.loading)&&samePoint(gate,old.gate)&&fixtures.length===oldFixtures.length&&fixtures.every((f,i)=>sameBox(f,oldFixtures[i]))&&height>=(old.height??10000)&&ringInside(old.points,geometry.points);
    const reroute=shapeChanged&&!grows;
    const incomingTasks=this.tasks().filter(t=>active(t)&&t.to===old.id&&t.position);
    const tall=[...stored,...incomingTasks.map(t=>this.repo.get(t.container,'container'))].filter(c=>c.height>height);requireRule(!tall.length,'Storage height is lower than '+(tall.length&&!stored.includes(tall[0])?'a stillage on its way here':'a stored stillage')+(tall.length?' ('+tall[0].name+' is '+(tall[0].height/1000).toFixed(1)+' m)':'')+'. Raise the height or move stock first.');
    const byId=new Map(stored.map(c=>[c.id,c]));
    const stackHeight=c=>{let h=c.height,cur=c,n=0;while(cur?.support&&n++<9){cur=byId.get(cur.support);h+=cur?.height??0;}return h;};
    const WHY={'The entire footprint must fit inside the storage polygon.':'outside','Keep the loading position clear.':'loading'};
    const why=c=>{const w=shapeChanged?spotProblem(rect(c),next):null;return w?WHY[w]??'fixture':c.support&&stackHeight(c)>height?'height':null;};
    const affected=new Set(stored.filter(c=>why(c)).map(c=>c.id));
    let grew=true;while(grew){grew=false;for(const c of stored)if(c.support&&affected.has(c.support)&&!affected.has(c.id)){affected.add(c.id);grew=true;}}
    const level=c=>{let n=0,cur=c;while(cur?.support&&n<9){n++;cur=byId.get(cur.support);}return n;};const moved=[],movedIds=[];
    const queue=stored.filter(c=>affected.has(c.id)).sort((a,b)=>level(b)-level(a));
    // Why each one moves; a stillage stacked on a moved one moves for the same reason as the bottom of its pile.
    const reasonOf=new Map(queue.map(c=>{let cur=c,n=0;while(!why(cur)&&cur.support&&byId.has(cur.support)&&n++<9)cur=byId.get(cur.support);return [c.id,why(cur)??'pile'];}));
    // Movements the change makes wrong: heading for a spot the new shape covers ('spot'), for a stack on a stillage that must move ('support'),
    // for a stack taller than the new height ('height'), or a waiting turn / layout step of a stillage that must move ('moved').
    const planned=t=>!!(t.turn||t.layout);
    const planAt=id=>{if(byId.has(id))return byId.get(id);const t=incomingTasks.find(t=>t.container===id);if(!t)return null;return {id,height:this.repo.get(id,'container').height,support:t.position.support??null};};
    const destHeight=(c,pos)=>{let h=c.height,cur=pos.support,n=0;while(cur&&n++<9){const s=planAt(cur);if(!s)break;h+=s.height;cur=s.support;}return h;};
    const staleWhy=t=>{if(t.to===old.id&&t.position){const c=this.repo.get(t.container,'container');if(shapeChanged&&spotProblem(rect(c,t.position),next))return 'spot';if(t.position.support&&affected.has(t.position.support))return 'support';if(heightChanged&&destHeight(c,t.position)>height)return 'height';}if(planned(t)&&!t.picked&&(t.from===old.id||t.to===old.id)&&affected.has(t.container))return 'moved';return null;};
    const stale=new Map();for(const t of this.tasks().filter(t=>active(t))){const w=staleWhy(t);if(w)stale.set(t.id,w);}
    const covered=this.tasks().filter(t=>stale.has(t.id)&&t.state!=='BLOCKED');
    // A load already on the forks for a turn or a layout step must be set down first (it cannot be re-planned or cancelled while carried).
    const onForks=this.tasks().find(t=>stale.has(t.id)&&t.picked&&planned(t));
    if(onForks){const c=this.repo.get(onForks.container,'container'),w=stale.get(onForks.id);let m='the forklift';try{m=this.repo.get(onForks.machine).name;}catch{}let s=null;try{s=w==='support'?this.repo.get(onForks.position.support,'container').name:null;}catch{}
      requireRule(false,c.name+' is on '+m+' heading for '+(w==='support'?'a stack on '+(s??'a stillage')+', which the new '+where+' shape moves':w==='height'?'a stack taller than the new height':'a spot the new '+where+' shape covers')+'. Wait until it has been set down, then save.');}
    const halted=covered.filter(t=>!t.picked&&planned(t)).map(t=>({task:t.id,name:this.repo.get(t.container,'container').name,turn:!!t.turn&&!t.layout,why:stale.get(t.id)}));
    // Enough free ground for everything that must move? Necessary, not sufficient: the full dry run or the save gives the final answer.
    const area=c=>{const r=rect(c);return r.w*r.h;},needed=queue.reduce((s,c)=>s+area(c),0);
    if(needed){const free=ringArea(geometry.points)-stored.filter(c=>!affected.has(c.id)&&!c.support).reduce((s,c)=>s+area(c),0)-3000000-fixtures.reduce((s,f)=>s+f.w*f.h,0);requireRule(needed<=free,'Not enough free ground inside the new '+where+' shape for the '+queue.length+' stillage'+(queue.length===1?'':'s')+' that must move ('+(needed/1e6).toFixed(1)+' m² needed, '+(Math.max(0,free)/1e6).toFixed(1)+' m² free).');}
    const resources=this.repo.all('resource').filter(r=>r.enabled&&r.location===old.id),impact=crewImpact(resources);
    if(opts.dryRun==='quick')return {quick:true,unchanged:false,grows,points:geometry.points,area:geometry.area,height,loading,gate,fixtures,loadingMoved:!samePoint(loading,rawLoading),gateMoved:!samePoint(gate,rawGate),affected:queue.map(c=>({id:c.id,name:c.name,why:why(c)??'pile'})),stops:reroute?impact.stops:0,jobs:reroute?impact.jobs:0,incoming:covered.filter(t=>!planned(t)).length,halted,stock:stock(),notes:[...notes]};
    const loc=this.repo.save({...old,name,segments,closed:true,...geometry,height,gate,loading,fixtures,shapeRev});
    // Crew: stop manual orders (cargo stays on the forks), hand yard jobs back, release mount claims, keep everyone as an obstacle for relocation
    const stopped=reroute?impact.stops:0,handed=reroute?impact.jobs:0;
    if(reroute)for(const r of resources){let changed=false;if(r.job){this.releaseJob(r,'Boundary changed');changed=true;}if(r.walk||r.mountTarget){r.walk=null;this.releaseMount(r);r.workerMode='HOLD';r.workerReason='Boundary changed; give a new move order.';changed=true;}if(r.drive){r.drive=null;r.manualReason='Boundary changed; give a new order.';changed=true;}if(changed)this.repo.save(r);}
    const crew=resources.filter(r=>Number.isFinite(r.x)&&Number.isFinite(r.y)&&!r.mountedOn).map(r=>r.type==='FORKLIFT'?{x:r.x,y:r.y,...this.forkliftShape(r)}:{x:r.x,y:r.y,w:500,h:500});
    this.relocating=new Set(affected);this.memo={containers:this.containers(),tasks:this.tasks()};this.deadline=opts.deadline??null;
    try{
      for(const c of queue){requireRule(!this.tasks().some(t=>active(t)&&(t.container===c.id||t.sourceContainer===c.id)&&t.picked),c.name+' is on handling equipment. Let it be placed first.');this.assertCountFree(c);requireRule(!resources.some(m=>m.cargo===c.id),c.name+' is on a forklift. Place it first.');
        const was={x:c.x,y:c.y,rotation:c.rotation,support:c.support};let position=null;try{position=this.positionFor(c,loc.id,[],{avoid:crew,grid:true});}catch(error){if(error.slow||/payload|unknown|stocktake/.test(error.message))throw error;}
        requireRule(position,'The new boundary is too small for the stored stillages ('+c.name+' has no clear space). Enlarge it or move stock first.');
        c.x=position.x;c.y=position.y;c.rotation=position.rotation;c.support=null;c.placedAt=new Date().toISOString();this.repo.save(c);{const m=this.memo.containers.find(o=>o.id===c.id);if(m&&m!==c)Object.assign(m,c);}this.relocating.delete(c.id);
        this.repo.event(this.user.id,'RELOCATED',{container:c.id,source:loc.id,destination:loc.id,reason:'Boundary changed: moved from '+was.x+','+was.y+' r'+was.rotation+(was.support?' (unstacked)':'')+' to '+position.x+','+position.y+' r'+position.rotation,key:this.key});moved.push(c.name);movedIds.push(c.id);}
    }finally{this.relocating=null;this.memo=null;this.deadline=null;}
    // In-flight automatic movements: re-fit destinations the change makes wrong and let unpicked tasks re-plan against the new geometry.
    // A waiting turn or layout step the change makes wrong stops (BLOCKED, nothing picked, Cancel works) instead of going somewhere else.
    const HALT_TURN={spot:c=>'The new '+where+' shape covers the spot '+c.name+' was being turned into. Cancel this turn, then turn '+c.name+' again.',moved:c=>c.name+' was moved by the '+where+' change. Cancel this turn, then turn '+c.name+' again.',support:(c,s)=>s+', which '+c.name+' was to be set back on, was moved by the '+where+' change. Cancel this turn, then turn '+c.name+' again.',height:c=>'The new height is too low for '+c.name+' on its stack. Cancel this turn, then turn '+c.name+' again.'};
    const HALT_STEP={spot:()=>'The new '+where+' shape covers the spot for this step. Cancel the remaining steps and plan again.',moved:c=>c.name+' was moved by the '+where+' change. Cancel the remaining steps and plan again.',support:(c,s)=>s+', which '+c.name+' was to be stacked on, was moved by the '+where+' change. Cancel the remaining steps and plan again.',height:c=>'The new height is too low for the stack this step builds with '+c.name+'. Cancel the remaining steps and plan again.'};
    const movedSet=new Set(movedIds);let replanned=0;const halt=new Map(halted.map(h=>[h.task,h.why]));for(const t of this.tasks().filter(t=>active(t)&&t.state!=='BLOCKED'&&(t.to===loc.id||t.from===loc.id||t.handling===loc.id))){const c=this.repo.get(t.container,'container');let changed=false;
      const drop=()=>{for(const r of this.repo.all('resource').filter(r=>r.task===t.id)){r.task=null;this.repo.save(r);}};
      if(halt.has(t.id)){drop();t.resumeState='RESERVED';t.state='BLOCKED';t.resources=[];t.machine=null;t.path=null;t.due=0;let s='a stillage';try{if(t.position?.support)s=this.repo.get(t.position.support,'container').name;}catch{}t.reason=(t.turn&&!t.layout?HALT_TURN:HALT_STEP)[halt.get(t.id)](c,s);this.repo.save(t);replanned++;continue;}
      if(t.to===loc.id&&t.position&&stale.has(t.id)&&stale.get(t.id)!=='moved'){let position=null;try{position=this.positionFor(c,loc.id);}catch{}if(position){t.position={...position};changed=true;}else{drop();t.resumeState=t.state;t.state='BLOCKED';t.reason='Boundary changed: no clear destination. Enlarge the area or move stock, then retry.';this.repo.save(t);replanned++;continue;}}
      if(!t.picked&&['ASSIGNED','TRAVELLING_TO_PICKUP','PICKING'].includes(t.state)&&(reroute||changed||movedSet.has(t.container)||movedSet.has(t.sourceContainer))){drop();t.state='RESERVED';t.resources=[];t.machine=null;t.path=null;t.due=0;changed=true;}
      if(changed){this.repo.save(t);replanned++;}}
    // Re-seat crew left outside or under relocated stock; a forklift's driver follows it
    if(reroute||moved.length){const blocked=[...this.containers().filter(c=>c.location===loc.id).map(c=>rect(c)),...solids];
    for(const r of this.repo.all('resource').filter(r=>r.enabled&&r.location===loc.id&&['WORKER','FORKLIFT'].includes(r.type))){const footprint=r.type==='FORKLIFT'?{x:r.x,y:r.y,...this.forkliftShape(r)}:{x:r.x,y:r.y,w:500,h:500};
      if(Number.isFinite(r.x)&&(!fitsPolygon(footprint,geometry.points)||blocked.some(o=>overlap(footprint,o)))){r.x=null;r.y=null;if(r.type==='FORKLIFT'){const p=this.forkliftPosition(r);if(p){Object.assign(r,p);if(r.driver){const d=this.repo.get(r.driver,'resource');d.x=r.x+600;d.y=r.y+350;this.repo.save(d);}}}this.repo.save(r);}}}
    // Say why each stillage moved, grouped by reason.
    const say=(w,text)=>{const g=moved.filter((_,i)=>reasonOf.get(movedIds[i])===w);return g.length?text(g.length)+': '+g.join(', '):null;};
    notes.unshift(...[say('outside',n=>'Moved '+n+' stillage(s) inside the new boundary'),say('loading',n=>'Moved '+n+' stillage(s) off the loading zone'),say('fixture',n=>'Moved '+n+' stillage(s) clear of the fixtures'),say('height',n=>'Set down '+n+' stillage(s) to fit the new '+(height/1000).toFixed(1)+' m height'),say('pile',n=>'Moved '+n+' stillage(s)')].filter(Boolean));
    if(stopped)notes.push(stopped+' manual worker/forklift order(s) stopped');if(handed)notes.push(handed+' yard job(s) handed back for re-assignment');if(replanned)notes.push(replanned+' movement(s) re-planned or stopped');
    return {...loc,relocated:moved,relocatedIds:movedIds,message:notes.length?'Saved. '+notes.join('. ')+'.':'Saved.'};
  },
  containers(){return this.memo?this.memo.containers:this.repo.all('container').filter(c=>!c.retired);},tasks(){return this.memo?this.memo.tasks:this.repo.all('task');},
  container(input){
    const location=this.repo.get(input.location);requireRule(['yard','site'].includes(location.kind),'Register containers at a yard or site.');this.assertSite(location.id);
    requireRule(['STILLAGE','RACK','CAGE','BUNDLE'].includes(input.type),'Choose a container type.');
    const data={name:label(input.name),type:input.type,model:input.model??'Company configured DEMO frame',length:integer(input.length,'Frame length',1),width:integer(input.width,'Frame width',1),height:integer(input.height,'Height',1),envelopeLength:integer(input.envelopeLength??input.length,'Loaded length',1),envelopeWidth:integer(input.envelopeWidth??input.width,'Loaded width',1),tare:nullable(input.tare,'Tare (g)'),capacity:nullable(input.capacity,'Capacity (g)'),location:location.id,x:integer(input.x,'X',-1000000),y:integer(input.y,'Y',-1000000),rotation:input.rotation??0,support:input.support??null,condition:'SERVICEABLE',mode:'DEMO ONLY'};
    requireRule(data.envelopeLength>=data.length&&data.envelopeWidth>=data.width,'Loaded envelope cannot be smaller than its frame.');
    this.validatePlacement(data,location.id,data);return this.repo.add('container',data);
  },
  weight(c,extra=[]){let total=c.tare;requireRule(total!==null,'Container tare weight is unknown. Configure it before moving.');for(const line of [...(c.id?this.repo.lines(c.id):[]),...extra]){const p=this.effective(line.product_id);requireRule(p.unitWeight!==null,`${p.name}: unit weight is unknown. Configure it before moving.`);total+=line.quantity*p.unitWeight;requireRule(Number.isSafeInteger(total),'Weight exceeds the supported exact range.');}return total;},
  occupied(location,exclude){const current=this.containers().filter(c=>c.location===location&&c.id!==exclude&&!this.relocating?.has(c.id));const ids=new Set(current.map(c=>c.id));for(const t of this.tasks().filter(t=>active(t)&&t.to===location&&t.container!==exclude&&t.position)){if(!ids.has(t.container)){current.push({...this.repo.get(t.container,'container'),...t.position,id:t.container});ids.add(t.container);}else if(t.from===location&&!t.picked&&!this.relocating?.has(t.container)){current.push({...this.repo.get(t.container,'container'),...t.position,id:'planned:'+t.id,ghost:true});}}return current;},
  validatePlacement(c,destination,position,extra=[]){
    const loc=this.repo.get(destination);requireRule(['yard','site','truck'].includes(loc.kind),'Choose a storage destination.');this.assertSite(destination);
    requireRule(!this.repo.all('count').some(n=>n.state==='OPEN'&&(n.scope===destination||n.scope===c.id)),'An active stocktake locks this destination.');
    integer(position.x,'Position x',-1000000);integer(position.y,'Position y',-1000000);const r=rect(c,position),others=this.occupied(destination,c.id);const support=position.support?others.find(o=>o.id===position.support):null;
    requireRule(!position.support||support,'The supporting container is not at this destination.');
    let level=1,height=c.height,ancestor=support;const seen=new Set([c.id]);while(ancestor){requireRule(!seen.has(ancestor.id),'Invalid support cycle.');seen.add(ancestor.id);level++;height+=ancestor.height;ancestor=ancestor.support?others.find(o=>o.id===ancestor.support):null;}
    if(support){requireRule(support.type===c.type,'Use compatible container supports.');requireRule(contains(rect(support),r),'An upper container must be fully supported.');requireRule(!this.tasks().some(t=>active(t)&&t.container===support.id),'Wait until the supporting container has been placed.');}
    const max=loc.kind==='truck'?loc.stackLimit:7;requireRule(level<=max,`Maximum ${max} containers high at this destination.`);requireRule(height<=(loc.height??10000),'The stack exceeds the configured height.');
    for(const other of others){const sameBase=(other.support??null)===(position.support??null);requireRule(!sameBase||!overlap(r,rect(other)),'The destination footprint overlaps another container or reservation.');}
    if(loc.kind==='truck'){
      requireRule(['AT_YARD','AT_SITE'].includes(loc.status),'Truck has departed or is not available for loading.');requireRule(contains({x:0,y:0,w:loc.length,h:loc.width},r),'The full loaded envelope does not fit on the truck deck.');
      const total=others.reduce((sum,o)=>sum+this.projectedWeight(o),0)+this.weight(c,extra);requireRule(total<=loc.payload,'Truck would exceed its configured payload.');
    }else{requireRule(loc.status!=='ARCHIVED','This site is archived.');requireRule(fitsPolygon(r,loc.points),'The entire footprint must fit inside the storage polygon.');requireRule(!overlap(r,{...loc.loading,w:2000,h:1500}),'Keep the loading position clear.');for(const f of loc.fixtures??[])requireRule(!overlap(r,f),'Keep the '+f.name.toLowerCase()+' clear.');}
    return {level,height};
  },
  projectedWeight(c){const repack=this.tasks().find(t=>active(t)&&t.type==='REPACK'&&t.container===c.id&&!t.picked);return this.weight(c,repack?[{product_id:repack.product,quantity:repack.quantity}]:[]);},
  assertFree(container,manualMachine=null){requireRule(!this.repo.all('resource').some(m=>m.id!==manualMachine&&(m.cargo===container.id||m.drive?.container===container.id)),'This stillage is assigned to a manual forklift.');requireRule(!this.containers().some(c=>c.support===container.id)&&!this.tasks().some(t=>active(t)&&t.position?.support===container.id),'Move the top stillage first.');requireRule(!this.tasks().some(t=>active(t)&&(t.container===container.id||t.sourceContainer===container.id)),'This container already has an active movement.');this.assertCountFree(container);},
  assertCountFree(c){requireRule(!this.repo.all('count').some(n=>n.state==='OPEN'&&(n.scope===c.id||n.scope===c.location)),'An active stocktake locks this stock. Complete or cancel the count first.');},
  opening(input){return this.receiveStock(input,'OPENING_BALANCE');},
  count(input){const scope=this.repo.get(input.scope);requireRule(['container','yard','site'].includes(scope.kind),'Count a container, yard or site.');this.assertSite(scope.id);requireRule(!this.repo.all('resource').some(m=>m.cargo&&(m.location===scope.id||m.cargo===scope.id)||m.drive&&(m.location===scope.id||m.drive.container===scope.id)),'Finish manual forklift handling before starting this count.');const containers=this.containers().filter(c=>scope.kind==='container'?c.id===scope.id:c.location===scope.id);requireRule(containers.length,'There are no containers in this count scope.');for(const c of containers)this.assertFree(c);requireRule(!this.tasks().some(t=>active(t)&&t.to===scope.id),'An incoming task must finish before counting.');const lines=containers.flatMap(c=>this.repo.lines(c.id).map(l=>({...l,container:c.id,expected:l.quantity,observed:null})));return this.repo.add('count',{scope:scope.id,name:scope.name,state:'OPEN',lines,counter:this.user.id,createdAt:new Date().toISOString()});},
  observe(input){const count=this.repo.get(input.id,'count');requireRule(count.state==='OPEN','This count is closed.');this.assertSite(count.scope);requireRule(Array.isArray(input.observed)&&input.observed.length===count.lines.length,'Enter a count for every line.');count.lines=count.lines.map((l,i)=>({...l,observed:integer(input.observed[i],'Observed quantity',0,1000000)}));count.reason=label(input.reason,'Variance reason');count.counter=this.user.id;return this.repo.save(count);},
  approveCount(input){this.auth.require(this.user,'stock.adjust');const count=this.repo.get(input.id,'count');requireRule(count.state==='OPEN'&&count.lines.every(l=>l.observed!==null)&&count.reason,'Enter all counts and a reason first.');for(const l of count.lines){requireRule(this.repo.quantity(l.container,l.product_id)===l.expected,'Expected stock changed; cancel and restart the count.');const variance=l.observed-l.expected;this.repo.balance(l.container,l.product_id,variance);this.repo.event(this.user.id,'STOCKTAKE_ADJUSTMENT',{product:l.product_id,container:l.container,quantity:variance,source:count.scope,destination:count.scope,reason:count.reason,key:this.key});}count.state='APPROVED';count.approver=this.user.id;count.approvedAt=new Date().toISOString();return this.repo.save(count);},
  cancelCount(input){const count=this.repo.get(input.id,'count');requireRule(count.state==='OPEN','This count is closed.');this.assertSite(count.scope);count.state='CANCELLED';return this.repo.save(count);},
  condition(input){const c=this.repo.get(input.id,'container');this.assertFree(c);requireRule(['SERVICEABLE','DAMAGED','QUARANTINED'].includes(input.condition),'Choose a condition.');c.condition=input.condition;this.repo.save(c);this.repo.event(this.user.id,'CONDITION',{container:c.id,reason:label(input.reason,'Reason'),key:this.key});return c;}
};
