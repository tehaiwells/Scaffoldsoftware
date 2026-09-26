import { cached } from '../database.js';
import { AppError } from '../service.js';
import { requireRule,integer } from './geometry.js';
import { localDay,addDays,daysBetween,calendarNow } from './schedule.js';
// Hire tracking (GET /api/hire, GET /api/hire.csv, commands hireRate / hireSiteRate). Read-only over the append-only ledger: nothing here moves stock.
//
// On hire: a piece is on hire at a client site from the day it arrives there up to, not including, the day it leaves (a same-day delivery and return
// is 0 days, unless a minimum hire applies). Arrivals and departures come from the same ledger rows the Reports page replays:
//  PICKUP off a truck at a site (the site crane takes it) = delivered; PLACEMENT onto a truck from a site crane = collected;
//  OPENING_BALANCE / PURCHASE into a site container = arrived; STOCK_REMOVED / DEMO_PURGED at a site and a negative stocktake = left; a positive stocktake = arrived.
// Every arrival is a lot (pieces + start day) per site and material. A departure ends hire for the OLDEST pieces first (FIFO), splitting a lot when only
// part of it goes back, so each piece keeps its own start day. Piece-days in a period = the pieces on hire each day, added up over the days.
//
// Money: whole cents, ex GST. Rates are the owner's (never guessed): per material a week and/or a day rate and an optional minimum hire in days; a site can
// override any of them (a negotiated rate). A day costs the day rate, or a seventh of the week rate when only a week rate is set. Amount per line = piece-days
// x that, rounded to the cent; GST is 10% of the subtotal, rounded to the cent. Pieces that go back before the minimum hire add a 'minimum hire' line for the
// missing days, on the statement whose period holds the return day. A material with no rate is flagged and left out of every total.
export const GST_PERCENT=10;
const MAX_DAYS=400,BATCH=5000,MAX_CENTS=10000000;
const ADD=new Set(['OPENING_BALANCE','PURCHASE']),REMOVE=new Set(['STOCK_REMOVED','DEMO_PURGED']),ADJUST='STOCKTAKE_ADJUSTMENT',MOVE=new Set(['PICKUP','PLACEMENT','REPACK_PICKUP']);
const EVENTS=[...ADD,...REMOVE,ADJUST,...MOVE];
const DAY=/^\d{4}-\d{2}-\d{2}$/;

// ---- The pure core (tested in node): a book of lots per site and product, replayed in ledger order. ----
export function hireBook(){return new Map();}
const slot=(book,site,product)=>{let m=book.get(site);if(!m)book.set(site,m=new Map());let s=m.get(product);if(!s)m.set(product,s={open:[],closed:[]});return s;};
export function hireArrive(book,site,product,q,day){if(!(q>0))return;const s=slot(book,site,product),last=s.open.at(-1);if(last&&last.start===day)last.q+=q;else s.open.push({q,start:day});}
// Returns the pieces that could not be matched to anything on hire (a ledger that starts mid-story).
export function hireLeave(book,site,product,q,day){if(!(q>0))return 0;const s=slot(book,site,product);let left=q;
 while(left>0&&s.open.length){const lot=s.open[0],n=Math.min(lot.q,left);const last=s.closed.at(-1);if(last&&last.start===lot.start&&last.end===day)last.q+=n;else s.closed.push({q:n,start:lot.start,end:day});lot.q-=n;left-=n;if(!lot.q)s.open.shift();}
 return left;}
// Days of [start, end) that fall inside [from, to] (to inclusive).
export const overlapDays=(start,end,from,to)=>{const a=start>from?start:from,b0=addDays(to,1),b=end<b0?end:b0;return b>a?daysBetween(a,b):0;};
// Every lot of one site and product as [q, start, end) with open lots running to the end of today.
const lotsOf=(s,today)=>[...s.closed.map(l=>({q:l.q,start:l.start,end:l.end,closed:true})),...s.open.map(l=>({q:l.q,start:l.start,end:addDays(today,1),closed:false}))];
// Per-day pieces on hire, piece-days and minimum-hire top-ups for one site and product over [from, to].
export function hirePeriod(s,from,to,today,minDays=null){
 const lots=lotsOf(s,today),n=daysBetween(from,to)+1,daily=new Array(Math.max(0,n)).fill(0);let pieceDays=0,topUp=0;
 for(const l of lots){const d=overlapDays(l.start,l.end,from,to);if(!d)continue;pieceDays+=l.q*d;const first=daysBetween(from,l.start>from?l.start:from);for(let i=0;i<d;i++)daily[first+i]+=l.q;}
 if(minDays>0)for(const l of lots){if(!l.closed||l.end<from||l.end>to)continue;const held=daysBetween(l.start,l.end);if(held<minDays)topUp+=l.q*(minDays-held);}
 return {daily,pieceDays,topUp,start:daily[0]??0,end:daily.at(-1)??0};}
