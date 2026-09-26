import { cached } from '../database.js';
import { AppError } from '../service.js';
import { requireRule,integer } from './geometry.js';
import { localDay,addDays,daysBetween,calendarNow,dayLabel } from './schedule.js';
// Hire tracking (GET /api/hire, GET /api/hire.csv, commands hireRate / hireSiteRate). Read-only over the append-only ledger: nothing here moves stock.
//
// On hire: a piece is on hire at a client site from the day it arrives there up to, not including, the day it leaves (a same-day delivery and return
// is 0 days, unless a minimum hire applies). Arrivals and departures come from the same ledger rows the Reports page replays:
//  PICKUP off a truck at a site (the site crane takes it) = delivered; PLACEMENT onto a truck from a site crane = loaded to go;
//  OPENING_BALANCE / PURCHASE into a site container = arrived; STOCK_REMOVED / DEMO_PURGED at a site and a negative stocktake = left; a positive stocktake = arrived.
// Every arrival is a lot (pieces + start day) per site and material. A departure ends hire for the OLDEST pieces first (FIFO), splitting a lot when only
// part of it goes back, so each piece keeps its own start day. Piece-days in a period = the pieces on hire each day, added up over the days.
// Pieces loaded onto a truck at a site stop hire on the loading day, but the lots are only settled when the truck sets them down:
//  - back on the SAME site (a cancelled collection, a load put back): the lots reopen with their original start day, as if they never left;
//  - at the yard: collected (a minimum hire applies);
//  - at ANOTHER site: a transfer. No minimum at the first site; the new site's lots remember when the pieces first went out, so a transfer never
//    restarts the minimum hire.
// A stocktake shortfall or a removal ends hire without a minimum hire top-up (the pieces were not collected); a later stocktake that finds pieces again
// reopens the most recently counted-off lots with their original start day.
//
// Money: whole cents, ex GST. Rates are the owner's (never guessed): per material a week and/or a day rate and an optional minimum hire in days.
//  - day rate only: each piece-day costs the day rate;
//  - week rate only: each piece-day costs a seventh of the week rate (rounded once per line);
//  - both: each lot's hire is counted in weeks from its start: whole weeks at the week rate, the extra days at the day rate but never more than a week.
// A site can have its own negotiated price (week and/or day, used together instead of the standard price) and its own minimum. Rates are kept as dated
// versions: each day is priced at the rate in force that day, so a price change never re-prices hire before it. A statement line is split where the
// rate changes. Pieces collected before the minimum hire add a 'minimum hire' top-up line (the rate in force on the return day), on the statement whose
// period holds the return day. Amount per line rounded to the cent; GST is 10% of the subtotal, rounded to the cent.
// A material with no rate is flagged and left out of every total.
export const GST_PERCENT=10;
const MAX_DAYS=400,BATCH=5000,MAX_CENTS=10000000;
const ADD=new Set(['OPENING_BALANCE','PURCHASE']),REMOVE=new Set(['STOCK_REMOVED','DEMO_PURGED']),ADJUST='STOCKTAKE_ADJUSTMENT',MOVE=new Set(['PICKUP','PLACEMENT','REPACK_PICKUP']);
const EVENTS=[...ADD,...REMOVE,ADJUST,...MOVE];
const DAY=/^\d{4}-\d{2}-\d{2}$/;
// Closures that charge a minimum hire: collected (no reason recorded) or still on the truck that loaded them. 'counted', 'removed' and 'transfer' do not.
const TOPUP=new Set([undefined,null,'collected','transit']);

// ---- The pure core (tested in node): a book of lots per site and product, replayed in ledger order. ----
// A lot: {q, start, first?} (first: the day the pieces first went out when they came from another site). A closed lot: {q, start, end, first?, why?, tag?}.
export function hireBook(){return new Map();}
const slot=(book,site,product)=>{let m=book.get(site);if(!m)book.set(site,m=new Map());let s=m.get(product);if(!s)m.set(product,s={open:[],closed:[]});return s;};
// Open lots stay in start order (FIFO); lots with the same start (and first) merge.
function openAdd(s,lot){let i=s.open.length;while(i>0&&s.open[i-1].start>lot.start)i--;const prev=s.open[i-1];if(prev&&prev.start===lot.start&&(prev.first??null)===(lot.first??null)){prev.q+=lot.q;return;}s.open.splice(i,0,{q:lot.q,start:lot.start,...(lot.first?{first:lot.first}:{})});}
export function hireArrive(book,site,product,q,day,first=null){if(!(q>0))return;openAdd(slot(book,site,product),{q,start:day,first:first&&first<day?first:null});}
const sameClosed=(a,b)=>a.start===b.start&&a.end===b.end&&(a.first??null)===(b.first??null)&&(a.why??null)===(b.why??null)&&(a.tag??null)===(b.tag??null);
// Ends hire for q pieces, oldest first. why: null (collected), 'transit', 'counted', 'removed' or 'transfer'; tag marks the lots one truck load took.
// Returns the pieces that could not be matched to anything on hire (a ledger that starts mid-story).
export function hireLeave(book,site,product,q,day,why=null,tag=null){if(!(q>0))return 0;const s=slot(book,site,product);let left=q;
 while(left>0&&s.open.length){const lot=s.open[0],n=Math.min(lot.q,left),rec={q:n,start:lot.start,end:day,...(lot.first?{first:lot.first}:{}),...(why?{why}:{}),...(tag?{tag}:{})};
  const last=s.closed.at(-1);if(last&&sameClosed(last,rec))last.q+=n;else s.closed.push(rec);lot.q-=n;left-=n;if(!lot.q)s.open.shift();}
 return left;}
