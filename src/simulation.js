import {forkliftMethods} from './domain/forklifts.js';
import {workerMethods} from './domain/workers.js';
import { randomUUID,createHash } from 'node:crypto';
import { Repository } from './repository.js';
import { Service,AppError } from './service.js';
import { atomic,cached } from './database.js';
import { catalogueRevision } from './repository.js';
import { requireRule,integer } from './domain/geometry.js';
import { catalogueMethods } from './domain/catalogue.js';
import { inventoryMethods,active } from './domain/inventory.js';
import { logisticsMethods } from './domain/logistics.js';
import { movementMethods } from './domain/movement.js';
import { materialsMethods } from './domain/materials.js';
import { fleetMethods } from './domain/fleet.js';
import { layoutMethods } from './domain/layout.js';
import { jobMethods,flushJobTimers } from './domain/jobs.js';
import { turningMethods } from './domain/turning.js';
import { scheduleMethods,runOrder } from './domain/schedule.js';
import { alertMethods } from './domain/alerts.js';
import { reportsMethods } from './domain/reports.js';
const operational=['rotate','loadTruck','workerSkills','createJob','assignJob','nextJob','takeOffJob','cancelJob','jobsMode','siteDetails','fixtures','commitLayout','cancelLayout','siteBoundary','retire','scrapContainer','quickAdjust','allocateLoadList','workerCommand','parking','yard','container','containerSettings','product','override','seed','importCatalogue','site','archive','truck','resources','queue','allocate','cancel','retry','dispatch','unload','condition','pause','count','observe','cancelCount','bookTruck'];
export class Simulation {
  constructor(db,user){this.db=db;this.user=user;this.auth=new Service(db);this.repo=new Repository(db,user.company_id);}
  assertSite(id){if(this.auth.permissions(this.user).includes('operations.manage'))return;const object=this.repo.get(id);let site=object;if(object.kind==='container')site=this.repo.get(object.location);if(object.kind==='truck')site=this.repo.get(object.at);requireRule(site.kind==='site'&&site.supervisor===this.user.id,'You can only access your assigned sites.');}
  execute(action,input,key){
    requireRule(typeof key==='string'&&key.length>=8&&key.length<=150,'A valid idempotency key is required.');
    if(operational.includes(action))this.auth.require(this.user,'operations.manage');
    else if(['opening','purchase','stockIntake','stockRemoval','removeStock','purgeDemo','approveCount'].includes(action))this.auth.require(this.user,'stock.adjust');
    else if(['request','returnStock','cancelRequest','createLoadList','cancelLoadList','reschedule'].includes(action))this.auth.require(this.user,'requests.create');
    else throw new AppError(404,'Unknown command.');
    const fingerprint=createHash('sha256').update(JSON.stringify({actor:this.user.id,action,input})).digest('hex');this.key=key;
    return atomic(this.db,()=>{const previous=cached(this.db,'SELECT * FROM commands WHERE company_id=? AND key=?').get(this.user.company_id,key);if(previous){requireRule(previous.fingerprint===fingerprint,'This idempotency key was used for a different action.');return JSON.parse(previous.result);}const result=this[action](input);this.repo.event(this.user.id,'COMMAND',{reason:action,key});this.alCheck();cached(this.db,'INSERT INTO commands VALUES(?,?,?,?)').run(this.user.company_id,key,fingerprint,JSON.stringify(result??{ok:true}));return result;});
  }
  pause(input){let config=this.repo.all('config')[0];requireRule(config,'Configure yard resources first.');requireRule(typeof input.paused==='boolean','Choose pause or resume.');config.paused=input.paused;return this.repo.save(config);}
  notify(title,body,site){return this.repo.add('notification',{title,body,site,createdAt:new Date().toISOString(),provider:'IN_APP_ONLY'});}
  tripOf(id,visible){if(!id)return null;try{const d=this.repo.get(id,'delivery');return {id:d.id,status:d.status,completedAt:d.completedAt??null,to:visible(d.to)?d.to:null,from:visible(d.from)?d.from:null};}catch{return null;}}
  supervisorName(id){return id?cached(this.db,'SELECT name FROM users WHERE id=?').get(id)?.name??null:null;}
  // One read transaction and one read cache per call (Repository.cache, permissions, catalogue); all cleared in finally, never seen by commands or ticks.
  // opts.lean (GET /api/state): no sources, packaging or recentTasks, plus catalogueRev; products are left out when opts.catalogue equals it. opts.cache===false: no caches (tests).
  snapshot(page=0,opts=null){
    integer(page,'Container page',0,1000000);
    if(opts?.cache===false){this.catalogueBypass=true;try{return this.buildSnapshot(page,opts);}finally{this.catalogueBypass=false;}}
    const began=!this.db.isTransaction;if(began)this.db.exec('BEGIN');
    try{this.repo.cache={kinds:new Map(),ids:new Map(),contents:null};this.auth.memo={user:this.user,list:this.auth.permissions(this.user)};this.catalogueMemo=this.catalogue();return this.buildSnapshot(page,opts);}
    finally{this.repo.cache=null;this.auth.memo=null;this.catalogueMemo=null;if(began&&this.db.isTransaction)this.db.exec('COMMIT');}
  }
  buildSnapshot(page,opts){
    const lean=!!opts?.lean,cal=this.calendar();
    const operations=this.auth.permissions(this.user).includes('operations.manage');const sites=this.repo.all('site').filter(s=>operations||s.supervisor===this.user.id);const siteIds=new Set(sites.map(s=>s.id));
    const allTrucks=this.repo.all('truck'),allDeliveries=this.repo.all('delivery');const trucks=allTrucks.filter(t=>!t.retired&&(operations||siteIds.has(t.at)||siteIds.has(t.destination)));const lastAt=new Map();for(const d of allDeliveries)if(d.status==='DELIVERED'&&d.completedAt&&(!lastAt.has(d.to)||d.completedAt>lastAt.get(d.to)))lastAt.set(d.to,d.completedAt);const truckIds=new Set(trucks.map(t=>t.id));
    const allTasks=this.tasks(),liveTasks=allTasks.filter(active),visible=id=>operations||siteIds.has(id),depStarted=x=>!!x.dependency&&allTasks.some(d=>d.id===x.dependency&&d.state!=='CANCELLED'&&(d.machine||d.picked));const tasks=allTasks.filter(t=>operations||siteIds.has(t.handling));const machineIds=new Set(tasks.filter(t=>t.picked&&active(t)).map(t=>t.machine));
    const allContainers=this.containers().filter(c=>operations||siteIds.has(c.location)||truckIds.has(c.location)||machineIds.has(c.location));
    const reservedBy=new Map();for(const r of this.repo.all('reservation'))if(r.active){let m=reservedBy.get(r.container);if(!m)reservedBy.set(r.container,m=new Map());m.set(r.product,(m.get(r.product)??0)+r.quantity);}
    const allBalances=allContainers.flatMap(c=>{const held=reservedBy.get(c.id);return this.repo.lines(c.id).map(l=>({...l,container:c.id,location:c.location,condition:c.condition,reserved:held?.get(l.product_id)??0}));});
    const containers=allContainers.slice(page*100,(page+1)*100),ids=new Set(containers.map(c=>c.id)),balances=allBalances.filter(l=>ids.has(l.container));
    const products=this.effectiveProducts();const nameOf=new Map(allContainers.map(o=>[o.id,o.name]));
    const result={mode:'SIMULATION / DEMONSTRATION',yards:operations?this.repo.all('yard'):[],sites:sites.map(s=>({...s,supervisorName:this.supervisorName(s.supervisor),lastDeliveryAt:lastAt.get(s.id)??null})),trucks,containers,balances,products,tasks:tasks.filter(t=>active(t)).slice(0,100).map(t=>({...t,...this.taskInfo(t),containerName:nameOf.get(t.container)??null})),...(lean?{}:{recentTasks:tasks.filter(t=>!active(t)).slice(-20).map(t=>({...t,...this.taskInfo(t)}))}),requests:this.repo.all('request').filter(r=>operations||siteIds.has(r.site)),resources:this.repo.all('resource').filter(r=>r.enabled&&(operations||siteIds.has(r.location))),counts:operations?this.repo.all('count').slice(-30):[],config:this.repo.all('config')[0]??null,notifications:this.repo.all('notification').filter(n=>operations||siteIds.has(n.site)).slice(-10),...(lean?{}:{sources:this.repo.all('source'),packaging:this.repo.all('packaging')}),deliveries:allDeliveries.filter(d=>operations||siteIds.has(d.to)||siteIds.has(d.from)).slice(-30)};
    result.availability={stillages:allContainers.filter(c=>c.type!=='CAGE').length,cages:allContainers.filter(c=>c.type==='CAGE').length,serviceablePieces:allBalances.filter(l=>l.condition==='SERVICEABLE').reduce((s,l)=>s+l.quantity-l.reserved,0)};result.resources=result.resources.map(r=>r.type==='WORKER'?{...r,...this.workerPosition(r)}:r.type==='FORKLIFT'?{...r,...this.forkliftPosition(r),cargoPreview:r.cargo?this.repo.get(r.cargo,'container'):null}:r);result.register=this.register(allBalances,result.products);result.stock=this.stockByLocation(allBalances,allContainers,result.products);const today=new Date().toDateString(),payloadOf=new Map(allTrucks.map(t=>[t.id,t.payload]));result.runsToday={heavy:0,light:0};for(const d of allDeliveries){if(d.status!=='DELIVERED'||!d.completedAt||!(siteIds.has(d.to)||siteIds.has(d.from))||new Date(d.completedAt).toDateString()!==today)continue;const payload=payloadOf.get(d.truck);if(payload!==undefined)result.runsToday[payload>=10000000?'heavy':'light']++;}result.additions=this.stockLog('additions',100,products);result.removals=this.stockLog('removals',100,products);result.loadLists=this.loadLists(cal);result.layouts=operations?this.layouts():[];if(operations){const yardIds=new Set(result.yards.map(y=>y.id));const jv=this.jobsView(yardIds);result.jobs=jv.jobs;result.recentJobs=jv.recentJobs;result.skillCatalogue=this.skillCatalogue();result.ladder={};const boards=new Map();for(const y of result.yards){result.ladder[y.id]=this.ladderView(y,result.jobs,result.tasks);for(const [id,b] of this.workerBoards(y,result.resources.filter(r=>r.type==='WORKER'&&r.location===y.id),result.jobs,result.tasks))boards.set(id,b);}result.resources=result.resources.map(r=>r.type==='WORKER'?{...r,skills:this.normalisedSkills(r),board:boards.get(r.id)??null}:r);}else result.resources=result.resources.map(r=>r.type==='WORKER'?{...r,skills:this.normalisedSkills(r)}:r);const byDelivery=new Map();for(const l of result.loadLists)if(l.delivery)byDelivery.set(l.delivery,[...(byDelivery.get(l.delivery)??[]),l]);result.deliveries=result.deliveries.map(d=>({...d,manifest:byDelivery.get(d.id)??[]}));result.containerCount=allContainers.length;result.page=page;result.pageSize=100;result.stockTotal=allBalances.reduce((s,l)=>s+l.quantity,0);result.reservedTotal=allBalances.reduce((s,l)=>s+l.reserved,0);
    result.trucks=result.trucks.map(t=>{const loaded=allContainers.filter(c=>c.location===t.id),reserved=this.occupied(t.id).filter(c=>!loaded.some(l=>l.id===c.id));const mass=list=>{try{return list.reduce((sum,c)=>sum+this.projectedWeight(c),0);}catch{return null;}};return {...t,loadedWeight:mass(loaded),reservedWeight:mass(reserved),deckArea:loaded.filter(c=>!c.support).reduce((s,c)=>s+c.envelopeLength*c.envelopeWidth,0),tasksTo:liveTasks.filter(x=>x.to===t.id).length,tasksStarted:liveTasks.filter(x=>x.to===t.id&&(x.machine||x.picked||depStarted(x))).length,tasksFrom:liveTasks.filter(x=>x.from===t.id).length,trip:this.tripOf(t.delivery,visible)};});
    this.scheduleSnapshot(result,cal,allTrucks,products);
    result.alerts=this.alertsView(result,{allContainers,allBalances,operations,cal});
    // What is stacked on each stillage of this page (the whole pile above it, nearest first) with any live movement, so the page can offer
    // and explain pile loads even when a stillage above sits on another page of the container list.
    {const onTop=new Map(),moving=new Map();for(const o of allContainers)if(o.support){let l=onTop.get(o.support);if(!l)onTop.set(o.support,l=[]);l.push(o);}for(const t of liveTasks)if(t.container&&!moving.has(t.container))moving.set(t.container,t);result.stacksAbove={};for(const c of containers){const q=[...(onTop.get(c.id)??[])],above=[];while(q.length&&above.length<50){const o=q.shift(),t=moving.get(o.id);above.push({id:o.id,name:o.name,support:o.support,task:t?{id:t.id,to:t.to,state:t.state,type:t.type}:null});q.push(...(onTop.get(o.id)??[]));}if(above.length)result.stacksAbove[c.id]=above;}}
    if(lean){result.catalogueRev=catalogueRevision(this.db,this.user.company_id);if(opts.catalogue===result.catalogueRev)delete result.products;}
    return result;
  }
  // Dates, run trucks and clashes on yard lists and single requests (A3); each truck gets its next runs. Built from the views already computed.
  scheduleSnapshot(result,cal,allTrucks,products){
    result.calendar=cal;const perms=this.auth.permissions(this.user),truckNames=new Map(allTrucks.map(t=>[t.id,t.name])),truckName=id=>truckNames.get(id)??null,productNames=new Map(products.map(p=>[p.id,p.name]));
    const sitesById=new Map(this.repo.all('site').map(s=>[s.id,s])),ctx={perms,truckName,siteOf:id=>sitesById.get(id)??null};
    result.requests=result.requests.map(r=>r.loadList?{...r,neededOn:null,slot:null,urgency:null}:{...r,name:`${r.quantity} × ${productNames.get(r.product)??'material'}`,...this.scheduleFields(r,cal,ctx)});
    const items=[...result.loadLists,...result.requests.filter(r=>!r.loadList)],byId=new Map(items.map(x=>[x.id,x])),clashes=this.clashIndex(perms.includes('operations.manage')?[...items,...result.requests.filter(r=>r.loadList)]:undefined);
    for(const x of items){const c=clashes.get(x.id);x.clash=c?.count??0;x.clashWith=(c?.with??[]).filter(id=>byId.has(id)).map(id=>{const o=byId.get(id);return {id,kind:o.kind,name:o.name,siteName:o.siteName,slot:o.slot};});}
    const runs=new Map();for(const x of items){if(!x.schedulable||!x.runTruck)continue;let a=runs.get(x.runTruck);if(!a)runs.set(x.runTruck,a=[]);a.push(x);}
    result.trucks=result.trucks.map(t=>{const all=(runs.get(t.id)??[]).sort(runOrder);return {...t,runsBooked:all.length,nextRuns:all.slice(0,6).map(x=>({id:x.id,kind:x.kind,name:x.name,site:x.site,siteName:x.siteName,neededOn:x.neededOn,slot:x.slot,urgency:x.urgency,status:x.status,reserved:x.truck===t.id,pieces:x.kind==='loadList'?x.requested:x.quantity,clash:x.clash}))};});
  }
  history(limit=100,after=0){integer(limit,'Page size',1,200);integer(after,'History cursor',0,Number.MAX_SAFE_INTEGER);return this.scopedHistory(limit,after);}
  scopedHistory(limit,after){if(this.auth.permissions(this.user).includes('operations.manage'))return this.repo.history(limit,after);return cached(this.db,`SELECT l.* FROM ledger l WHERE l.company_id=? AND l.sequence>? AND EXISTS(SELECT 1 FROM objects s WHERE s.company_id=l.company_id AND s.kind='site' AND json_extract(s.data,'$.supervisor')=? AND (s.id=l.source OR s.id=l.destination OR EXISTS(SELECT 1 FROM objects t WHERE t.company_id=l.company_id AND t.id=l.task_id AND json_extract(t.data,'$.handling')=s.id))) ORDER BY l.sequence LIMIT ?`).all(this.user.company_id,after,this.user.id,limit);}
  export(kind){const snapshot=this.snapshot();const name=id=>snapshot.products.find(p=>p.id===id)?.name??id;if(kind==='register'){return csv([['Product','System','Category','In yard','At sites','On trucks','Total','Reserved','Available','Containers'],...snapshot.register.map(r=>[r.name,r.system,r.category,r.yard,r.site,r.truck,r.quantity,r.reserved,r.available,r.containers])]);}if(kind==='additions'||kind==='removals'){return csv([['Sequence','Event','Product','Container','Quantity','Location','Reason','Time'],...this.stockLog(kind,1000).map(l=>[l.sequence,l.event,name(l.product_id),l.container_id,l.quantity,l.destination??l.source,l.reason,l.created_at])]);}if(kind==='yardlist'){return csv([['Yard list','Status','Needed on','Window','Site','Truck','Product','Requested','Reserved','Loaded','Delivered','Line status'],...snapshot.loadLists.flatMap(l=>l.lines.map(x=>[l.name,l.status,l.neededOn??'',l.slot??'ANY',l.site,l.truckName,x.name,x.quantity,x.reserved,x.loaded,x.delivered,x.status]))]);}if(kind==='stock'){for(let page=1;page*100<snapshot.containerCount;page++){const next=this.snapshot(page);snapshot.balances.push(...next.balances);snapshot.containers.push(...next.containers);}const rows=[['Product','Container','Location','Condition','Physical quantity','Reserved quantity'],...snapshot.balances.map(l=>[snapshot.products.find(p=>p.id===l.product_id)?.name,snapshot.containers.find(c=>c.id===l.container)?.name,l.location,l.condition,l.quantity,l.reserved])];return csv(rows);}return csv([['Sequence','Event','Product','Container','Quantity','From','To','Reason','Time'],...this.scopedHistory(10000,0).map(l=>[l.sequence,l.event,l.product_id,l.container_id,l.quantity,l.source,l.destination,l.reason,l.created_at])]);}
}
Object.assign(Simulation.prototype,catalogueMethods,inventoryMethods,logisticsMethods,movementMethods,workerMethods,forkliftMethods,materialsMethods,fleetMethods,layoutMethods,jobMethods,turningMethods,scheduleMethods,alertMethods,reportsMethods);
function csv(rows){return rows.map(row=>row.map(value=>'"'+String(value??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"').join(',')).join('\r\n');}

// Everything a tick moves besides yard jobs (movement.js tick: advanceWorkers, advanceForklifts, trucks, tasks). With none of it those phases are
// no-ops, so only tickJobs runs. Truthiness is read conservatively (anything not null/false counts as set): when unsure, the full tick runs.
const SET=p=>`coalesce(json_type(data,'${p}'),'null') NOT IN ('null','false')`,FINITE=p=>`coalesce(json_type(data,'${p}'),'') IN ('integer','real')`;
const CONFIG="SELECT data FROM objects WHERE company_id=? AND kind='config' ORDER BY rowid LIMIT 1";
const paused=(db,company)=>{const row=cached(db,CONFIG).get(company);if(!row)return true;const config=JSON.parse(row.data);return !config||!!config.paused;};
const PROBE=`SELECT (SELECT data FROM objects WHERE company_id=?1 AND kind='config' ORDER BY rowid LIMIT 1) config,
 EXISTS(SELECT 1 FROM objects WHERE company_id=?1 AND kind='task' AND coalesce(json_extract(data,'$.state'),'') NOT IN ('COMPLETE','CANCELLED','FAILED','BLOCKED'))
 OR EXISTS(SELECT 1 FROM objects WHERE company_id=?1 AND kind='truck' AND json_extract(data,'$.status')='IN_TRANSIT')
 OR EXISTS(SELECT 1 FROM objects WHERE company_id=?1 AND kind='resource' AND ${SET('$.enabled')} AND (${SET('$.walk')} OR ${SET('$.drive')} OR (json_extract(data,'$.type') IN ('WORKER','FORKLIFT') AND NOT (${FINITE('$.x')} AND ${FINITE('$.y')})))) moving`;
function tickCompany(db,row,elapsed){
  const probe=cached(db,PROBE).get(row.company_id),config=probe.config===null?null:JSON.parse(probe.config);if(!config||config.paused)return 'paused';
  const sim=new Simulation(db,row);if(probe.moving){sim.tick(elapsed);return 'full';}sim.tickJobs(elapsed);return 'jobs';
}
export function startScheduler(db){
  const owner=randomUUID(),now=Date.now();
  atomic(db,()=>{const lease=cached(db,'SELECT * FROM engine_lease WHERE id=1').get();requireRule(!lease||lease.expires_at<now,'Another movement engine is running for this database.');cached(db,'INSERT INTO engine_lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at').run(owner,now+5000);});
  const own=()=>{if(cached(db,'SELECT owner FROM engine_lease WHERE id=1').get()?.owner!==owner){const error=new AppError(409,'Movement engine lease lost.');error.lease=true;throw error;}};
  let expires=now+5000,stopped=false,timer=null;const renew=()=>{if(expires-Date.now()<3500)expires=atomic(db,()=>{own();const at=Date.now()+5000;cached(db,'UPDATE engine_lease SET expires_at=? WHERE owner=?').run(at,owner);return at;});};
  const log=error=>console.error(JSON.stringify({event:'scheduler_error',message:error.message}));
  // Timers advance only their fixed quantum. No elapsed downtime is replayed. One transaction per company, yielding between them; rounds never overlap.
  const round=async()=>{const started=Date.now();
    try{own();renew();
      for(const row of cached(db,'SELECT ur.company_id,ur.user_id id FROM user_roles ur WHERE ur.role=? GROUP BY ur.company_id').all('OWNER')){
        if(stopped)return;if(paused(db,row.company_id))continue;// tick() returns at once for these: no transaction needed
        renew();try{atomic(db,()=>{own();tickCompany(db,row,250);});}catch(error){if(error.lease)throw error;log(error);}
        await new Promise(resolve=>setImmediate(resolve));}
    }catch(error){log(error);}
    finally{if(!stopped){timer=setTimeout(round,Math.max(0,started+250-Date.now()));timer.unref();}}};
  timer=setTimeout(round,250);timer.unref();
  return ()=>{if(stopped)return;stopped=true;clearTimeout(timer);try{flushJobTimers(db);}catch(error){log(error);}cached(db,'DELETE FROM engine_lease WHERE owner=?').run(owner);};
}
export { tickCompany };
