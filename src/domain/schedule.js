import { requireRule } from './geometry.js';
import { cached } from '../database.js';
// Dates on yard lists and single requests. A day is a 'YYYY-MM-DD' string: the local calendar date of the server process (the owner's PC),
// never the UTC date. Arithmetic on days is done on the string through Date.UTC, so daylight saving cannot shift it.
const DAYS=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAY=/^\d{4}-\d{2}-\d{2}$/;
export const SLOTS=['ANY','AM','PM'];
export const pad2=n=>String(n).padStart(2,'0');
export const localDay=(d=new Date())=>`${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
const utc=day=>{const [y,m,d]=day.split('-').map(Number);return Date.UTC(y,m-1,d);};
export const addDays=(day,n)=>{const [y,m,d]=day.split('-').map(Number);return new Date(Date.UTC(y,m-1,d+n)).toISOString().slice(0,10);};
export const weekdayOf=day=>(new Date(utc(day)).getUTCDay()+6)%7;// 0=Mon .. 6=Sun
export const mondayOf=day=>addDays(day,-weekdayOf(day));
export const dayLabel=day=>{const [,m,d]=day.split('-').map(Number);return `${DAYS[weekdayOf(day)]} ${d} ${MONTHS[m-1]}`;};
export const daysBetween=(from,to)=>Math.round((utc(to)-utc(from))/86400000);
// Working days are Monday to Friday; there is no holiday calendar.
export function calendarNow(now=new Date()){const today=localDay(now),wd=weekdayOf(today);return {today,tomorrow:addDays(today,1),nextWorkday:addDays(today,wd===4?3:wd===5?2:1),weekStart:mondayOf(today),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone};}
export function parseDay(value,{required=false,cal}={}){
  if(value===undefined||value===null||value===''){requireRule(!required,'Choose a needed-on date.');return null;}
  requireRule(typeof value==='string'&&DAY.test(value)&&addDays(value,0)===value,'Enter the needed-on date as YYYY-MM-DD.');
  const c=cal??calendarNow();
  requireRule(value>=c.today,'The needed-on date cannot be in the past. Choose today or later.');
  requireRule(value<=addDays(c.today,366),'Choose a needed-on date within the next 12 months.');
  return value;
}
export function parseSlot(v){if(v===undefined||v===null||v==='')return 'ANY';requireRule(SLOTS.includes(v),'Choose a delivery window: any time, morning or afternoon.');return v;}
export function urgencyOf(neededOn,closed,cal){
  if(closed)return {urgency:'DONE',daysLate:0};if(!neededOn)return {urgency:'UNDATED',daysLate:0};
  if(neededOn<cal.today)return {urgency:'OVERDUE',daysLate:daysBetween(neededOn,cal.today)};
  return {urgency:neededOn===cal.today?'TODAY':neededOn===cal.tomorrow?'TOMORROW':'LATER',daysLate:0};
}
export const slotsOverlap=(a,b)=>a==='ANY'||b==='ANY'||a===b;
// Priority-ladder rung for a yard list: NOW = P2 (needed today or overdue), NEXT = P3 (by the next working day), LATER = no job yet.
// Undated lists keep the old guess: packs reserved on a truck = today, otherwise tomorrow.
export function ladderBucket(view,cal){if(view.neededOn)return view.neededOn<=cal.today?'NOW':view.neededOn<=cal.nextWorkday?'NEXT':'LATER';return view.truck?'NOW':'NEXT';}
export function whenWords(neededOn,cal){if(!neededOn)return '';if(neededOn<cal.today)return 'overdue (was needed '+dayLabel(neededOn)+')';if(neededOn===cal.today)return 'needed today';if(neededOn===cal.tomorrow)return 'needed tomorrow';return 'needed '+dayLabel(neededOn);}
const SLOT_ORDER={AM:0,ANY:1,PM:2},SLOT_WORDS={ANY:'any time',AM:'AM',PM:'PM'};
export const runOrder=(a,b)=>(a.neededOn===b.neededOn?0:a.neededOn===null?1:b.neededOn===null?-1:a.neededOn<b.neededOn?-1:1)||(SLOT_ORDER[a.slot??'ANY']-SLOT_ORDER[b.slot??'ANY'])||String(a.createdAt??'').localeCompare(String(b.createdAt??''));
const CLOSED_REQUEST=['DELIVERED','CANCELLED','RETURNED'];
export const scheduleMethods={
  calendar(){return calendarNow();},
  // Can its date and truck still change? A list until it is cancelled or leaves the yard; a single request while nothing is delivered.
  // A single request leaves the yard when its truck is dispatched (dispatch stamps request.delivery), exactly like a list.
  schedulable(o){if(o.kind==='loadList')return !o.cancelled&&!o.delivery;return !o.loadList&&!(o.delivery&&o.status!=='REQUESTED')&&['REQUESTED','ALLOCATED','PARTIALLY ALLOCATED'].includes(o.status)&&!(o.delivered>0);},
  // The site check comes first, so a supervisor learns nothing about records on sites they do not run.
  scheduleTarget(id){requireRule(typeof id==='string'&&id.length>0,'Choose a yard list or request to schedule.');const o=this.repo.get(id);this.assertSite(o.kind==='loadList'||o.kind==='request'?o.site:o.id);requireRule(!(o.kind==='request'&&o.loadList),'This request belongs to a yard list. Change the yard list instead.');requireRule(o.kind==='loadList'||o.kind==='request','Choose a yard list or request to schedule.');return o;},
  assertSchedulable(o){if(o.kind==='loadList'){requireRule(!o.cancelled,'This yard list is cancelled.');requireRule(!o.delivery,'This yard list has left the yard. Its date and truck can no longer change.');}else{requireRule(!(o.delivery&&!(o.delivered>0)&&['ALLOCATED','PARTIALLY ALLOCATED'].includes(o.status)),'This request has left the yard. Its date and truck can no longer change.');requireRule(this.schedulable(o),'This request is already delivered or closed.');}},
  scheduleLabel(o){if(o.kind==='loadList')return o.name;let name='material';try{name=this.repo.get(o.product,'product').name;}catch{}return `${o.quantity} × ${name}`;},
  truckNameOf(id){if(!id)return null;try{return this.repo.get(id,'truck').name;}catch{return null;}},
  reschedule(input){
    const o=this.scheduleTarget(input?.id);this.assertSchedulable(o);
    const cal=this.calendar(),neededOn=parseDay(input.neededOn,{required:true,cal}),slot=input.slot===undefined?(o.slot??'ANY'):parseSlot(input.slot);
    const kind=o.kind,label=this.scheduleLabel(o),urgency=urgencyOf(neededOn,false,cal).urgency;
    if(neededOn===(o.neededOn??null)&&slot===(o.slot??'ANY'))return {id:o.id,kind,neededOn,slot,urgency,changed:false,message:`${label} is already needed ${dayLabel(neededOn)}${slot!=='ANY'?' ('+slot+')':''}.`};
    const prev=o.neededOn??null,prevSlot=o.slot??'ANY',moved=prev!==neededOn;if(moved)o.previousNeededOn=prev;o.neededOn=neededOn;o.slot=slot;o.rescheduledAt=new Date().toISOString();o.rescheduledBy=this.user.id;this.repo.save(o);
    const message=`${label}: now needed ${dayLabel(neededOn)}${slot!=='ANY'?' ('+slot+')':''}${moved&&prev?' (was '+dayLabel(prev)+')':!moved?' (was '+SLOT_WORDS[prevSlot]+')':''}.`;
    this.notify(kind==='loadList'?'Yard list rescheduled':'Request rescheduled',message,o.site);
    return {id:o.id,kind,neededOn,slot,urgency,changed:true,message};
  },
  // Books (or unbooks) the truck planned for a run. Needs no truck at the yard, reserves nothing and never touches truck.destination.
  bookTruck(input){
    const o=this.scheduleTarget(input?.id);this.assertSchedulable(o);
    requireRule(input.truck===null||typeof input.truck==='string','Choose a truck.');
    const t=input.truck?this.repo.get(input.truck,'truck'):null;if(t)requireRule(!t.retired,`${t.name} has been removed.`);
    const want=t?.id??null;
    if(o.truck&&want!==o.truck)requireRule(false,`Packs are already reserved on ${this.truckNameOf(o.truck)??'another truck'}. Cancel the ${o.kind==='loadList'?'yard list':'request'} to change its truck.`);
    const label=this.scheduleLabel(o);
    // Nothing changes (the same truck again, or no truck on an unbooked run): no save and no notification, like a same-value reschedule.
    if((o.plannedTruck??null)===want){const clash=this.clashIndex().get(o.id)?.count??0;let message=t?label+' is already booked on '+t.name+'.':label+' has no truck booked.';if(clash>0)message+=' Clash: it also runs to another site that day.';return {id:o.id,kind:o.kind,plannedTruck:want,plannedTruckName:t?.name??null,clash,changed:false,message};}
    o.plannedTruck=want;o.bookedAt=new Date().toISOString();o.bookedBy=this.user.id;this.repo.save(o);
    const clash=this.clashIndex().get(o.id)?.count??0;
    let message=t?`${t.name} booked for ${label}${o.neededOn?' on '+dayLabel(o.neededOn):''}.`:`${label} needs a truck again.`;
    this.notify(t?'Truck booked':'Truck booking removed',message,o.site);
    if(clash>0)message+=' Clash: it also runs to another site that day.';
    return {id:o.id,kind:o.kind,plannedTruck:want,plannedTruckName:t?.name??null,clash,changed:true,message};
  },
  // Extra snapshot fields for a list view (o.status is the view status) or a single request. truckName: id -> name, retired trucks included.
  // Lookups built once per pass (snapshot, loadLists, deriveJobs), so no row does its own repo.get: truck names (retired included), sites, permissions.
  scheduleCtx(perms=this.auth.permissions(this.user)){const names=new Map(this.repo.all('truck').map(t=>[t.id,t.name])),sites=new Map(this.repo.all('site').map(s=>[s.id,s]));return {perms,truckName:id=>names.get(id)??null,siteOf:id=>sites.get(id)??null};},
  scheduleFields(o,cal=this.calendar(),ctx=this.scheduleCtx()){const {truckName,perms,siteOf}=ctx;
    const list=o.kind==='loadList',closed=list?(o.cancelled||o.status==='DELIVERED'||o.status==='CANCELLED'):CLOSED_REQUEST.includes(o.status);
    const neededOn=o.neededOn??null,slot=o.slot??'ANY',{urgency,daysLate}=urgencyOf(neededOn,closed,cal);
    const plannedTruck=o.plannedTruck??null,runTruck=o.truck??plannedTruck,site=siteOf(o.site);
    const schedulable=this.schedulable(o);
    const canReschedule=schedulable&&perms.includes('requests.create')&&(perms.includes('operations.manage')||site?.supervisor===this.user.id);
    return {neededOn,slot,urgency,daysLate,plannedTruck,plannedTruckName:plannedTruck?truckName(plannedTruck):null,runTruck,runTruckName:runTruck?truckName(runTruck):null,siteName:site?.name??null,schedulable,canReschedule};
  },
  // Clashes across the whole company (not filtered by what the viewer sees): the same run truck, the same day, different sites, overlapping windows.
  // rows: the caller's own list of every loadList and request in the company (the operations snapshot has them already); otherwise read here.
  clashIndex(rows){
    // Reads only the dated rows and the handful of fields it needs (no full-object decode), since the snapshot builds it every poll.
    const items=(rows??cached(this.db,"SELECT id,kind,json_extract(data,'$.site') site,json_extract(data,'$.neededOn') neededOn,json_extract(data,'$.slot') slot,json_extract(data,'$.truck') truck,json_extract(data,'$.plannedTruck') plannedTruck,json_extract(data,'$.cancelled') cancelled,json_extract(data,'$.delivery') delivery,json_extract(data,'$.status') status,json_extract(data,'$.loadList') loadList,json_extract(data,'$.delivered') delivered FROM objects WHERE company_id=? AND kind IN ('loadList','request') AND json_extract(data,'$.neededOn') IS NOT NULL").all(this.repo.company)).filter(o=>this.schedulable(o)).map(o=>({id:o.id,site:o.site,neededOn:o.neededOn??null,slot:o.slot??'ANY',runTruck:o.truck??o.plannedTruck??null})).filter(x=>x.neededOn&&x.runTruck);
    const groups=new Map();for(const x of items){const k=x.runTruck+'|'+x.neededOn;let g=groups.get(k);if(!g)groups.set(k,g=[]);g.push(x);}
    const out=new Map();for(const g of groups.values()){if(g.length<2)continue;for(const a of g)for(const b of g){if(a===b||a.site===b.site||!slotsOverlap(a.slot,b.slot))continue;let e=out.get(a.id);if(!e)out.set(a.id,e={count:0,with:[]});e.count++;e.with.push(b.id);}}
    return out;
  }
};