// Puts up to q pieces of the closed lots that match back on hire with their original start day (most recently closed first). Returns how many.
export function hireReopen(book,site,product,q,match){const s=slot(book,site,product);let left=q;
 for(let i=s.closed.length-1;i>=0&&left>0;i--){const c=s.closed[i];if(!match(c))continue;const n=Math.min(c.q,left);c.q-=n;left-=n;openAdd(s,{q:n,start:c.start,first:c.first??null});if(!c.q)s.closed.splice(i,1);}
 return q-left;}
// Settles the lots one truck load took (tag): why = null (collected), 'transfer' or 'removed'. Returns them (for a transfer they arrive at the next site).
export function hireSettle(book,site,product,tag,why=null){const s=slot(book,site,product),out=[];
 for(const c of s.closed){if(c.tag!==tag)continue;delete c.tag;if(why)c.why=why;else delete c.why;out.push({q:c.q,start:c.start,first:c.first??null});}
 return out;}
// Days of [start, end) that fall inside [from, to] (to inclusive).
export const overlapDays=(start,end,from,to)=>{const a=start>from?start:from,b0=addDays(to,1),b=end<b0?end:b0;return b>a?daysBetween(a,b):0;};
// Every lot of one site and product as [q, start, end) with open lots running to the end of today.
const lotsOf=(s,today)=>[...s.closed.map(l=>({q:l.q,start:l.start,end:l.end,first:l.first??null,why:l.why??null,closed:true})),...s.open.map(l=>({q:l.q,start:l.start,end:addDays(today,1),first:l.first??null,why:null,closed:false}))];
const heldFor=l=>daysBetween(l.first??l.start,l.end);
// Per-day pieces on hire, piece-days and minimum-hire top-up piece-days for one site and product over [from, to].
export function hirePeriod(s,from,to,today,minDays=null){
 const lots=lotsOf(s,today),n=daysBetween(from,to)+1,daily=new Array(Math.max(0,n)).fill(0);let pieceDays=0,topUp=0;
 for(const l of lots){const d=overlapDays(l.start,l.end,from,to);if(!d)continue;pieceDays+=l.q*d;const first=daysBetween(from,l.start>from?l.start:from);for(let i=0;i<d;i++)daily[first+i]+=l.q;}
 if(minDays>0)for(const l of lots){if(!l.closed||!TOPUP.has(l.why)||l.end<from||l.end>to)continue;const held=heldFor(l);if(held<minDays)topUp+=l.q*(minDays-held);}
 return {daily,pieceDays,topUp,start:daily[0]??0,end:daily.at(-1)??0};}
// The rate that applies from a standard version and a site version: a site price (week and/or day) replaces the standard price as a whole (a negotiated
// week price is never mixed with the standard day price); the minimum comes from the site when it sets one, else from the standard.
export function hireRateFor(standard,override){const own=!!override&&(override.week!=null||override.day!=null),src=own?override:standard;
 const week=src?.week??null,day=src?.day??null,minDays=override?.minDays??standard?.minDays??null,priced=day!=null||week!=null;
 return {week,day,minDays,source:own?'site':priced?'standard':null,minSource:minDays==null?null:override?.minDays!=null?'site':'standard',priced,rule:!priced?null:day!=null&&week!=null?'both':day!=null?'day':'week',
  perDay:day!=null?day:week!=null?week/7:null,perWeek:week!=null?week:day!=null?day*7:null};}