// The rate that applies: a site override field wins over the standard one, field by field. perDay in cents (a fraction when it comes from a week rate).
export function hireRateFor(standard,override){const pick=k=>override?.[k]!=null?override[k]:standard?.[k]??null;const week=pick('week'),day=pick('day'),minDays=pick('minDays');
 const source=override&&['week','day','minDays'].some(k=>override[k]!=null)?'site':standard&&['week','day'].some(k=>standard[k]!=null)?'standard':null;
 return {week,day,minDays,source,priced:day!=null||week!=null,perDay:day!=null?day:week!=null?week/7:null,perWeek:week!=null?week:day!=null?day*7:null};}
// Cents for piece-days at a rate; null when there is no rate. Whole cents: day rate x piece-days is exact, a seventh of a week rate is rounded once per line.
export const hireAmount=(pieceDays,rate)=>!rate?.priced?null:rate.day!=null?pieceDays*rate.day:Math.round(pieceDays*rate.week/7);
export const hireGst=subtotal=>Math.round(subtotal*GST_PERCENT/100);
export const hireMoney=c=>c==null?'':(c<0?'-':'')+String(Math.floor(Math.abs(c)/100))+'.'+String(Math.abs(c)%100).padStart(2,'0');

// ---- Ledger replay, kept per database and company and advanced by new ledger rows only (like the Reports store). ----
const stores=new WeakMap();
const fresh=()=>({seq:0,info:new Map(),loaded:false,locOf:new Map(),book:hireBook(),unmatched:0,first:null,dayOf:new Map(),results:new Map()});
const loadInfo=(db,company)=>{const m=new Map();for(const r of cached(db,"SELECT id,kind,json_extract(data,'$.location') loc FROM objects WHERE company_id=? AND kind IN ('yard','site','truck','resource','container')").all(company))m.set(r.id,{kind:r.kind,loc:r.loc});return m;};
function info(st,db,company,id){let o=st.info.get(id);if(!o&&!st.loaded){st.info=loadInfo(db,company);st.loaded=true;o=st.info.get(id);}return o;}
// The place an id stands for: a site id, 'yard', 'truck' or 'other' (a crane counts where it works, a container where it last went).
function placeOf(st,db,company,id,depth=0){if(id==null||depth>4)return 'other';const o=info(st,db,company,id);if(!o)return 'other';if(o.kind==='site')return 'site:'+id;if(o.kind==='yard')return 'yard';if(o.kind==='truck')return 'truck';if(o.kind==='resource')return placeOf(st,db,company,o.loc,depth+1);return placeOf(st,db,company,st.locOf.get(id)??o.loc,depth+1);}
function dayOf(st,iso){const k=String(iso).slice(0,16);let d=st.dayOf.get(k);if(!d){if(st.dayOf.size>50000)st.dayOf.clear();d=localDay(new Date(iso));st.dayOf.set(k,d);}return d;}
function apply(st,db,company,r){
 const q=r.quantity,day=dayOf(st,r.created_at),at=id=>placeOf(st,db,company,id),site=p=>p.startsWith('site:')?p.slice(5):null;
 const arrive=(p,n)=>{const s=site(p);if(s&&n>0){hireArrive(st.book,s,r.product_id,n,day);if(!st.first||day<st.first)st.first=day;}},leave=(p,n)=>{const s=site(p);if(s&&n>0)st.unmatched+=hireLeave(st.book,s,r.product_id,n,day);};
 if(ADD.has(r.event)){arrive(at(r.destination??r.container_id),q);if(r.container_id&&r.destination)st.locOf.set(r.container_id,r.destination);return;}
 if(REMOVE.has(r.event)){leave(at(r.source??r.container_id),q);return;}
 if(r.event===ADJUST){const p=at(r.source??r.container_id);if(q>0)arrive(p,q);else leave(p,-q);return;}
 if(!MOVE.has(r.event))return;
 const from=at(r.source),to=at(r.destination);if(r.container_id&&r.destination)st.locOf.set(r.container_id,r.destination);
 if(from!==to){leave(from,q);arrive(to,q);}
}
function sync(db,company){
 let byCompany=stores.get(db);if(!byCompany)stores.set(db,byCompany=new Map());let st=byCompany.get(company);if(!st)byCompany.set(company,st=fresh());
 const max=cached(db,'SELECT MAX(sequence) m FROM ledger WHERE company_id=?').get(company).m??0;if(max===st.seq)return st;
 st.loaded=false;const sql=`SELECT sequence,event,product_id,container_id,quantity,source,destination,created_at FROM ledger WHERE company_id=? AND sequence>? AND sequence<=? AND product_id IS NOT NULL AND event IN (${EVENTS.map(()=>'?').join(',')}) ORDER BY sequence LIMIT ${BATCH}`;
 for(let cursor=st.seq;;){const rows=cached(db,sql).all(company,cursor,max,...EVENTS);for(const r of rows)apply(st,db,company,r);if(rows.length<BATCH)break;cursor=rows[rows.length-1].sequence;}
 st.seq=max;st.results.clear();return st;
}
// ---- Input checks ----
const cents=(v,label)=>{if(v===undefined||v===null||v==='')return null;return integer(v,label+' (cents)',0,MAX_CENTS);};
const minDaysOf=v=>v===undefined||v===null||v===''?null:integer(v,'Minimum hire (days)',1,365);
const noteOf=v=>{if(v===undefined||v===null||v==='')return null;requireRule(typeof v==='string'&&v.trim().length<=120,'Keep the note to 120 characters.');return v.trim()||null;};
const dayArg=(v,label)=>{if(!(typeof v==='string'&&DAY.test(v)&&addDays(v,0)===v))throw new AppError(400,label+' must be a date (YYYY-MM-DD).');return v;};
const stamp=o=>{const {id,kind,version,...rest}=o;return rest;};

