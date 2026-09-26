import { cached } from '../database.js';
import { catalogueRevision } from '../repository.js';
import { dayLabel } from './schedule.js';
// Alerts and minimum stock levels. A product's minimum ('keep at least N in the yard') is stored with the company's product settings (override, minYard);
// effectiveProducts carries it as p.minYard. Everything here is derived: alertsView builds the snapshot's alerts from what the snapshot already computed (no writes),
// alCheck keeps the set of materials below their minimum and adds one notification when a material first drops below it (never again until it recovers).
// The yard figure is the free count: serviceable pieces in the yard (and on its machines) not reserved for a load, the same number the Home card shows as 'free'.
export const AL_SEVERITY=['high','medium','low'];
const RANK={high:0,medium:1,low:2},KIND_RANK={BLOCKED:0,OVERDUE:1,CLASH:2,LOW_STOCK:3,DUE_TODAY:4,DAMAGED:5};
const plural=(n,one,many)=>n+' '+(n===1?one:many);
// Free pieces per product over the yards, from a stockByLocation block map (each yard clamped at zero on its own, as the Home card adds them).
export function alFreeInYards(stock,yardIds){const free=new Map();for(const id of yardIds)for(const r of stock?.[id]?.rows??[])free.set(r.product,(free.get(r.product)??0)+(r.free??Math.max(0,r.quantity-(r.reserved??0)-(r.unserviceable??0))));return free;}
// Live products with a minimum above what the yard holds free: id -> {min, free, short}.
export function alBelow(products,free){const out=new Map();for(const p of products){if(p.retired||!(p.minYard>0))continue;const f=free.get(p.id)??0;if(f<p.minYard)out.set(p.id,{min:p.minYard,free:f,short:p.minYard-f});}return out;}
// Ordered: most severe first, then by kind, then by the time pressure (days late), then name.
export const alSort=(a,b)=>RANK[a.severity]-RANK[b.severity]||KIND_RANK[a.kind]-KIND_RANK[b.kind]||(b.daysLate??0)-(a.daysLate??0)||String(a.title).localeCompare(String(b.title));
const alMinMemo=new WeakMap(),watermarks=new WeakMap();// db -> company -> 'ledger sequence|catalogue revision' last checked by alCheck
const listDone=l=>['DELIVERED','CANCELLED','IN_TRANSIT','AT_SITE'].includes(l.status);
const unreserved=x=>x.kind==='loadList'?['OPEN','PARTIAL'].includes(x.status):['REQUESTED','PARTIALLY ALLOCATED'].includes(x.status);
export const alertMethods={
  // Products with a minimum, from the cached catalogue: id -> {min, name}. Memoised per catalogue list (a new list comes with every catalogue revision).
  alMinimums(){const list=this.catalogue().list;let m=alMinMemo.get(list);if(!m){m=new Map();for(const p of list)if(!p.retired&&p.minYard>0)m.set(p.id,{min:p.minYard,name:p.name});alMinMemo.set(list,m);}return m;},
  // Free pieces in the yards now, company wide (never the viewer's scope), for the given product ids only.
  alYardFree(ids){const free=new Map();if(!ids.size)return free;const yards=new Set(this.repo.all('yard').map(y=>y.id)),machineAt=new Map(this.repo.all('resource').map(r=>[r.id,r.location]));
    const at=new Map();for(const c of this.containers()){const loc=machineAt.has(c.location)?machineAt.get(c.location):c.location;if(yards.has(loc))at.set(c.id,{yard:loc,bad:c.condition!=='SERVICEABLE'});}
    const held=new Map(),key=(y,p)=>y+'|'+p,cell=k=>{let v=held.get(k);if(!v)held.set(k,v={q:0,r:0,u:0});return v;};
    for(const row of cached(this.db,'SELECT container_id,product_id,quantity FROM contents WHERE company_id=? AND quantity>0').all(this.user.company_id)){const c=at.get(row.container_id);if(!c||!ids.has(row.product_id))continue;const v=cell(key(c.yard,row.product_id));v.q+=row.quantity;if(c.bad)v.u+=row.quantity;}
    for(const r of this.repo.all('reservation')){if(!r.active||!ids.has(r.product))continue;const c=at.get(r.container);if(c)cell(key(c.yard,r.product)).r+=r.quantity;}
    for(const [k,v] of held){const p=k.slice(k.indexOf('|')+1);free.set(p,(free.get(p)??0)+Math.max(0,v.q-v.r-v.u));}return free;},
  // Runs after every command (and after a tick that wrote the ledger or changed the catalogue): records which materials are below their minimum and notifies
  // once per drop. quiet: a product whose minimum this command just set (the owner knows; no notification for it). gate: skip when nothing it reads changed.
  alCheck({quiet=null,gate=false}={}){
    let byCompany=watermarks.get(this.db);if(!byCompany)watermarks.set(this.db,byCompany=new Map());
    const mark=(cached(this.db,'SELECT MAX(sequence) s FROM ledger WHERE company_id=?').get(this.user.company_id)?.s??0)+'|'+catalogueRevision(this.db,this.user.company_id);
    if(gate&&byCompany.get(this.user.company_id)===mark)return null;
    // An alert must never cost the owner a command or a tick: a failure here is logged and undone on its own.
    this.db.exec('SAVEPOINT al_check');
    try{const mins=this.alMinimums(),rec=this.repo.all('alertState')[0]??null,was=rec?.below??[];let below=null;
      if(mins.size||was.length){const free=this.alYardFree(new Set(mins.keys())),before=new Set(was);below=[...mins].filter(([id,m])=>(free.get(id)??0)<m.min).map(([id])=>id).sort();
        for(const id of below){if(before.has(id)||id===quiet)continue;const m=mins.get(id),f=free.get(id)??0;this.notify('Below minimum stock',`${m.name}: ${f} free in the yard, below your minimum of ${m.min}${f?'':' (none left)'}. ${m.min-f} short.`,null);}
        if(below.join(',')!==[...was].sort().join(','))rec?this.repo.save({...rec,below}):this.repo.add('alertState',{below});}
      this.db.exec('RELEASE al_check');byCompany.set(this.user.company_id,mark);return below;}
    catch(error){this.db.exec('ROLLBACK TO al_check');this.db.exec('RELEASE al_check');this.repo.cache=null;console.error(JSON.stringify({event:'alert_check_error',message:error.message}));return null;}
  },
  // The snapshot's alerts, from its own views (scoped like them: a supervisor sees only the lists, moves, stillages and trucks of their sites; minimum stock is a yard matter for operations roles).
  alertsView(result,{allContainers,allBalances,operations,cal}){
    const items=[],below={};const today=cal.today;
    if(operations){const free=alFreeInYards(result.stock,result.yards.map(y=>y.id));for(const [id,b] of alBelow(result.products??[],free)){below[id]=b;const p=result.products.find(x=>x.id===id);items.push({id:'LOW_STOCK:'+id,kind:'LOW_STOCK',severity:b.free===0?'high':'medium',title:p.name,detail:(b.free?b.free+' free in the yard':'None free in the yard')+' · keep at least '+b.min+' · '+b.short+' short',target:{view:'MATERIALS',id},product:id,system:p.system,category:p.category,...b});}}
    const runs=[...result.loadLists,...result.requests.filter(r=>!r.loadList)];
    for(const x of runs){if(!x.schedulable||(x.kind==='loadList'&&listDone(x)))continue;const what=x.kind==='loadList'?'Yard list':'Request',label=x.kind==='loadList'?x.name:x.name??'Request';
      const reserved=unreserved(x)?(x.status==='PARTIAL'||x.status==='PARTIALLY ALLOCATED'?'partly reserved':'nothing reserved yet'):'reserved'+(x.truckName??x.runTruckName?' on '+(x.truckName??x.runTruckName):'');
      if(x.urgency==='OVERDUE')items.push({id:'OVERDUE:'+x.id,kind:'OVERDUE',severity:'high',title:label,detail:what+' for '+(x.siteName??'a site')+' · was needed '+dayLabel(x.neededOn)+' ('+plural(x.daysLate,'day','days')+' late) · '+reserved,target:{view:'SCHEDULE',id:x.id,day:x.neededOn},daysLate:x.daysLate,site:x.site});
      else if(x.urgency==='TODAY'&&unreserved(x))items.push({id:'DUE_TODAY:'+x.id,kind:'DUE_TODAY',severity:'medium',title:label,detail:what+' for '+(x.siteName??'a site')+' · needed today'+(x.slot&&x.slot!=='ANY'?' ('+x.slot+')':'')+' · '+reserved,target:{view:'SCHEDULE',id:x.id,day:x.neededOn},site:x.site});}
    const clashes=new Map();for(const x of runs){if(!x.clash||!x.schedulable||!x.runTruck||!x.neededOn)continue;const k=x.runTruck+'|'+x.neededOn;let g=clashes.get(k);if(!g)clashes.set(k,g={truck:x.runTruck,truckName:x.runTruckName??'A truck',day:x.neededOn,runs:[],hidden:false});g.runs.push(x);if(x.clashWith.length<x.clash)g.hidden=true;}
    for(const g of clashes.values()){const sites=[...new Set(g.runs.map(x=>x.siteName??'a site'))];const first=g.runs[0];items.push({id:'CLASH:'+g.truck+':'+g.day,kind:'CLASH',severity:g.day<=today?'high':'medium',title:g.truckName+' booked twice on '+dayLabel(g.day),detail:'Runs to '+sites.join(' and ')+(g.hidden?' and another site':'')+' in the same window · move one to another truck or day',target:{view:'SCHEDULE',id:first.id,day:g.day},truck:g.truck,day:g.day});}
    for(const t of result.tasks){if(t.state!=='BLOCKED')continue;items.push({id:'BLOCKED:'+t.id,kind:'BLOCKED',severity:'high',title:(t.containerName??'A stillage')+' move is blocked',detail:t.reason??'Waiting for a retry.',target:{view:'ACTIVITY',id:t.id},task:t.id});}
    const pieces=new Map();for(const l of allBalances)if(l.condition!=='SERVICEABLE'&&l.quantity>0)pieces.set(l.container,(pieces.get(l.container)??0)+l.quantity);
    if(pieces.size){const names=new Map([...result.yards,...result.sites,...result.trucks,...result.resources].map(o=>[o.id,o]));for(const [i,c] of allContainers.entries()){const n=pieces.get(c.id);if(!n)continue;const loc=names.get(c.location),machine=loc?.type&&loc.location?names.get(loc.location):null,where=machine??loc;
      items.push({id:'DAMAGED:'+c.id,kind:'DAMAGED',severity:'low',title:c.name+' is '+String(c.condition).toLowerCase(),detail:plural(n,'piece','pieces')+' held in it'+(where?' · '+(where.kind==='truck'?'on ':'at ')+where.name:'')+' · check it, repair or move the stock out',target:{view:where?.kind==='site'?'SITES':where?.kind==='truck'?(where.payload>=10000000?'TRUCK12':'TRUCK2'):'HOME',id:c.id,at:where?.id??null,page:Math.floor(i/100)},container:c.id,condition:c.condition,pieces:n});}}
    items.sort(alSort);const counts={high:0,medium:0,low:0};for(const a of items)counts[a.severity]++;
    return {count:items.length,counts,items:items.slice(0,200),below};
  }
};