// Sevenths of a cent for one piece held d days from the start of its lot (integers, so a line rounds once and never on a half cent).
const cost7=(r,d)=>r.rule==='both'?7*(Math.floor(d/7)*r.week+Math.min((d%7)*r.day,r.week)):r.rule==='day'?7*d*r.day:d*r.week;
// Cents for one piece held d days (the rule above); null with no rate.
export const hireCost=(rate,d)=>rate?.priced?cost7(rate,d)/7:null;
// Cents for piece-days at a day-only or week-only rate (whole cents; a seventh of a week rate is rounded once). Rates with both use hireCharge (per lot).
export const hireAmount=(pieceDays,rate)=>!rate?.priced?null:rate.rule==='day'?pieceDays*rate.day:Math.round(pieceDays*rate.week/7);
export const hireGst=subtotal=>Math.round(subtotal*GST_PERCENT/100);
export const hireMoney=c=>c==null?'':(c<0?'-':'')+String(Math.floor(Math.abs(c)/100))+'.'+String(Math.abs(c)%100).padStart(2,'0');
// Dated versions of a rate object ({from: null (every day) or a day, week, day, minDays}), oldest first. Objects saved before versions: one version for every day.
export const hireVersions=o=>!o?[]:(Array.isArray(o.versions)&&o.versions.length?[...o.versions]:[{from:null,week:o.week??null,day:o.day??null,minDays:o.minDays??null}]).sort((a,b)=>(a.from??'')<(b.from??'')?-1:(a.from??'')>(b.from??'')?1:0);
const versionAt=(list,day)=>{let v=null;for(const x of list)if(x.from==null||(day!=null&&x.from<=day))v=x;return v;};
const sameRate=(x,y)=>x.week===y.week&&x.day===y.day&&x.minDays===y.minDays&&x.source===y.source&&x.minSource===y.minSource;
// The rate in force for every day: [{from (null = from the beginning), to (null = on), rate}], from the standard and site versions.
export function hireTimeline(standard,override){const a=hireVersions(standard),b=hireVersions(override),days=[...new Set([...a,...b].map(v=>v.from).filter(Boolean))].sort(),starts=[null,...days],segs=[];
 starts.forEach((from,i)=>{const rate=hireRateFor(versionAt(a,from),versionAt(b,from)),to=i+1<starts.length?addDays(starts[i+1],-1):null,last=segs.at(-1);if(last&&sameRate(last.rate,rate))last.to=to;else segs.push({from,to,rate});});
 return segs;}
const inSeg=(seg,d)=>(seg.from==null||seg.from<=d)&&(seg.to==null||d<=seg.to);
// Money for one site and material over [from, to]: per rate period (segment of the timeline) the piece-days, the amount and the minimum-hire top-up.
// Arithmetic per lot (no per-day arrays), so the overview stays fast over years of history.
// Day numbers (days since 1970) for the arithmetic below; the strings repeat a lot, so they are kept.
const DN=new Map();const dn=d=>{let v=DN.get(d);if(v===undefined){if(DN.size>200000)DN.clear();const [y,m,x]=d.split('-').map(Number);v=Date.UTC(y,m-1,x)/86400000;DN.set(d,v);}return v;};
export function hireCharge(s,from,to,today,segs){const F=dn(from),T=dn(to),OPEN=dn(today)+1,out=segs.map(seg=>({seg,a:seg.from?dn(seg.from):-Infinity,b:seg.to?dn(seg.to):Infinity,pieceDays:0,n7:0,topUp:0,top7:0}));
 const add=(q,S,E)=>{if(S>T||E<=F)return;for(const o of out){const a=Math.max(S,F,o.a),b=Math.min(E-1,T,o.b);if(b<a)continue;const n=b-a+1,before=a-S;o.pieceDays+=q*n;if(o.seg.rate.priced)o.n7+=q*(cost7(o.seg.rate,before+n)-cost7(o.seg.rate,before));}};
 for(const l of s.open)add(l.q,dn(l.start),OPEN);
 for(const l of s.closed){const S=dn(l.start),E=dn(l.end);add(l.q,S,E);if(E<F||E>T||!TOPUP.has(l.why))continue;
  const o=out.find(x=>x.a<=E&&E<=x.b),r=o?.seg.rate;if(!r?.minDays)continue;const held=E-dn(l.first??l.start);if(held>=r.minDays)continue;o.topUp+=l.q*(r.minDays-held);if(r.priced)o.top7+=l.q*(cost7(r,r.minDays)-cost7(r,held));}
 return out.map(o=>({from:o.seg.from,to:o.seg.to,rate:o.seg.rate,pieceDays:o.pieceDays,amount:o.seg.rate.priced?Math.round(o.n7/7):null,topUp:o.topUp,topUpAmount:o.topUp&&o.seg.rate.priced?Math.round(o.top7/7):null}));}