export const hireMethods={
 hireRequire(){if(!this.auth.permissions(this.user).includes('finance.view'))throw new AppError(403,'Hire figures are for the owner only.');},
 // Standard rate for one material (cents ex GST); every field empty removes it.
 hireRate(input){const p=this.effective(input.product);requireRule(p&&!p.retired,'Choose a material from the catalogue.');const week=cents(input.week,'Week rate'),day=cents(input.day,'Day rate'),minDays=minDaysOf(input.minDays);
  const old=this.repo.all('hireRate').find(r=>r.product===p.id),data={product:p.id,week,day,minDays,updatedAt:new Date().toISOString(),updatedBy:this.user.id};
  const empty=week==null&&day==null&&minDays==null;let saved=null;if(old){if(empty)this.repo.remove(old.id,'hireRate');else saved=this.repo.save({...old,...data});}else if(!empty)saved=this.repo.add('hireRate',data);
  // The ledger row names what changed, never the money: operations managers read the history too.
  this.repo.event(this.user.id,'HIRE_RATE',{product:p.id,reason:(empty?'Hire rate removed for ':'Hire rate set for ')+p.name,key:this.key});
  return {message:empty?'Hire rate removed for '+p.name+'.':'Hire rate saved for '+p.name+'.',rate:saved?stamp(saved):null};},
 // A site's own rate for one material (a negotiated rate); an empty field uses the standard rate, every field empty removes the override.
 hireSiteRate(input){const site=this.repo.get(input.site,'site'),p=this.effective(input.product);requireRule(p,'Choose a material from the catalogue.');const week=cents(input.week,'Week rate'),day=cents(input.day,'Day rate'),minDays=minDaysOf(input.minDays),note=noteOf(input.note);
  const old=this.repo.all('hireSiteRate').find(r=>r.site===site.id&&r.product===p.id),data={site:site.id,product:p.id,week,day,minDays,note,updatedAt:new Date().toISOString(),updatedBy:this.user.id};
  const empty=week==null&&day==null&&minDays==null;let saved=null;if(old){if(empty)this.repo.remove(old.id,'hireSiteRate');else saved=this.repo.save({...old,...data});}else if(!empty)saved=this.repo.add('hireSiteRate',data);
  this.repo.event(this.user.id,'HIRE_RATE',{product:p.id,reason:(empty?'Site hire rate removed for ':'Site hire rate set for ')+p.name+' at '+site.name,key:this.key});
  return {message:empty?'Site rate removed: '+site.name+' uses the standard rate for '+p.name+'.':'Site rate saved for '+p.name+' at '+site.name+'.',rate:saved?stamp(saved):null};},
 // GET /api/hire?site=&from=&to= : the overview, every rate, and one site's statement when a site is given. Cached until the next ledger row (every command writes one).
 hire(query={}){this.hireRequire();const company=this.user.company_id,cal=calendarNow(),today=cal.today,st=sync(this.db,company);
  const site=query.site||null,from=query.from||null,to=query.to||null,key=[today,site,from,to].join('|');const hit=st.results.get(key);if(hit)return hit;
  const result=this.hireView(st,cal,{site,from,to});st.results.set(key,result);if(st.results.size>16)st.results.delete(st.results.keys().next().value);return result;},
 hireView(st,cal,{site,from,to}){
  const today=cal.today,weekStart=cal.weekStart,catalogue=this.catalogue().byId,sites=this.repo.all('site'),siteById=new Map(sites.map(s=>[s.id,s]));
  const rates=this.repo.all('hireRate').map(stamp),siteRates=this.repo.all('hireSiteRate').map(stamp),std=new Map(rates.map(r=>[r.product,r])),over=new Map(siteRates.map(r=>[r.site+'|'+r.product,r]));
  const rateAt=(s,p)=>hireRateFor(std.get(p),over.get(s+'|'+p));
  const product=id=>{const p=catalogue.get(id);return {id,name:p?.name??'Removed material',reference:p?.reference??null,system:p?.system??null,category:p?.category??null,demo:p?.verification==='DEMO ONLY',retired:!!p?.retired};};
  const onHire=new Map(),everOn=new Set();let unpricedNow=new Map();
  // The next scheduled return (collection) still to leave each site: hire ends for what it loads on the day the site crane puts it on the truck
  // (the PLACEMENT row above), so the page can say when hire is booked to end. Read only; collections live in their own mixin (collections.js).
  const nextCollection=new Map();for(const c of this.repo.all('collection')){if(!['REQUESTED','BOOKED','LOADING'].includes(c.status))continue;const was=nextCollection.get(c.site);if(!was||(c.status==='LOADING'&&was.status!=='LOADING')||(was.status!=='LOADING'&&String(c.neededOn??'9')<String(was.neededOn??'9')))nextCollection.set(c.site,{id:c.id,status:c.status,neededOn:c.neededOn??null,slot:c.slot??'ANY',late:!!c.neededOn&&c.neededOn<today});}
  const rows=[];let pieces=0,weekSum=0,weekMissing=0,runRate=0,longest=null,sitesOn=0;
  for(const [sid,byProduct] of st.book){const s=siteById.get(sid);if(!s)continue;let n=0,since=null,accrued=0,week=0,missing=new Set(),rr=0,first=null;
   for(const [pid,lots] of byProduct){everOn.add(pid);const rate=rateAt(sid,pid),openQ=lots.open.reduce((a,l)=>a+l.q,0);
    const start=[...lots.closed.map(l=>l.start),...lots.open.map(l=>l.start)].sort()[0];if(start&&(!first||start<first))first=start;
    if(openQ){n+=openQ;onHire.set(pid,(onHire.get(pid)??0)+openQ);const s0=lots.open[0].start;if(!since||s0<since)since=s0;if(!longest||s0<longest.since)longest={site:sid,siteName:s.name,product:pid,name:product(pid).name,since:s0,days:daysBetween(s0,today)+1};
     if(rate.priced)rr+=openQ*rate.perWeek;else unpricedNow.set(pid,(unpricedNow.get(pid)??0)+openQ);}
    if(!start)continue;const all=hirePeriod(lots,start,today,today,rate.minDays),wk=hirePeriod(lots,weekStart,today,today,rate.minDays);
    if(!all.pieceDays&&!all.topUp)continue;if(!rate.priced){missing.add(pid);continue;}accrued+=hireAmount(all.pieceDays+all.topUp,rate);week+=hireAmount(wk.pieceDays+wk.topUp,rate);}
   if(!first)continue;if(n)sitesOn++;pieces+=n;weekSum+=week;runRate+=rr;weekMissing+=missing.size?1:0;
   rows.push({id:sid,name:s.name,client:s.client??null,address:s.address??null,status:s.status,pieces:n,since,days:since?daysBetween(since,today)+1:0,first,accrued,thisWeek:week,runRate:rr,missing:[...missing],overrides:siteRates.filter(r=>r.site===sid).length,collection:nextCollection.get(sid)??null});}
  rows.sort((a,b)=>(b.pieces>0)-(a.pieces>0)||(a.since??'9').localeCompare(b.since??'9')||a.name.localeCompare(b.name,undefined,{numeric:true}));
  // The live count at sites (contents table), so the page can show the replay agrees with the Stock page.
  let actual=0;for(const r of cached(this.db,"SELECT json_extract(o.data,'$.location') loc,SUM(ct.quantity) q FROM contents ct JOIN objects o ON o.company_id=ct.company_id AND o.id=ct.container_id WHERE ct.company_id=? AND ct.quantity>0 GROUP BY loc").all(this.user.company_id))if(siteById.has(r.loc))actual+=r.q;
  const products=[...new Set([...everOn,...rates.map(r=>r.product),...siteRates.map(r=>r.product)])].map(id=>({...product(id),onHire:onHire.get(id)??0,everOnHire:everOn.has(id)})).sort((a,b)=>b.onHire-a.onHire||(b.everOnHire-a.everOnHire)||a.name.localeCompare(b.name,undefined,{numeric:true}));
  const unpriced=[...unpricedNow].map(([id,q])=>({...product(id),pieces:q})).sort((a,b)=>b.pieces-a.pieces);
  const result={seq:st.seq,today,weekStart,monthStart:today.slice(0,8)+'01',generatedAt:new Date().toISOString(),gstPercent:GST_PERCENT,firstDay:st.first,
   totals:{pieces,sites:sitesOn,activeSites:sites.filter(s=>s.status==='ACTIVE').length,thisWeek:weekSum,runRate,weekMissing,longest},
   check:{rebuilt:pieces,actual,ok:pieces===actual},sites:rows,unpriced,products,rates,siteRates,
   siteList:sites.map(s=>({id:s.id,name:s.name,status:s.status,onHire:rows.some(r=>r.id===s.id)})).sort((a,b)=>(b.onHire-a.onHire)||(a.status==='ACTIVE'?0:1)-(b.status==='ACTIVE'?0:1)||a.name.localeCompare(b.name,undefined,{numeric:true})),
   statement:null};
  if(site)result.statement=this.hireStatement(st,site,from,to,cal,{rateAt,product,siteById});
  return result;},
 // One site's statement: a line per material with piece-days in the period (plus a minimum-hire line where pieces went back early), subtotal, GST and total.
 hireStatement(st,siteId,from,to,cal,{rateAt,product,siteById}){
  const today=cal.today,s=siteById.get(siteId);if(!s)throw new AppError(404,'Record not found in your company.');
  from=from?dayArg(from,'From'):today.slice(0,8)+'01';to=to?dayArg(to,'To'):today;requireRule(from<=today,'The statement cannot start after today.');requireRule(from<=to,'The statement starts after it ends. Pick a From date on or before the To date.');
  const clamped=to>today;if(clamped)to=today;requireRule(daysBetween(from,to)+1<=MAX_DAYS,'Choose a period of at most '+MAX_DAYS+' days.');
  const days=daysBetween(from,to)+1,daily=new Array(days).fill(0),lines=[];let subtotal=0,missing=0,demo=false,pieceDays=0;
  for(const [pid,lots] of st.book.get(siteId)??[]){const rate=rateAt(siteId,pid),p=hirePeriod(lots,from,to,today,rate.minDays);if(!p.pieceDays&&!p.topUp)continue;
   p.daily.forEach((n,i)=>{daily[i]+=n;});pieceDays+=p.pieceDays;const info=product(pid),amount=hireAmount(p.pieceDays,rate),topAmount=p.topUp?hireAmount(p.topUp,rate):null;if(info.demo)demo=true;
   if(!rate.priced)missing++;else subtotal+=amount+(topAmount??0);
   lines.push({product:info,start:p.start,end:p.end,peak:Math.max(...p.daily),pieceDays:p.pieceDays,rate,amount,topUp:p.topUp?{pieceDays:p.topUp,amount:topAmount,minDays:rate.minDays}:null,daily:p.daily});}
  lines.sort((a,b)=>b.pieceDays-a.pieceDays||a.product.name.localeCompare(b.product.name,undefined,{numeric:true}));
  const gst=hireGst(subtotal);
  return {site:{id:s.id,name:s.name,address:s.address??null,client:s.client??null,contact:s.contact??null,phone:s.phone??null,email:s.email??null,status:s.status},from,to,days,clamped,today,
   lines,daily,pieceDays,subtotal,gst,total:subtotal+gst,missing,complete:missing===0,demo,overrides:lines.filter(l=>l.rate.source==='site').length,onHireNow:lines.reduce((a,l)=>a+(to===today?l.end:0),0)};},
 // GET /api/hire.csv?site=&from=&to= : the statement as a spreadsheet (lines, totals, then pieces on hire per day).
 hireCSV(query={}){requireRule(query.site,'Choose a site for the statement.');const r=this.hire(query),s=r.statement,company=cached(this.db,'SELECT name FROM companies WHERE id=?').get(this.user.company_id)?.name??'';
  const money=c=>c==null?'':hireMoney(c),basis=rate=>!rate.priced?'NO RATE SET':rate.day!=null?'per day':'per week / 7',rateText=rate=>!rate.priced?'':rate.day!=null?hireMoney(rate.day):hireMoney(rate.week);
  const rows=[['HIRE STATEMENT'+(s.demo?' (DEMO ONLY - demonstration products, not a real statement)':'')],['Company',company],['Site',s.site.name],['Client',s.site.client??''],['Period',s.from+' to '+s.to+(s.clamped?' (to today)':''),s.days+' days'],['Amounts','AUD, ex GST unless marked'],...(s.missing?[['WARNING',s.missing+' material(s) have no hire rate and are NOT included in the totals']]:[]),[],
   ['Material','Reference','System','Pieces at start','Pieces at end','Piece-days','Rate basis','Rate (AUD ex GST)','Rate source','Amount (AUD ex GST)']];
  for(const l of s.lines){rows.push([l.product.name,l.product.reference??'',l.product.system??'',l.start,l.end,l.pieceDays,basis(l.rate),rateText(l.rate),l.rate.source??'',money(l.amount)]);if(l.topUp)rows.push([l.product.name+' - minimum hire top-up ('+l.topUp.minDays+' days)',l.product.reference??'',l.product.system??'','','',l.topUp.pieceDays,basis(l.rate),rateText(l.rate),l.rate.source??'',money(l.topUp.amount)]);}
  rows.push([],['Subtotal (ex GST)','','','','','','','','',money(s.subtotal)],['GST '+GST_PERCENT+'%','','','','','','','','',money(s.gst)],['Total (inc GST)','','','','','','','','',money(s.total)],[],['Pieces on hire per day'],['Date',...s.lines.map(l=>l.product.name),'All materials']);
  for(let i=0;i<s.days;i++)rows.push([addDays(s.from,i),...s.lines.map(l=>l.daily[i]),s.daily[i]]);
  const csv=rows.map(row=>row.map(value=>'"'+String(value??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"').join(',')).join('\r\n');
  const slug=String(s.site.name).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40)||'site';
  return {csv,name:'hire-statement-'+slug+'-'+s.from+'-to-'+s.to+'.csv'};}
};
