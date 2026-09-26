import { requireRule } from './geometry.js';
import { active } from './inventory.js';
import { AppError } from '../service.js';
import { cached } from '../database.js';
import { scheduleMethods,parseDay,parseSlot,urgencyOf,dayLabel } from './schedule.js';
import { alSort } from './alerts.js';
// Scheduled returns (collections): stock booked to come back from a site to the yard. A collection names what to collect (everything on the site,
// or chosen stillages / cages), the day it is needed (the same date rules as yard lists: parseDay / parseSlot) and, once the office books one, a truck.
// Nothing moves by itself: 'Load collection' queues the site's stillages onto the booked truck through loadTruck (the site crane and crew lift them,
// custody step by step), the office dispatches the truck and unloads it at the yard like any other trip. rtSync follows those steps after every
// command and every placement and moves the status on:
//   REQUESTED (no truck) -> BOOKED (truck booked) -> LOADING (moves queued) -> ON THE WAY (the truck left the site with them) -> RETURNED (all placed)
//   or CANCELLED. The delivery record of the trip back carries collection = id, and the collection keeps delivery = that trip.
export const RT_OPEN=['REQUESTED','BOOKED','LOADING','ON THE WAY'];
export const RT_EDITABLE=['REQUESTED','BOOKED'];// date and truck can still change
const base=scheduleMethods;
const plural=(n,one,many)=>n+' '+(n===1?one:many);
const notes=v=>{if(v===undefined||v===null)return '';requireRule(typeof v==='string','Notes must be text.');const s=v.trim();requireRule(s.length<=500,'Notes can be at most 500 characters.');return s;};
const slotWords=s=>s==='AM'||s==='PM'?' ('+s+')':'';
export const collectionMethods={
  // ---------- labels ----------
  rtSiteName(id){try{return this.repo.get(id,'site').name;}catch{return 'a site';}},
  rtWhat(o){return o.scope==='ALL'?'everything on site':plural(o.containers.length,'stillage','stillages');},
  rtLabel(o){return 'Collection from '+this.rtSiteName(o.site);},
  // ---------- commands ----------
  // requests.create: the office or the site's own supervisor. Booking a truck at the same time is for the office only.
  requestCollection(input){
    requireRule(input&&typeof input==='object','Choose a site to collect from.');
    const site=this.repo.get(input.site,'site');this.assertSite(site.id);requireRule(site.status==='ACTIVE','Choose an active site.');
    const scope=input.scope===undefined||input.scope===null?'ALL':input.scope;requireRule(['ALL','SELECTED'].includes(scope),'Choose everything on site or the stillages to collect.');
    const cal=this.calendar(),neededOn=parseDay(input.neededOn,{required:true,cal}),slot=parseSlot(input.slot),text=notes(input.notes);
    const here=this.containers().filter(c=>c.location===site.id),ids=new Set(here.map(c=>c.id));let containers=[];
    if(scope==='SELECTED'){requireRule(Array.isArray(input.containers)&&input.containers.length>0&&input.containers.length<=100,'Tick the stillages and cages to collect (up to 100).');
      for(const id of input.containers)requireRule(typeof id==='string'&&ids.has(id),'Every stillage to collect must be on '+site.name+' now.');containers=[...new Set(input.containers)];}
    else requireRule(here.length>0,'Nothing is on '+site.name+' to collect.');
    for(const o of this.repo.all('collection')){if(o.site!==site.id||!['REQUESTED','BOOKED','LOADING'].includes(o.status))continue;
      if(o.scope==='ALL'||scope==='ALL')requireRule(false,'A collection from '+site.name+' is already booked for '+dayLabel(o.neededOn)+'. Change that one instead.');
      const both=containers.filter(id=>o.containers.includes(id));requireRule(!both.length,(here.find(c=>c.id===both[0])?.name??'A stillage')+' is already on the collection for '+dayLabel(o.neededOn)+'.');}
    let truck=null;if(input.truck!==undefined&&input.truck!==null&&input.truck!==''){if(!this.auth.permissions(this.user).includes('operations.manage'))throw new AppError(403,'Only the yard office can book a truck. Send the collection without one.');
      requireRule(typeof input.truck==='string','Choose a truck.');truck=this.repo.get(input.truck,'truck');requireRule(!truck.retired,truck.name+' has been removed.');}
    const now=new Date().toISOString();
    const o=this.repo.add('collection',{site:site.id,scope,containers,neededOn,slot,notes:text,status:truck?'BOOKED':'REQUESTED',plannedTruck:truck?.id??null,truck:null,tasks:[],taken:[],left:[],pieces:null,delivery:null,actor:this.user.id,createdAt:now,bookedAt:truck?now:null,bookedBy:truck?this.user.id:null});
    const message='Collection from '+site.name+' booked for '+dayLabel(neededOn)+slotWords(slot)+': '+this.rtWhat(o)+(truck?' on '+truck.name:'')+'.'+(truck?'':' It needs a truck.');
    this.notify('Collection requested',message,site.id);return {...o,message};
  },
  // Cancels a collection that has not left the site. Loading moves not started yet are cancelled; a stillage already on the truck stays there (it never teleports back).
  cancelCollection(input){
    const o=this.repo.get(input?.id,'collection');this.assertSite(o.site);requireRule(['REQUESTED','BOOKED','LOADING'].includes(o.status),o.status==='CANCELLED'?'This collection is already cancelled.':o.status==='RETURNED'?'This collection is already back at the yard.':'The truck has left the site with this collection. Unload it at the yard.');
    const reason=notes(input.reason);let kept=0;
    if(o.status==='LOADING'){const tasks=this.tasks().filter(t=>o.tasks.includes(t.id)&&active(t));requireRule(!tasks.some(t=>t.picked),'A stillage is on the crane right now. Let it land on the truck, then cancel.');
      for(const t of tasks.reverse()){t.state='CANCELLED';this.repo.save(t);this.release(t);}kept=o.taken.filter(id=>{try{return this.repo.get(id,'container').location===o.truck;}catch{return false;}}).length;}
    o.status='CANCELLED';o.cancelledAt=new Date().toISOString();o.cancelledBy=this.user.id;o.reason=reason||null;this.repo.save(o);
    const message=this.rtLabel(o)+' cancelled.'+(kept?' '+plural(kept,'stillage is','stillages are')+' already on the truck: unload it at the site or bring it back.':'');
    this.notify('Collection cancelled',message,o.site);return {...o,message};
  },
  // operations.manage: the booked truck (or input.truck) must be parked at the site. Each pile goes through loadTruck on its own (in a savepoint), so a pile
  // that does not fit or cannot be lifted stays on site with its reason while the rest load. Nothing loads -> nothing changes.
  loadCollection(input){
    const o=this.repo.get(input?.id,'collection');this.assertSite(o.site);requireRule(RT_EDITABLE.includes(o.status),o.status==='LOADING'?'This collection is already loading.':'This collection is '+o.status.toLowerCase()+'.');
    const site=this.repo.get(o.site,'site'),truckId=input.truck??o.plannedTruck;requireRule(typeof truckId==='string','Book a truck for this collection first.');
    const t=this.repo.get(truckId,'truck');requireRule(!t.retired,t.name+' has been removed.');requireRule(t.status==='AT_SITE'&&t.at===site.id,t.name+' is not at '+site.name+' yet. Send it there from its truck page, then load the collection.');
    const here=this.containers().filter(c=>c.location===site.id),byId=new Map(here.map(c=>[c.id,c]));
    const want=o.scope==='ALL'?here.filter(c=>!c.support||!byId.has(c.support)):o.containers.map(id=>byId.get(id)).filter(Boolean);
    requireRule(want.length,o.scope==='ALL'?'Nothing is on '+site.name+' to collect.':'None of the stillages on this collection are on '+site.name+' any more. Cancel it.');
    const busy=new Set(this.tasks().filter(x=>active(x)&&x.to===t.id).map(x=>x.container)),tasks=[],left=[],taken=new Set();
    for(const c of want){if(taken.has(c.id)||busy.has(c.id))continue;
      this.db.exec('SAVEPOINT rt_pile');
      try{const r=this.loadTruck({truck:t.id,containers:[c.id]});this.db.exec('RELEASE rt_pile');for(const x of r.tasks){tasks.push(x);taken.add(x.container);}}
      catch(error){this.db.exec('ROLLBACK TO rt_pile');this.db.exec('RELEASE rt_pile');if(!error.status)throw error;left.push({id:c.id,name:c.name,reason:error.message});}}
    if(!tasks.length)requireRule(false,left.length?'Nothing could be loaded. '+left[0].name+': '+left[0].reason:'Nothing to load: every stillage on this collection is already on '+t.name+'.');
    const pieces=[...taken].reduce((s,id)=>s+this.repo.lines(id).reduce((n,l)=>n+l.quantity,0),0);
    Object.assign(o,{status:'LOADING',truck:t.id,plannedTruck:t.id,tasks:tasks.map(x=>x.id),taken:[...taken],left,pieces,loadingAt:new Date().toISOString(),loadedBy:this.user.id});this.repo.save(o);
    const names=[...taken].map(id=>byId.get(id)?.name??'stillage');
    const message='Loading '+plural(names.length,'stillage','stillages')+' ('+names.slice(0,6).join(', ')+(names.length>6?' +'+(names.length-6)+' more':'')+') onto '+t.name+' at '+site.name+'. The site crew and crane will do it.'+(left.length?' Left on site: '+left.map(x=>x.name+' ('+x.reason.replace(/\.$/,'')+')').join('; ')+'.':'');
    this.notify('Collection loading',message,site.id);return {id:o.id,status:o.status,tasks,left,message};
  },
  // ---------- following the engine ----------
  // After every command (execute) and every placement (reconcileDeliveries). Cheap when there is nothing open.
  rtSync(){
    const open=this.repo.all('collection').filter(o=>RT_OPEN.includes(o.status));if(!open.length)return;
    const now=()=>new Date().toISOString(),where=id=>{try{const c=this.repo.get(id,'container');if(c.retired)return {kind:'gone'};const at=this.repo.get(c.location);return {kind:at.kind,id:at.id};}catch{return {kind:'gone'};}};
    for(const o of open){let changed=false;
      if(RT_EDITABLE.includes(o.status)){
        let site=null;try{site=this.repo.get(o.site,'site');}catch{}
        if(!site||site.status!=='ACTIVE'){o.status='CANCELLED';o.cancelledAt=now();o.reason='The site was archived.';changed=true;}
        else if(o.plannedTruck){let t=null;try{t=this.repo.get(o.plannedTruck,'truck');}catch{}if(!t||t.retired){o.plannedTruck=null;o.status='REQUESTED';changed=true;this.notify('Truck booking removed',(t?.name??'The truck')+' was removed; '+this.rtLabel(o)+' needs a truck again.',o.site);}else if(o.status!=='BOOKED'){o.status='BOOKED';changed=true;}}
        else if(o.status!=='REQUESTED'){o.status='REQUESTED';changed=true;}
      }else if(o.status==='LOADING'){
        let t=null;try{t=this.repo.get(o.truck,'truck');}catch{}
        const on=o.taken.filter(id=>where(id).id===o.truck),live=this.tasks().some(x=>o.tasks.includes(x.id)&&active(x));
        if(t&&(t.status==='IN_TRANSIT'||t.at!==o.site)){
          if(on.length){o.status='ON THE WAY';o.taken=on;o.delivery=t.delivery??null;o.departedAt=now();o.pieces=on.reduce((s,id)=>s+this.repo.lines(id).reduce((n,l)=>n+l.quantity,0),0);changed=true;
            if(o.delivery){try{const d=this.repo.get(o.delivery,'delivery');if(d.collection!==o.id){d.collection=o.id;this.repo.save(d);}}catch{}}
            let to='the yard';try{to=this.repo.get(t.destination??t.at).name;}catch{}this.notify('Collection on the way',t.name+' left '+this.rtSiteName(o.site)+' with '+plural(on.length,'stillage','stillages')+' for '+to+'.',o.site);}
          else{Object.assign(o,{status:'BOOKED',truck:null,tasks:[],taken:[],pieces:null});changed=true;this.notify('Collection not loaded',(t?.name??'The truck')+' left '+this.rtSiteName(o.site)+' without the collection. It is booked again.',o.site);}}
        else if(!live&&!on.length&&!o.taken.some(id=>where(id).kind==='resource')){Object.assign(o,{status:'BOOKED',truck:null,tasks:[],taken:[],pieces:null});changed=true;}// its loading moves were cancelled
      }else if(o.status==='ON THE WAY'){
        const spots=o.taken.map(where);if(spots.every(s=>s.kind==='yard'||s.kind==='site'||s.kind==='gone')){const inYard=spots.filter(s=>s.kind==='yard').length;
          Object.assign(o,{status:'RETURNED',returnedAt:now(),inYard,returnedTo:[...new Set(spots.filter(s=>s.id).map(s=>s.id))]});changed=true;
          this.notify('Collection returned',this.rtLabel(o)+': '+plural(inYard,'stillage','stillages')+(o.pieces?' ('+o.pieces+' pcs)':'')+' back in the yard'+(inYard<spots.length?'; '+(spots.length-inYard)+' went elsewhere':'')+'.',o.site);}
      }
      if(changed)this.repo.save(o);}
  },
  // ---------- schedule integration: collections are runs like yard lists and single requests ----------
  schedulable(o){return o.kind==='collection'?RT_EDITABLE.includes(o.status):base.schedulable.call(this,o);},
  scheduleTarget(id){requireRule(typeof id==='string'&&id.length>0,'Choose a yard list or request to schedule.');const o=this.repo.get(id);if(o.kind!=='collection')return base.scheduleTarget.call(this,id);this.assertSite(o.site);return o;},
  assertSchedulable(o){if(o.kind!=='collection')return base.assertSchedulable.call(this,o);requireRule(o.status!=='CANCELLED','This collection is cancelled.');requireRule(o.status!=='RETURNED','This collection is already back at the yard.');requireRule(RT_EDITABLE.includes(o.status),o.status==='LOADING'?'This collection is loading. Its date and truck can no longer change.':'This collection has left the site. Its date and truck can no longer change.');},
  scheduleLabel(o){return o.kind==='collection'?this.rtLabel(o):base.scheduleLabel.call(this,o);},
  reschedule(input){const o=this.scheduleTarget(input?.id);if(o.kind!=='collection')return base.reschedule.call(this,input);this.assertSchedulable(o);
    const cal=this.calendar(),neededOn=parseDay(input.neededOn,{required:true,cal}),slot=input.slot===undefined?(o.slot??'ANY'):parseSlot(input.slot),label=this.rtLabel(o),urgency=urgencyOf(neededOn,false,cal).urgency;
    if(neededOn===o.neededOn&&slot===(o.slot??'ANY'))return {id:o.id,kind:'collection',neededOn,slot,urgency,changed:false,message:label+' is already needed '+dayLabel(neededOn)+slotWords(slot)+'.'};
    const prev=o.neededOn;o.previousNeededOn=prev;o.neededOn=neededOn;o.slot=slot;o.rescheduledAt=new Date().toISOString();o.rescheduledBy=this.user.id;this.repo.save(o);
    const message=label+': now needed '+dayLabel(neededOn)+slotWords(slot)+(prev&&prev!==neededOn?' (was '+dayLabel(prev)+')':'')+'.';this.notify('Collection rescheduled',message,o.site);
    return {id:o.id,kind:'collection',neededOn,slot,urgency,changed:true,message};},
  bookTruck(input){const o=this.scheduleTarget(input?.id);if(o.kind!=='collection')return base.bookTruck.call(this,input);this.assertSchedulable(o);
    requireRule(input.truck===null||typeof input.truck==='string','Choose a truck.');const t=input.truck?this.repo.get(input.truck,'truck'):null;if(t)requireRule(!t.retired,t.name+' has been removed.');
    const want=t?.id??null,label=this.rtLabel(o),clashNow=()=>this.clashIndex().get(o.id)?.count??0;
    if((o.plannedTruck??null)===want){const clash=clashNow();return {id:o.id,kind:'collection',plannedTruck:want,plannedTruckName:t?.name??null,clash,changed:false,message:(t?label+' is already booked on '+t.name+'.':label+' has no truck booked.')+(clash?' Clash: it also runs to another site that day.':'')};}
    o.plannedTruck=want;o.status=want?'BOOKED':'REQUESTED';o.bookedAt=new Date().toISOString();o.bookedBy=this.user.id;this.repo.save(o);
    const clash=clashNow();let message=t?t.name+' booked for '+label+' on '+dayLabel(o.neededOn)+'.':label+' needs a truck again.';this.notify(t?'Truck booked':'Truck booking removed',message,o.site);if(clash)message+=' Clash: it also runs to another site that day.';
    return {id:o.id,kind:'collection',plannedTruck:want,plannedTruckName:t?.name??null,clash,changed:true,message};},
  // Clashes read collections too (rows given: the snapshot's own list, which already has them).
  clashIndex(rows){if(rows)return base.clashIndex.call(this,rows);
    return base.clashIndex.call(this,cached(this.db,"SELECT id,kind,json_extract(data,'$.site') site,json_extract(data,'$.neededOn') neededOn,json_extract(data,'$.slot') slot,json_extract(data,'$.truck') truck,json_extract(data,'$.plannedTruck') plannedTruck,json_extract(data,'$.cancelled') cancelled,json_extract(data,'$.delivery') delivery,json_extract(data,'$.status') status,json_extract(data,'$.loadList') loadList,json_extract(data,'$.delivered') delivered FROM objects WHERE company_id=? AND kind IN ('loadList','request','collection') AND json_extract(data,'$.neededOn') IS NOT NULL").all(this.repo.company));},
  // ---------- snapshot ----------
  // The viewer's collections (the office: all; a supervisor: their sites), every open one and the last 20 closed ones, in schedule-item shape.
  rtViews(cal,ctx){
    const ops=ctx.perms.includes('operations.manage'),mine=o=>ops||ctx.siteOf(o.site)?.supervisor===this.user.id;
    const all=this.repo.all('collection').filter(mine);if(!all.length)return [];
    const open=all.filter(o=>RT_OPEN.includes(o.status)),closed=all.filter(o=>!RT_OPEN.includes(o.status)).slice(-20),list=[...open,...closed];
    const containers=open.length?this.containers():[],byId=new Map(containers.map(c=>[c.id,c])),pcs=id=>this.repo.lines(id).reduce((n,l)=>n+l.quantity,0),trucks=new Map(this.repo.all('truck').map(t=>[t.id,t]));
    const liveTasks=open.some(o=>o.status==='LOADING'||o.status==='ON THE WAY')?this.tasks().filter(active):[];
    return list.map(o=>{const site=ctx.siteOf(o.site),closedNow=['ON THE WAY','RETURNED','CANCELLED'].includes(o.status),{urgency,daysLate}=urgencyOf(o.neededOn??null,closedNow,cal);
      const plannedTruck=o.plannedTruck??null,runTruck=o.truck??plannedTruck,editable=RT_EDITABLE.includes(o.status),rt=runTruck?trucks.get(runTruck):null;
      // What it collects: now (before loading) or what was taken.
      const ids=o.status==='REQUESTED'||o.status==='BOOKED'?(o.scope==='ALL'?containers.filter(c=>c.location===o.site).map(c=>c.id):o.containers):o.taken;
      const items=ids.map(id=>{const c=byId.get(id);return c?{id,name:c.name,type:c.type,pieces:pcs(id),at:c.location===o.site?'SITE':c.location===o.truck?'TRUCK':'OTHER'}:null;}).filter(Boolean);
      const missing=editable&&o.scope==='SELECTED'?o.containers.filter(id=>byId.get(id)?.location!==o.site).length:0;
      const pieces=editable?items.reduce((s,x)=>s+x.pieces,0):o.pieces??0,tasks=o.status==='LOADING'?liveTasks.filter(x=>o.tasks.includes(x.id)):[];
      const truckHere=!!rt&&rt.status==='AT_SITE'&&rt.at===o.site;
      return {id:o.id,kind:'collection',site:o.site,siteName:site?.name??null,scope:o.scope,status:o.status,name:o.scope==='ALL'?'Collect everything on site':'Collect '+plural(o.containers.length,'stillage','stillages'),
        neededOn:o.neededOn??null,slot:o.slot??'ANY',urgency,daysLate,plannedTruck,plannedTruckName:plannedTruck?ctx.truckName(plannedTruck):null,truck:o.truck??null,truckName:o.truck?ctx.truckName(o.truck):null,runTruck,runTruckName:runTruck?ctx.truckName(runTruck):null,
        schedulable:editable,canReschedule:editable&&ctx.perms.includes('requests.create')&&(ops||site?.supervisor===this.user.id),canCancel:['REQUESTED','BOOKED','LOADING'].includes(o.status)&&ctx.perms.includes('requests.create'),
        canLoad:editable&&ops&&truckHere&&items.length>0,truckUnloading:rt?liveTasks.some(x=>x.from===rt.id):false,truckHere,truckStatus:rt?.status??null,truckAt:rt?.at??null,truckDestination:rt?.destination??null,truckYard:rt?.yard??null,
        quantity:pieces,pieces,stillages:editable?items.length:o.taken.length,items:items.slice(0,60),missing,notes:o.notes??'',left:o.left??[],tasksLeft:tasks.length,loaded:o.status==='LOADING'?o.taken.filter(id=>byId.get(id)?.location===o.truck).length:0,
        delivery:o.delivery??null,createdAt:o.createdAt,bookedAt:o.bookedAt??null,loadingAt:o.loadingAt??null,departedAt:o.departedAt??null,returnedAt:o.returnedAt??null,cancelledAt:o.cancelledAt??null,reason:o.reason??null,inYard:o.inYard??null,requestedBy:this.supervisorName(o.actor)};});
  },
  // Overdue and unbooked-today collections join the alerts (and a clash that involves one is rebuilt with every site in it).
  rtAlerts(result){
    const list=result.collections??[],a=result.alerts;if(!list.length||!a)return;const items=[...a.items];
    for(const x of list){if(!['REQUESTED','BOOKED','LOADING'].includes(x.status))continue;const state=x.status==='LOADING'?'loading on '+(x.truckName??'a truck'):x.runTruck?'booked on '+(x.runTruckName??'a truck'):'no truck booked';
      if(x.urgency==='OVERDUE')items.push({id:'OVERDUE:'+x.id,kind:'OVERDUE',severity:'high',title:'Collection from '+(x.siteName??'a site'),detail:'Collection · was needed '+dayLabel(x.neededOn)+' ('+plural(x.daysLate,'day','days')+' late) · '+state,target:{view:'SCHEDULE',id:x.id,day:x.neededOn},daysLate:x.daysLate,site:x.site});
      else if(x.urgency==='TODAY'&&!x.runTruck)items.push({id:'DUE_TODAY:'+x.id,kind:'DUE_TODAY',severity:'medium',title:'Collection from '+(x.siteName??'a site'),detail:'Collection · needed today'+slotWords(x.slot)+' · no truck booked',target:{view:'SCHEDULE',id:x.id,day:x.neededOn},site:x.site});}
    const runs=[...(result.loadLists??[]),...(result.requests??[]).filter(r=>!r.loadList),...list],groups=new Map();
    for(const x of runs){if(!x.clash||!x.schedulable||!x.runTruck||!x.neededOn)continue;const k=x.runTruck+'|'+x.neededOn;let g=groups.get(k);if(!g)groups.set(k,g={truck:x.runTruck,truckName:x.runTruckName??'A truck',day:x.neededOn,runs:[],hidden:false,rt:false});g.runs.push(x);if((x.clashWith?.length??0)<x.clash)g.hidden=true;if(x.kind==='collection')g.rt=true;}
    for(const g of groups.values()){if(!g.rt)continue;const id='CLASH:'+g.truck+':'+g.day,at=items.findIndex(i=>i.id===id),sites=[...new Set(g.runs.map(x=>(x.siteName??'a site')+(x.kind==='collection'?' (collection)':'')))];
      const item={id,kind:'CLASH',severity:g.day<=(result.calendar?.today??'')?'high':'medium',title:g.truckName+' booked twice on '+dayLabel(g.day),detail:'Runs to '+sites.join(' and ')+(g.hidden?' and another site':'')+' in the same window · move one to another truck or day',target:{view:'SCHEDULE',id:g.runs[0].id,day:g.day},truck:g.truck,day:g.day};
      if(at>=0)items[at]=item;else items.push(item);}
    items.sort(alSort);const counts={high:0,medium:0,low:0};for(const i of items)counts[i.severity]++;
    result.alerts={...a,count:items.length,counts,items:items.slice(0,200)};
  }
};