// ---- Ledger replay, kept per database and company and advanced by new ledger rows only (like the Reports store). ----
const stores=new WeakMap();
const fresh=()=>({seq:0,bv:0,info:new Map(),loaded:false,locOf:new Map(),book:hireBook(),transit:new Map(),unmatched:0,first:null,dayOf:new Map(),memo:new Map()});
const loadInfo=(db,company)=>{const m=new Map();for(const r of cached(db,"SELECT id,kind,json_extract(data,'$.location') loc FROM objects WHERE company_id=? AND kind IN ('yard','site','truck','resource','container')").all(company))m.set(r.id,{kind:r.kind,loc:r.loc});return m;};
function info(st,db,company,id){let o=st.info.get(id);if(!o&&!st.loaded){st.info=loadInfo(db,company);st.loaded=true;o=st.info.get(id);}return o;}
// The place an id stands for: a site id, 'yard', 'truck' or 'other' (a crane counts where it works, a container where it last went).
function placeOf(st,db,company,id,depth=0){if(id==null||depth>4)return 'other';const o=info(st,db,company,id);if(!o)return 'other';if(o.kind==='site')return 'site:'+id;if(o.kind==='yard')return 'yard';if(o.kind==='truck')return 'truck';if(o.kind==='resource')return placeOf(st,db,company,o.loc,depth+1);return placeOf(st,db,company,st.locOf.get(id)??o.loc,depth+1);}
function dayOf(st,iso){const k=String(iso).slice(0,16);let d=st.dayOf.get(k);if(!d){if(st.dayOf.size>50000)st.dayOf.clear();d=localDay(new Date(iso));st.dayOf.set(k,d);}return d;}
function apply(st,db,company,r){
 const q=r.quantity,pid=r.product_id,day=dayOf(st,r.created_at),at=id=>placeOf(st,db,company,id),site=p=>p?.startsWith('site:')?p.slice(5):null,book=st.book,tkey=r.container_id+'|'+pid;
 const arrive=(p,n,first=null)=>{const s=site(p);if(s&&n>0){hireArrive(book,s,pid,n,day,first);if(!st.first||day<st.first)st.first=day;st.bv++;}};
 const leave=(p,n,why=null,tag=null)=>{const s=site(p);if(s&&n>0){st.unmatched+=hireLeave(book,s,pid,n,day,why,tag);st.bv++;}};
 // A container's pieces that left a site on a truck, settled where they are set down (to: a site id, or null for the yard / anywhere else).
 const settle=(why,to=null,n=0)=>{const t=st.transit.get(tkey);if(!t)return false;st.transit.delete(tkey);st.bv++;
  if(to&&to===t.site){const back=hireReopen(book,t.site,pid,n,c=>c.tag===t.tag);hireSettle(book,t.site,pid,t.tag);if(n>back)arrive('site:'+to,n-back);return true;}
  const lots=hireSettle(book,t.site,pid,t.tag,to?'transfer':why);
  if(to){let left=n;for(const l of lots){const k=Math.min(l.q,left);if(k>0)hireArrive(book,to,pid,k,day,l.first??l.start);left-=k;}if(left>0)hireArrive(book,to,pid,left,day);if(!st.first||day<st.first)st.first=day;}
  return true;};
 if(ADD.has(r.event)){arrive(at(r.destination??r.container_id),q);if(r.container_id&&r.destination)st.locOf.set(r.container_id,r.destination);return;}
 if(REMOVE.has(r.event)){if(r.container_id&&settle('removed'))return;leave(at(r.source??r.container_id),q,'removed');return;}
 if(r.event===ADJUST){const p=at(r.source??r.container_id),s=site(p);if(q>0){const back=s?hireReopen(book,s,pid,q,c=>c.why==='counted'):0;if(back)st.bv++;arrive(p,q-back);}else leave(p,-q,'counted');return;}
 if(!MOVE.has(r.event))return;
 const from=at(r.source),to=at(r.destination);if(r.container_id&&r.destination)st.locOf.set(r.container_id,r.destination);
 if(from===to)return;
 if(from==='truck'&&r.container_id&&st.transit.has(tkey)){settle(null,site(to),q);return;}
 if(to==='truck'&&site(from)&&r.container_id){settle(null);const tag='t'+r.sequence;st.transit.set(tkey,{site:site(from),tag});leave(from,q,'transit',tag);return;}
 leave(from,q);arrive(to,q);
}
function sync(db,company){
 let byCompany=stores.get(db);if(!byCompany)stores.set(db,byCompany=new Map());let st=byCompany.get(company);if(!st)byCompany.set(company,st=fresh());
 const max=cached(db,'SELECT MAX(sequence) m FROM ledger WHERE company_id=?').get(company).m??0;if(max===st.seq)return st;
 st.loaded=false;const sql=`SELECT sequence,event,product_id,container_id,quantity,source,destination,created_at FROM ledger WHERE company_id=? AND sequence>? AND sequence<=? AND product_id IS NOT NULL AND event IN (${EVENTS.map(()=>'?').join(',')}) ORDER BY sequence LIMIT ${BATCH}`;
 for(let cursor=st.seq;;){const rows=cached(db,sql).all(company,cursor,max,...EVENTS);for(const r of rows)apply(st,db,company,r);if(rows.length<BATCH)break;cursor=rows[rows.length-1].sequence;}
 st.seq=max;return st;
}
// Results that only depend on the hire book, the rates and the day are kept until one of them changes (not every ledger row: the yard writes rows all day).
function memo(st,key,make){if(st.memo.has(key))return st.memo.get(key);const v=make();st.memo.set(key,v);if(st.memo.size>32)st.memo.delete(st.memo.keys().next().value);return v;}
// ---- Input checks ----
const cents=(v,label)=>{if(v===undefined||v===null||v==='')return null;return integer(v,label+' (cents)',0,MAX_CENTS);};
const minDaysOf=v=>v===undefined||v===null||v===''?null:integer(v,'Minimum hire (days)',1,365);
const noteOf=v=>{if(v===undefined||v===null||v==='')return null;requireRule(typeof v==='string'&&v.trim().length<=120,'Keep the note to 120 characters.');return v.trim()||null;};
const dayArg=(v,label)=>{if(!(typeof v==='string'&&DAY.test(v)&&addDays(v,0)===v))throw new AppError(400,label+' must be a date (YYYY-MM-DD).');return v;};
const stamp=o=>{const {id,kind,version,...rest}=o;return rest;};
// Saves one dated version of a rate object (standard or site). from null: the price for every day (a correction: earlier versions are replaced);
// a day: the price from that day on (earlier days keep theirs). Empty fields with from null remove the rate; with a day, 'no rate' from that day.
function saveVersion(sim,kind,old,base,fields,from,today){
 const empty=fields.week==null&&fields.day==null&&fields.minDays==null,now=new Date().toISOString();
 let versions=from==null?(empty?[]:[{from:null,...fields,at:now,by:sim.user.id}]):[...hireVersions(old).filter(v=>v.from!==from),{from,...fields,at:now,by:sim.user.id}];
 versions=hireVersions({versions});if(versions.every(v=>v.week==null&&v.day==null&&v.minDays==null))versions=[];
 if(!versions.length){if(old)sim.repo.remove(old.id,kind);return null;}
 const cur=versionAt(versions,today)??{week:null,day:null,minDays:null},data={...base,week:cur.week??null,day:cur.day??null,minDays:cur.minDays??null,versions,updatedAt:now,updatedBy:sim.user.id};
 return old?sim.repo.save({...old,...data}):sim.repo.add(kind,data);}
