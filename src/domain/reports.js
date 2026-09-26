import { cached } from '../database.js';
import { AppError } from '../service.js';
import { calendarNow,addDays,mondayOf,localDay } from './schedule.js';
// History reports (GET /api/reports?days=30|90): read-only aggregates rebuilt from the append-only ledger, plus deliveries and current contents.
// The ledger is replayed once per company and then only its new rows (a per-company store keyed by the ledger's max sequence), so a report costs
// one indexed MAX() when nothing changed and a replay of the new rows otherwise. Built results are cached per period and scope until the next row.
//
// Where pieces are: every change to a container's contents writes a ledger row, and so does every custody move of a container that holds stock.
//  OPENING_BALANCE, PURCHASE          +quantity at destination (a yard / site, or the container's location)
//  STOCK_REMOVED, DEMO_PURGED         -quantity at source
//  STOCKTAKE_ADJUSTMENT               +variance (signed) where the counted container is
//  PICKUP, PLACEMENT, REPACK_PICKUP   quantity moves from source to destination (a machine counts where it works, a container where it sits)
//  CONSOLIDATED, SORTED               container to container inside one yard: no change to where pieces are
// A place is a yard or site id, 'truck:<id>' for anything on a truck, or 'other'. The yard total is the sum over yard places, the same rule the
// Stock register uses for its "In yard" column (stock on a forklift counts at the forklift's yard).
const ADD=new Set(['OPENING_BALANCE','PURCHASE']),REMOVE=new Set(['STOCK_REMOVED','DEMO_PURGED']),ADJUST='STOCKTAKE_ADJUSTMENT',MOVE=new Set(['PICKUP','PLACEMENT','REPACK_PICKUP']);
export const HC_EVENTS=[...ADD,...REMOVE,ADJUST,...MOVE];// CONSOLIDATED and SORTED are left out: they never change where pieces are
const KEEP_DAYS=100,BATCH=5000,TOP=8;
const stores=new WeakMap();// db -> company -> store
const fresh=()=>({seq:0,info:new Map(),loaded:false,locOf:new Map(),total:new Map(),day:new Map(),loads:new Map(),moved:new Map(),dayOf:new Map(),results:new Map()});
const loadInfo=(db,company)=>{const m=new Map();for(const r of cached(db,"SELECT id,kind,json_extract(data,'$.location') loc FROM objects WHERE company_id=? AND kind IN ('yard','site','truck','resource','container')").all(company))m.set(r.id,{kind:r.kind,loc:r.loc});return m;};
const inner=(map,key)=>{let m=map.get(key);if(!m)map.set(key,m=new Map());return m;};
const add=(map,key,n)=>map.set(key,(map.get(key)??0)+n);
const tally=(map,key)=>{let t=map.get(key);if(!t)map.set(key,t={out:0,back:0});return t;};
// Object info is read lazily: at most one reload per sync, and only when an id is not known yet (new containers, trucks, crews).
function info(st,db,company,id){let o=st.info.get(id);if(!o&&!st.loaded){st.info=loadInfo(db,company);st.loaded=true;o=st.info.get(id);}return o;}
function placeOf(st,db,company,id,depth=0){if(id==null||depth>4)return 'other';const o=info(st,db,company,id);if(!o)return 'other';if(o.kind==='yard'||o.kind==='site')return id;if(o.kind==='truck')return 'truck:'+id;if(o.kind==='resource')return placeOf(st,db,company,o.loc,depth+1);return placeOf(st,db,company,st.locOf.get(id)??o.loc,depth+1);}
const kindOf=(st,place)=>place.startsWith('truck:')?'truck':place==='other'?'other':st.info.get(place)?.kind??'other';
function dayOf(st,iso){const k=String(iso).slice(0,16);let d=st.dayOf.get(k);if(!d){if(st.dayOf.size>50000)st.dayOf.clear();d=localDay(new Date(iso));st.dayOf.set(k,d);}return d;}
function bump(st,place,n,day){if(!n)return;add(st.total,place,n);const kind=kindOf(st,place);if(kind==='yard'||kind==='site')add(inner(st.day,day),place,n);}
function apply(st,db,company,r){
  const q=r.quantity,day=dayOf(st,r.created_at),at=id=>placeOf(st,db,company,id);
  if(ADD.has(r.event)){bump(st,at(r.destination??r.container_id),q,day);if(r.container_id&&r.destination)st.locOf.set(r.container_id,r.destination);return;}
  if(REMOVE.has(r.event)){bump(st,at(r.source??r.container_id),-q,day);return;}
  if(r.event===ADJUST){bump(st,at(r.source??r.container_id),q,day);return;}// the count's scope: a yard, a site, or the counted container
  if(!MOVE.has(r.event))return;
  const from=at(r.source),to=at(r.destination);if(r.container_id&&r.destination)st.locOf.set(r.container_id,r.destination);
  if(from!==to){bump(st,from,-q,day);bump(st,to,q,day);}
  const fk=kindOf(st,from),tk=kindOf(st,to);
  // Loaded onto a truck: pieces the truck carried; loaded at a site = pieces sent back from that site. Taken off a truck at a site = delivered there.
  // moved keeps two totals per day, site and product (out = delivered to the site, back = sent back from it), so a same-day delivery and return never cancel out.
  if(r.event==='PLACEMENT'&&tk==='truck'){add(inner(st.loads,day),r.destination,q);if(fk==='site')tally(inner(inner(st.moved,day),from),r.product_id).back+=q;}
  else if(r.event==='PICKUP'&&fk==='truck'&&tk==='site')tally(inner(inner(st.moved,day),to),r.product_id).out+=q;
}
function sync(db,company,today){
  let byCompany=stores.get(db);if(!byCompany)stores.set(db,byCompany=new Map());let st=byCompany.get(company);if(!st)byCompany.set(company,st=fresh());
  const max=cached(db,'SELECT MAX(sequence) m FROM ledger WHERE company_id=?').get(company).m??0;if(max===st.seq&&st.today===today)return st;
  st.loaded=false;const sql=`SELECT sequence,event,product_id,container_id,quantity,source,destination,created_at FROM ledger WHERE company_id=? AND sequence>? AND sequence<=? AND product_id IS NOT NULL AND event IN (${HC_EVENTS.map(()=>'?').join(',')}) ORDER BY sequence LIMIT ${BATCH}`;
  for(let cursor=st.seq;;){const rows=cached(db,sql).all(company,cursor,max,...HC_EVENTS);for(const r of rows)apply(st,db,company,r);if(rows.length<BATCH)break;cursor=rows[rows.length-1].sequence;}
  const oldest=addDays(today,-KEEP_DAYS);for(const m of [st.day,st.loads,st.moved])for(const d of m.keys())if(d<oldest)m.delete(d);
  st.seq=max;st.today=today;st.results.clear();return st;
}
// Pieces held right now, per place, straight from the contents table (the same numbers the Stock register shows), with each product's system.
function liveStock(st,db,company){
  st.info=loadInfo(db,company);st.loaded=true;
  const rows=cached(db,"SELECT json_extract(o.data,'$.location') loc,json_extract(p.data,'$.system') system,SUM(ct.quantity) q FROM contents ct JOIN objects o ON o.company_id=ct.company_id AND o.id=ct.container_id JOIN objects p ON p.company_id=ct.company_id AND p.id=ct.product_id WHERE ct.company_id=? AND ct.quantity>0 GROUP BY loc,system").all(company);
  const where=loc=>{let id=loc;for(let i=0;i<4&&id;i++){const o=st.info.get(id);if(!o)return 'other';if(o.kind==='yard'||o.kind==='site')return id;if(o.kind==='truck')return 'truck:'+id;id=o.loc;}return 'other';};
  return rows.map(r=>({place:where(r.loc),system:r.system??'other',q:r.q}));
}
export const reportsMethods={
  reports(days=30){
    if(!Number.isInteger(days)||![30,90].includes(days))throw new AppError(400,'Choose a report period of 30 or 90 days.');
    const perms=this.auth.permissions(this.user),company=this.user.company_id,ops=perms.includes('operations.manage');
    if(!ops&&!perms.includes('sites.assigned'))throw new AppError(403,'Your role does not allow this action.');
    const cal=calendarNow(),today=cal.today,st=sync(this.db,company,today),key=days+'|'+(ops?'company':'u:'+this.user.id);
    const hit=st.results.get(key);if(hit)return hit;
    const result=this.buildReport(st,days,ops,cal);st.results.set(key,result);if(st.results.size>8)st.results.delete(st.results.keys().next().value);return result;
  },
  buildReport(st,days,ops,cal){
    const db=this.db,company=this.user.company_id,today=cal.today,from=addDays(today,-(days-1)),inWindow=d=>d>=from&&d<=today;
    const siteRows=cached(db,"SELECT id,json_extract(data,'$.name') name,json_extract(data,'$.supervisor') supervisor FROM objects WHERE company_id=? AND kind='site'").all(company);
    const mySites=new Set(siteRows.filter(s=>ops||s.supervisor===this.user.id).map(s=>s.id));
    const live=liveStock(st,db,company);// also refreshes st.info, so kindOf below knows every current place
    const counted=place=>ops?kindOf(st,place)==='yard':mySites.has(place);
    // Pieces per day: rebuilt now = the replayed total over the counted places; walk back one day at a time by that day's net change.
    let rebuilt=0;for(const [place,n] of st.total)if(counted(place))rebuilt+=n;
    const net=day=>{let s=0;const m=st.day.get(day);if(m)for(const [place,n] of m)if(counted(place))s+=n;return s;};
    let v=rebuilt;for(const d of st.day.keys())if(d>today)v-=net(d);
    const series=[];for(let d=today;d>=from;d=addDays(d,-1)){series.push({day:d,pieces:v});v-=net(d);}series.reverse();
    let actual=0;for(const r of live)if(counted(r.place))actual+=r.q;
    // Runs: trips from the delivery records. Deliveries carry cargo to a site, returns carry cargo back to a yard (empty drives are not counted).
    const kindAt=id=>st.info.get(id)?.kind??'other';
    const trips=cached(db,"SELECT json_extract(data,'$.truck') truck,json_extract(data,'$.from') f,json_extract(data,'$.to') t,json_extract(data,'$.createdAt') at,json_array_length(data,'$.containers') n FROM objects WHERE company_id=? AND kind='delivery'").all(company).map(t=>({...t,day:t.at?dayOf(st,t.at):null})).filter(t=>t.day&&inWindow(t.day));
    const weeks=[];for(let w=mondayOf(from);w<=today;w=addDays(w,7)){const start=w<from?from:w,end=addDays(w,6)>today?today:addDays(w,6);let n=0;for(let d=start;d<=end;d=addDays(d,1))n++;weeks.push({week:w,start,end,days:n,deliveries:0,returns:0,piecesOut:0,piecesBack:0});}
    const weekOf=day=>weeks.find(x=>day>=x.start&&day<=x.end);
    for(const t of trips){if(!(t.n>0))continue;const wk=weekOf(t.day);if(!wk)continue;if(kindAt(t.t)==='site'&&mySites.has(t.t))wk.deliveries++;else if(kindAt(t.t)==='yard'&&kindAt(t.f)==='site'&&mySites.has(t.f))wk.returns++;}
    const byProduct=new Map();
    for(const [day,sites] of st.moved){if(!inWindow(day))continue;const wk=weekOf(day);for(const [site,products] of sites){if(!mySites.has(site))continue;for(const [product,t] of products){const row=byProduct.get(product)??{out:0,back:0};row.out+=t.out;row.back+=t.back;if(wk){wk.piecesOut+=t.out;wk.piecesBack+=t.back;}byProduct.set(product,row);}}}
    const catalogue=this.catalogue().byId,systemNames=new Map(cached(db,'SELECT id,name FROM scaffold_systems').all().map(s=>[s.id,s.name]));
    const moved=[...byProduct].map(([product,r])=>{const p=catalogue.get(product);return {product,name:p?.name??'Removed product',system:p?.system??null,category:p?.category??null,out:r.out,back:r.back,total:r.out+r.back};}).filter(r=>r.total>0).sort((a,b)=>b.total-a.total||a.name.localeCompare(b.name));
    const materials=moved.slice(0,TOP),rest=moved.slice(TOP);
    // Loads per truck (the whole fleet, so only for operations): runs = trips leaving a yard; pieces = pieces loaded onto the truck, at the yard or at a site.
    let trucks=null;
    if(ops){const pieces=new Map();for(const [day,m] of st.loads)if(inWindow(day))for(const [truck,n] of m)add(pieces,truck,n);const runs=new Map();for(const t of trips)if(kindAt(t.f)==='yard')add(runs,t.truck,1);
      trucks=cached(db,"SELECT id,json_extract(data,'$.name') name,json_extract(data,'$.payload') payload,json_extract(data,'$.retired') retired FROM objects WHERE company_id=? AND kind='truck' ORDER BY rowid").all(company).map(t=>({id:t.id,name:t.name,payload:t.payload,retired:!!t.retired,runs:runs.get(t.id)??0,pieces:pieces.get(t.id)??0})).filter(t=>!t.retired||t.runs||t.pieces).sort((a,b)=>b.runs-a.runs||b.pieces-a.pieces||a.name.localeCompare(b.name,undefined,{numeric:true}));}
    // Stock by system, right now: in the yard / at sites / on trucks (a supervisor sees only what sits at their sites).
    const sys=new Map();for(const r of live){const kind=kindOf(st,r.place);let where=kind==='yard'?'yard':kind==='site'?'site':kind==='truck'?'truck':null;if(!ops)where=mySites.has(r.place)?'site':null;if(!where)continue;const row=sys.get(r.system)??{id:r.system,name:systemNames.get(r.system)??(r.system==='other'?'Other':r.system),yard:0,site:0,truck:0,total:0};row[where]+=r.q;row.total+=r.q;sys.set(r.system,row);}
    const systems=[...sys.values()].filter(s=>s.total>0).sort((a,b)=>b.total-a.total||a.name.localeCompare(b.name));
    const sum=k=>weeks.reduce((s,w)=>s+w[k],0);
    return {days,from,today,scope:ops?'company':'sites',sites:ops?null:siteRows.filter(s=>mySites.has(s.id)).map(s=>({id:s.id,name:s.name})),seq:st.seq,generatedAt:new Date().toISOString(),
      pieces:{series,now:rebuilt,start:series[0]?.pieces??0,check:{rebuilt,actual,ok:rebuilt===actual}},
      weeks,totals:{deliveries:sum('deliveries'),returns:sum('returns'),piecesOut:sum('piecesOut'),piecesBack:sum('piecesBack')},
      trucks,materials,otherMaterials:{count:rest.length,total:rest.reduce((s,r)=>s+r.total,0)},systems};
  }
};