const fromArg=(v,today)=>{if(v===undefined||v===null||v==='')return null;const d=dayArg(v,'Applies from');requireRule(d<=addDays(today,366),'A new rate can start at most a year ahead.');return d;};
const whenText=from=>from?' from '+dayLabel(from):' for every day';

export const hireMethods={
 hireRequire(){if(!this.auth.permissions(this.user).includes('finance.view'))throw new AppError(403,'Hire figures are for the owner only.');},
 // Standard rate for one material (cents ex GST), for every day or from a day. Retired materials can still be priced: their past hire needs a rate.
 hireRate(input){const p=this.effective(input.product);requireRule(p,'Choose a material from the catalogue.');const week=cents(input.week,'Week rate'),day=cents(input.day,'Day rate'),minDays=minDaysOf(input.minDays),today=calendarNow().today,from=fromArg(input.from,today);
  const old=this.repo.all('hireRate').find(r=>r.product===p.id),saved=saveVersion(this,'hireRate',old,{product:p.id},{week,day,minDays},from,today),removed=!saved,off=week==null&&day==null&&minDays==null;
  // The ledger row names what changed, never the money: operations managers read the history too.
  this.repo.event(this.user.id,'HIRE_RATE',{product:p.id,reason:(removed?'Hire rate removed for ':off?'Hire rate ended for ':'Hire rate set for ')+p.name+(removed?'':whenText(from)),key:this.key});
  return {message:removed?'Hire rate removed for '+p.name+'.':off?'No hire rate for '+p.name+whenText(from)+'.':'Hire rate saved for '+p.name+whenText(from)+'.',rate:saved?stamp(saved):null};},
 // A site's own rate for one material (a negotiated rate): its week/day price replaces the standard price; an empty minimum uses the standard one.
 hireSiteRate(input){const site=this.repo.get(input.site,'site'),p=this.effective(input.product);requireRule(p,'Choose a material from the catalogue.');const week=cents(input.week,'Week rate'),day=cents(input.day,'Day rate'),minDays=minDaysOf(input.minDays),note=noteOf(input.note),today=calendarNow().today,from=fromArg(input.from,today);
  const old=this.repo.all('hireSiteRate').find(r=>r.site===site.id&&r.product===p.id),saved=saveVersion(this,'hireSiteRate',old,{site:site.id,product:p.id,note},{week,day,minDays},from,today),removed=!saved;
  this.repo.event(this.user.id,'HIRE_RATE',{product:p.id,reason:(removed?'Site hire rate removed for ':'Site hire rate set for ')+p.name+' at '+site.name+(removed?'':whenText(from)),key:this.key});
  return {message:removed?'Site rate removed: '+site.name+' uses the standard rate for '+p.name+'.':'Site rate saved for '+p.name+' at '+site.name+whenText(from)+'.',rate:saved?stamp(saved):null};},
 // GET /api/hire?site=&from=&to= : the overview, every rate, and one site's statement when a site is given. The sums are kept until the hire book,
 // a rate or the day changes; names, collections and the live count are read fresh each time.
 hire(query={}){this.hireRequire();const cal=calendarNow(),st=sync(this.db,this.user.company_id);return this.hireView(st,cal,{site:query.site||null,from:query.from||null,to:query.to||null});},
 hireView(st,cal,{site,from,to}){
  const today=cal.today,weekStart=cal.weekStart,catalogue=this.catalogue().byId,sites=this.repo.all('site'),siteById=new Map(sites.map(s=>[s.id,s]));
  const rawRates=[...this.repo.all('hireRate'),...this.repo.all('hireSiteRate')],rates=rawRates.filter(r=>r.kind==='hireRate').map(stamp),siteRates=rawRates.filter(r=>r.kind==='hireSiteRate').map(stamp),std=new Map(rates.map(r=>[r.product,r])),over=new Map(siteRates.map(r=>[r.site+'|'+r.product,r]));
  // The key of every kept sum: the hire book's version, the day and every rate object's id and version.
  const rk=st.bv+'|'+today+'|'+weekStart+'|'+rawRates.map(r=>r.id+'@'+r.version).join(',');
  const lines=new Map(),timeline=(s,p)=>{const k=s+'|'+p;let t=lines.get(k);if(!t)lines.set(k,t=hireTimeline(std.get(p),over.get(k)));return t;};
  const product=id=>{const p=catalogue.get(id);return {id,name:p?.name??'Removed material',reference:p?.reference??null,system:p?.system??null,category:p?.category??null,demo:p?.verification==='DEMO ONLY',retired:!!p?.retired};};
  // The next scheduled return (collection) still to leave each site: hire ends for what it loads on the day the site crane puts it on the truck. Read only.
  const nextCollection=new Map();for(const c of this.repo.all('collection')){if(!['REQUESTED','BOOKED','LOADING'].includes(c.status))continue;const was=nextCollection.get(c.site);if(!was||(c.status==='LOADING'&&was.status!=='LOADING')||(was.status!=='LOADING'&&String(c.neededOn??'9')<String(was.neededOn??'9')))nextCollection.set(c.site,{id:c.id,status:c.status,neededOn:c.neededOn??null,slot:c.slot??'ANY',late:!!c.neededOn&&c.neededOn<today});}
  // The sums per site: pieces now, since, hire to date and this week (priced per rate period), run rate and unpriced materials.
  const sums=memo(st,'o|'+rk,()=>{const out=new Map(),onHire=new Map(),everOn=new Set(),unpricedNow=new Map();
   for(const [sid,byProduct] of st.book){let n=0,since=null,accrued=0,week=0,missing=new Set(),rr=0,first=null,longest=null;
    for(const [pid,lots] of byProduct){everOn.add(pid);const segs=timeline(sid,pid),now=segs.find(x=>inSeg(x,today))?.rate,openQ=lots.open.reduce((a,l)=>a+l.q,0);
     const start=[...lots.closed.map(l=>l.start),...lots.open.map(l=>l.start)].sort()[0];if(start&&(!first||start<first))first=start;
     if(openQ){n+=openQ;onHire.set(pid,(onHire.get(pid)??0)+openQ);const s0=lots.open[0].start;if(!since||s0<since)since=s0;if(!longest||s0<longest.since)longest={product:pid,since:s0,days:daysBetween(s0,today)+1};
      if(now?.priced)rr+=openQ*now.perWeek;else unpricedNow.set(pid,(unpricedNow.get(pid)??0)+openQ);}
     if(!start)continue;
     for(const c of hireCharge(lots,start,today,today,segs)){if(!c.pieceDays&&!c.topUp)continue;if(c.amount==null)missing.add(pid);else accrued+=c.amount+(c.topUpAmount??0);}
     for(const c of hireCharge(lots,weekStart,today,today,segs))if(c.amount!=null)week+=c.amount+(c.topUpAmount??0);}
    if(first)out.set(sid,{pieces:n,since,first,accrued,thisWeek:week,runRate:rr,missing:[...missing],longest});}
   return {sites:out,onHire,everOn,unpricedNow};});
  const rows=[];let pieces=0,weekSum=0,weekMissing=0,runRate=0,longest=null,sitesOn=0;
  for(const [sid,x] of sums.sites){const s=siteById.get(sid);if(!s)continue;if(x.pieces)sitesOn++;pieces+=x.pieces;weekSum+=x.thisWeek;runRate+=x.runRate;weekMissing+=x.missing.length?1:0;
   if(x.longest&&(!longest||x.longest.since<longest.since))longest={site:sid,siteName:s.name,product:x.longest.product,name:product(x.longest.product).name,since:x.longest.since,days:x.longest.days};
   rows.push({id:sid,name:s.name,client:s.client??null,address:s.address??null,status:s.status,pieces:x.pieces,since:x.since,days:x.since?daysBetween(x.since,today)+1:0,first:x.first,accrued:x.accrued,thisWeek:x.thisWeek,runRate:x.runRate,missing:x.missing,overrides:siteRates.filter(r=>r.site===sid).length,collection:nextCollection.get(sid)??null});}
  rows.sort((a,b)=>(b.pieces>0)-(a.pieces>0)||(a.since??'9').localeCompare(b.since??'9')||a.name.localeCompare(b.name,undefined,{numeric:true}));
  // The live count at sites (contents table), so the page can show the replay agrees with the Stock page.
  let actual=0;for(const r of cached(this.db,"SELECT json_extract(o.data,'$.location') loc,SUM(ct.quantity) q FROM contents ct JOIN objects o ON o.company_id=ct.company_id AND o.id=ct.container_id WHERE ct.company_id=? AND ct.quantity>0 GROUP BY loc").all(this.user.company_id))if(siteById.has(r.loc))actual+=r.q;
  const products=[...new Set([...sums.everOn,...rates.map(r=>r.product),...siteRates.map(r=>r.product)])].map(id=>({...product(id),onHire:sums.onHire.get(id)??0,everOnHire:sums.everOn.has(id)})).sort((a,b)=>b.onHire-a.onHire||(b.everOnHire-a.everOnHire)||a.name.localeCompare(b.name,undefined,{numeric:true}));
  const unpriced=[...sums.unpricedNow].map(([id,q])=>({...product(id),pieces:q})).sort((a,b)=>b.pieces-a.pieces);
  const result={seq:st.seq,today,weekStart,monthStart:today.slice(0,8)+'01',generatedAt:new Date().toISOString(),gstPercent:GST_PERCENT,firstDay:st.first,
   totals:{pieces,sites:sitesOn,activeSites:sites.filter(s=>s.status==='ACTIVE').length,thisWeek:weekSum,runRate,weekMissing,longest},
   check:{rebuilt:pieces,actual,ok:pieces===actual},sites:rows,unpriced,products,rates,siteRates,
   siteList:sites.map(s=>({id:s.id,name:s.name,status:s.status,onHire:rows.some(r=>r.id===s.id)})).sort((a,b)=>(b.onHire-a.onHire)||(a.status==='ACTIVE'?0:1)-(b.status==='ACTIVE'?0:1)||a.name.localeCompare(b.name,undefined,{numeric:true})),
   statement:null};
  if(site)result.statement=this.hireStatement(st,site,from,to,cal,{timeline,product,siteById,rk,rates:[...rates,...siteRates.filter(r=>r.site===site)]});
  return result;},
 // One site's statement: a line per material and rate period with piece-days in the period (plus a minimum-hire top-up where pieces went back early),
 // subtotal, GST and total.
 hireStatement(st,siteId,from,to,cal,{timeline,product,siteById,rk,rates}){
  const today=cal.today,s=siteById.get(siteId);if(!s)throw new AppError(404,'Record not found in your company.');
  from=from?dayArg(from,'From'):today.slice(0,8)+'01';to=to?dayArg(to,'To'):today;requireRule(from<=today,'The statement cannot start after today.');requireRule(from<=to,'The statement starts after it ends. Pick a From date on or before the To date.');
  const clamped=to>today;if(clamped)to=today;requireRule(daysBetween(from,to)+1<=MAX_DAYS,'Choose a period of at most '+MAX_DAYS+' days.');
  const core=memo(st,'s|'+rk+'|'+siteId+'|'+from+'|'+to,()=>{const days=daysBetween(from,to)+1,daily=new Array(days).fill(0),lines=[];
   for(const [pid,lots] of st.book.get(siteId)??[]){const p=hirePeriod(lots,from,to,today);const charges=hireCharge(lots,from,to,today,timeline(siteId,pid)).filter(c=>c.pieceDays||c.topUp);if(!charges.length)continue;
    p.daily.forEach((n,i)=>{daily[i]+=n;});
    for(const c of charges){const a=c.from&&c.from>from?c.from:from,b=c.to&&c.to<to?c.to:to,i0=daysBetween(from,a),i1=daysBetween(from,b),mine=p.daily.map((n,i)=>i>=i0&&i<=i1?n:0);
     lines.push({pid,rateFrom:a,rateTo:b,split:charges.length>1,start:p.daily[i0]??0,end:p.daily[i1]??0,peak:Math.max(0,...mine),pieceDays:c.pieceDays,rate:c.rate,amount:c.amount,topUp:c.topUp?{pieceDays:c.topUp,amount:c.topUpAmount,minDays:c.rate.minDays}:null,daily:mine});}}
   return {days,daily,lines};});
  const lines=core.lines.map(l=>({...l,product:product(l.pid)}));
  // Largest materials first, keeping each material's rate periods together in date order.
  const weight=new Map();for(const l of lines)weight.set(l.pid,(weight.get(l.pid)??0)+l.pieceDays);lines.sort((a,b)=>weight.get(b.pid)-weight.get(a.pid)||a.product.name.localeCompare(b.product.name,undefined,{numeric:true})||(a.rateFrom<b.rateFrom?-1:a.rateFrom>b.rateFrom?1:0));
  let subtotal=0,missing=0,demo=false,pieceDays=0;const unpricedIds=new Set();
  for(const l of lines){pieceDays+=l.pieceDays;if(l.product.demo)demo=true;if(!l.rate.priced)unpricedIds.add(l.pid);else subtotal+=l.amount+(l.topUp?.amount??0);}
  missing=unpricedIds.size;const gst=hireGst(subtotal),used=new Set(lines.map(l=>l.pid));
  const asOf=rates.filter(r=>used.has(r.product)).map(r=>r.updatedAt).sort().at(-1)??null;
  return {site:{id:s.id,name:s.name,address:s.address??null,client:s.client??null,contact:s.contact??null,phone:s.phone??null,email:s.email??null,status:s.status},from,to,days:core.days,clamped,today,
   lines,daily:core.daily,pieceDays,subtotal,gst,total:subtotal+gst,missing,complete:missing===0,demo,startPieces:core.daily[0]??0,endPieces:core.daily.at(-1)??0,
   overrides:new Set(lines.filter(l=>l.rate.source==='site').map(l=>l.pid)).size,siteMinimums:new Set(lines.filter(l=>l.rate.minSource==='site'&&l.rate.source!=='site').map(l=>l.pid)).size,
   rateChanges:new Set(lines.filter(l=>l.split).map(l=>l.pid)).size,ratesAsOf:asOf,onHireNow:to===today?core.daily.at(-1)??0:0};},
 // GET /api/hire.csv?site=&from=&to= : the statement as a spreadsheet (lines, totals, then pieces on hire per day).
 hireCSV(query={}){requireRule(query.site,'Choose a site for the statement.');const r=this.hire(query),s=r.statement,company=cached(this.db,'SELECT name FROM companies WHERE id=?').get(this.user.company_id)?.name??'';
  const cash=c=>c==null?'':hireMoney(c),basis=rate=>!rate.priced?'NO RATE SET':rate.rule==='both'?'whole weeks at the week rate, extra days at the day rate (at most a week)':rate.rule==='day'?'per day':'per week / 7';
  const rateText=rate=>!rate.priced?'':[rate.week!=null?hireMoney(rate.week)+'/week':'',rate.day!=null?hireMoney(rate.day)+'/day':''].filter(Boolean).join(' + ');
  const src=rate=>[rate.source??'',rate.minSource==='site'&&rate.source!=='site'?'site minimum':''].filter(Boolean).join(', ');
  const name=l=>l.product.name+(l.split?' ('+l.rateFrom+' to '+l.rateTo+')':'');
  const rows=[['HIRE STATEMENT'+(s.demo?' (DEMO ONLY - demonstration products, not a real statement)':'')],['Company',company],['Client',s.site.client??''],['Site',s.site.name],['Period',s.from+' to '+s.to+(s.clamped?' (to today)':''),s.days+' days'],['Amounts','AUD, ex GST unless marked'],
   ['Rates','Each day is priced at the rate in force that day'+(s.ratesAsOf?' (rates as recorded on '+s.ratesAsOf.slice(0,10)+')':'')],...(s.missing?[['WARNING',s.missing+' material(s) have no hire rate and are NOT included in the totals']]:[]),[],
   ['Material','Reference','System','Pieces at start','Pieces at end','Piece-days','Rate basis','Rate (AUD ex GST)','Rate source','Amount (AUD ex GST)']];
  for(const l of s.lines){rows.push([name(l),l.product.reference??'',l.product.system??'',l.start,l.end,l.pieceDays,basis(l.rate),rateText(l.rate),src(l.rate),cash(l.amount)]);if(l.topUp)rows.push([l.product.name+' - minimum hire top-up ('+l.topUp.minDays+' days)',l.product.reference??'',l.product.system??'','','',l.topUp.pieceDays,basis(l.rate),rateText(l.rate),src(l.rate),cash(l.topUp.amount)]);}
  rows.push([],['Subtotal (ex GST)','','','','','','','','',cash(s.subtotal)],['GST '+GST_PERCENT+'%','','','','','','','','',cash(s.gst)],['Total (inc GST)','','','','','','','','',cash(s.total)],[],['Pieces on hire per day'],['Date',...s.lines.map(name),'All materials']);
  for(let i=0;i<s.days;i++)rows.push([addDays(s.from,i),...s.lines.map(l=>l.daily[i]),s.daily[i]]);
  const csv=rows.map(row=>row.map(value=>'"'+String(value??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"').join(',')).join('\r\n');
  const slug=String(s.site.name).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40)||'site';
  return {csv,name:'hire-statement-'+slug+'-'+s.from+'-to-'+s.to+'.csv'};}
};
