// @ts-check
// The Today planner: calendar items that run themselves on their day (the Today page's monthly calendar).
//   TRUCK      a fleet truck (or a hired-in one for the day) with a driver, who is asked at once and must say yes
//   MATERIALS  a list for a site: the yardsman is asked to pack it on the day (or the day before); packing holds whole stillages (a reservation
//              with task:null and plan:<item>), and at the item's time the booked truck (or the next free one) is loaded and the game board's
//              truck autopilot (game.js gameStep) drives, unloads with the site crane and comes home. Stock never teleports.
//   WORKERS    "3 workers to Bondi at 7:00": each person is asked the day before at 3 pm; on the day the ones who said yes go to the site (people
//              are not stock: they move at once) and come home at 5 pm
//   RESTACK    the yard crew tops up part-full stillages of the same part and stacks empties (jobs.js restack mode)
// Messages are in-app only (there is no text-message provider): planDeliver is the one place a message is "sent", the seam a real SMS
// provider would replace. In the demo the people answer by themselves after a short, fixed delay (plantime.js planSimAnswer).
// planTick runs after every engine tick (game.js installGame), at most once a second: everything compares planNow() with stored days and times,
// so a pass that runs late (the app was closed) catches up, and a pass run twice at the same moment writes nothing.
import { requireRule,integer } from './geometry.js';
import { AppError } from '../service.js';
import { cached,savepoint } from '../database.js';
import { active } from './inventory.js';
import { localDay,addDays,dayLabel,calendarNow } from './schedule.js';
import { DAY_START,SEND_BEFORE,DAY_END,atLocal,parseTime,timeWords,planSimAnswer } from './plantime.js';
import { gpChoose,gpPerStillage } from '../../public/game-pick.js';
import { idleWorker } from './fleet.js';
import { DEMO_NAME } from './team.js';
import { lineList } from './game.js';
/** @typedef {import('../repository.js').StoredObject} StoredObject */
/** @typedef {'TRUCK'|'MATERIALS'|'WORKERS'|'RESTACK'} PlanType */
/** PLANNED and ACTIVE are open; DONE, CANCELLED and CALLED_OFF are closed; MISSED waits for a new day or Cancel. @typedef {'PLANNED'|'ACTIVE'|'DONE'|'MISSED'|'CANCELLED'|'CALLED_OFF'} PlanStatus */
/** One line of an item's history. @typedef {{at:string,text:string}} PlanLog */
/** A calendar item (kind 'planItem'); stage says where an open item is in its day (ASKING, READY, WAITING, BOOKED, ...).
 * @typedef {StoredObject & {type:PlanType,day:string,time:string,site:string|null,yard?:string,status:PlanStatus,stage:string,note:string|null,problem:string|null,log:PlanLog[]}} PlanItem */
/** An in-app message to a person about an item (kind 'message'); planDeliver is the one place a message is sent.
 * @typedef {StoredObject & {person:string,personKind:string,personName:string,item:string,itemType:PlanType,day:string,time:string,site:string|null,subject:string,needsAnswer:boolean,status:'WAITING_TO_SEND'|'SENT'|string,sendAt:string,sentAt:string|null,answeredAt:string|null,seenAt:string|null,answer:string|null,attempt:number,channel:'IN_APP'}} PlanMessage */
export { planSimAnswer };
/** Commands the planner handles. @type {string[]} */
export const PLAN_OPS=['planTruck','planMaterials','planWorkers','planRestack','planMove','planCancel','planAsk','messageAnswer','messageSeen','teamAdd','teamUpdate','teamRemove','teamStart','teamNames','planReplies'];
/** @type {string[]} */
export const PAPERWORK_OPS=['paperworkAdd','paperworkUpdate','paperworkRemove','paperworkSettings'];
/** @type {PlanStatus[]} */
export const PLAN_OPEN=['PLANNED','ACTIVE'],MSG_OPEN=['WAITING_TO_SEND','SENT'];
// MISSED: a list whose day ended before it went (its stillages are let go); it waits on the calendar, red, for a new day or Cancel.
/** @type {PlanStatus[]} */
export const PLAN_FIXABLE=[...PLAN_OPEN,'MISSED'];
const HEAVY=10000000,DAY=/^\d{4}-\d{2}-\d{2}$/,LOG_KEEP=20,PRUNE_DAYS=400,QUIET_MS=60000,YARD_KEEP=2,SLOT_MS=1800000;
/** @type {(ms:number)=>string} */
const iso=ms=>new Date(ms).toISOString();
/** @type {(n:number,one:string,many?:string)=>string} */
const plural=(n,one,many=one+'s')=>n+' '+(n===1?one:many);
/** @type {(a:{name?:unknown},b:{name?:unknown})=>number} */
const byName=(a,b)=>String(a.name).localeCompare(String(b.name),undefined,{numeric:true});
/** @type {(event:string,fields:Record<string,unknown>)=>void} */
const logError=(event,fields)=>{try{console.error(JSON.stringify({event,...fields}));}catch{}};
/** An optional note (at most 200 characters): null when empty. @type {(v:unknown)=>string|null} */
const note=v=>{if(v===undefined||v===null)return null;requireRule(typeof v==='string','A note must be text.');const s=v.trim();if(!s)return null;requireRule(s.length<=200,'A note can be at most 200 characters.');return s;};
// The engine's last full pass per database and company (throttle, once-a-day prune).
/** @type {WeakMap<object,Map<string,any>>} */
const runs=new WeakMap();
// open items and MISSED lists (the engine steps only the open ones; a removed site, truck or person reaches the missed ones too)
const OPEN_ITEMS="SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='planItem' AND json_extract(data,'$.status') IN ('PLANNED','ACTIVE','MISSED') ORDER BY rowid";
const DAY_ITEMS="SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='planItem' AND json_extract(data,'$.day')=? ORDER BY rowid";
const ITEM_MSGS="SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='message' AND json_extract(data,'$.item')=? ORDER BY rowid";
const DUE_MSGS="SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='message' AND json_extract(data,'$.status')='WAITING_TO_SEND' ORDER BY rowid";
const SENT_MSGS="SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='message' AND json_extract(data,'$.status')='SENT' AND coalesce(json_type(data,'$.closedAt'),'null')='null' ORDER BY rowid";
const PERSON_MSGS="SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='message' AND json_extract(data,'$.person')=? ORDER BY rowid";
const PROBE=`SELECT EXISTS(SELECT 1 FROM objects WHERE company_id=?1 AND kind='planItem' AND json_extract(data,'$.status') IN ('PLANNED','ACTIVE'))
 OR EXISTS(SELECT 1 FROM objects WHERE company_id=?1 AND kind='message' AND json_extract(data,'$.status') IN ('WAITING_TO_SEND','SENT') AND coalesce(json_type(data,'$.closedAt'),'null')='null')
 OR EXISTS(SELECT 1 FROM objects WHERE company_id=?1 AND kind='resource' AND json_type(data,'$.away')='object')
 OR EXISTS(SELECT 1 FROM objects WHERE company_id=?1 AND kind='truck' AND json_type(data,'$.hired')='object' AND coalesce(json_extract(data,'$.retired'),0)=0) busy`;
export const planMethods={
  planNowCal(){return calendarNow(new Date(this.planNow()));},
  planDay(v,cal){requireRule(typeof v==='string'&&DAY.test(v)&&addDays(v,0)===v,'Choose a day on the calendar.');requireRule(v>=cal.today,'That day has passed. Choose today or a later day.');requireRule(v<=addDays(cal.today,366),'Choose a day within the next 12 months.');return v;},
  // Today, a time already gone is refused (the calendar only offers what is still ahead): a truck or workers need a time still to come (people
  // answer before it), a list or a re-stack may start in the current half hour; nothing is booked for today once the day has ended at 5 pm.
  planWhen(type,day,time,now=this.planNow()){if(day!==localDay(new Date(now)))return;requireRule(now<atLocal(day,DAY_END),'Today is nearly over. Choose tomorrow or a later day.');
    const at=atLocal(day,time);requireRule(type==='TRUCK'||type==='WORKERS'?at>now:at+SLOT_MS>now,'That time has passed. Choose a later time or tomorrow.');},
  planRows(sql,...args){return cached(this.db,sql).all(this.repo.company,...args).map(row=>this.repo.decode(row));},
  planDayItems(day,type,{open=true}={}){return this.planRows(DAY_ITEMS,day).filter(i=>(!type||i.type===type)&&(open?i.status!=='CANCELLED':true));},
  planLog(it,text,now=this.planNow()){const log=it.log??[];if(log.at(-1)?.text===text)return;it.log=[...log,{at:iso(now),text}].slice(-LOG_KEEP);},
  // Load, change and save one item only when something changed (a pass run twice writes nothing).
  planEdit(id,fn){const it=this.repo.get(id,'planItem'),before=JSON.stringify(it);const r=fn(it);if(JSON.stringify(it)!==before){it.updatedAt=iso(this.planNow());this.repo.save(it);}return r;},
  planName(id,fallback='someone'){if(!id)return fallback;try{return this.repo.get(id).name??fallback;}catch{return fallback;}},
  planSiteName(id){if(!id)return 'the site';try{return this.repo.get(id,'site').name;}catch{return 'the site';}},
  planTruckWords(it){if(it.hire)return (it.hire.size==='SMALL'?'a small':'a big')+' hire truck';let t=null;try{t=this.repo.get(it.truck,'truck');}catch{}return t?t.name+' ('+(t.payload>=HEAVY?'big':'small')+' truck)':'a truck';},
  planTruckOf(it){if(!it)return null;const id=it.truck??it.hire?.truck??null;if(!id)return null;try{return this.repo.get(id,'truck');}catch{return null;}},
  planCompany(){const r=this.bdRecord?.();return r?.tradingName||this.bdCompanyName?.()||'the office';},
  planYard(){return this.repo.all('yard')[0]??null;},
  // ---------- messages ----------
  planMsgText(m,it){const who=!m.personName||DEMO_NAME.test(m.personName)?'there':m.personName.split(' ')[0],when=dayLabel(it.day),at=timeWords(it.time);
    if(m.subject==='DRIVE'){const loads=this.planRows(DAY_ITEMS,it.day).filter(x=>x.type==='MATERIALS'&&x.truckPlan===it.id&&x.status!=='CANCELLED').map(x=>this.planSiteName(x.site));
      return 'Hi '+who+', can you drive '+this.planTruckWords(it)+' on '+when+' from '+at+'? '+(loads.length?'Loads for '+[...new Set(loads)].join(' and ')+'.':'Yard runs.')+' Please reply yes or no. – '+this.planCompany();}
    if(m.subject==='PACK'){const names=it.lines.map(l=>l.quantity+' × '+this.planName(l.product,'material')),tp=it.truckPlan?(()=>{try{return this.repo.get(it.truckPlan,'planItem');}catch{return null;}})():null,t=this.planTruckOf(tp);
      return 'Hi '+who+', please pack this list for '+this.planSiteName(it.site)+(it.pack==='DAY_BEFORE'?' today, for '+when:' on '+when)+': '+names.slice(0,2).join(', ')+(names.length>2?' (+'+(names.length-2)+' more)':'')+'. '+(t?t.name:tp?.hire?'The hire truck':'The next free truck')+' picks it up at '+at+'.';}
    let site=null;try{site=this.repo.get(it.site,'site');}catch{}const addr=site?.address&&site.address!=='Demonstration site'?' ('+site.address+')':'';
    return 'Hi '+who+", you're on "+(site?.name??'a site')+addr+' on '+when+' from '+at+'. Can you make it? Please reply yes or no.';},
  planMsgSummary(m){const who=m.personName||'someone',when=dayLabel(m.day);if(m.subject==='DRIVE'){let it=null;try{it=this.repo.get(m.item,'planItem');}catch{}return 'Asked '+who+' to drive '+(it?this.planTruckWords(it).replace(/ \((big|small) truck\)$/,''):'a truck')+' on '+when+'.';}
    if(m.subject==='PACK')return 'Asked '+who+' to pack the list for '+this.planSiteName(m.site)+' on '+when+'.';return 'Asked '+who+' to work at '+this.planSiteName(m.site)+' on '+when+'.';},
  // A new ask of one person for one item; sent at once when it is due (it always is: asks are made when their time comes).
  planAskPerson(it,person,personKind,subject,now,{quiet=false,sendAt=now}={}){const p=this.teamPerson(person);if(!p)return null;
    const attempt=this.planRows(ITEM_MSGS,it.id).filter(m=>m.person===person&&m.subject===subject).length+1;
    const m=this.repo.add('message',{person,personKind,personName:p.name,item:it.id,itemType:it.type,day:it.day,time:it.time,site:it.site??null,subject,text:'',needsAnswer:subject!=='PACK',status:'WAITING_TO_SEND',sendAt:iso(Math.max(sendAt,now)),sentAt:null,answeredAt:null,seenAt:null,answer:null,attempt,channel:'IN_APP',outbound:{provider:null,ref:null},calledOffAt:null,calledOffWhy:null,closedAt:null,createdAt:iso(now)});
    if(Date.parse(m.sendAt)<=now)this.planDeliver(m,it,now,{quiet});return m.id;},
  // The only place a message is sent. A text-message provider would replace this body (and post answers back to messageAnswer).
  planDeliver(m,it,now,{quiet=false}={}){const msg=this.repo.get(m.id,'message');if(msg.status!=='WAITING_TO_SEND')return msg;const p=this.teamPerson(msg.person);if(p)msg.personName=p.name;
    msg.text=this.planMsgText(msg,it);msg.status='SENT';msg.sentAt=iso(now);msg.outbound={provider:null,ref:null};this.repo.save(msg);if(!quiet)this.notify('Message sent',this.planMsgSummary(msg),msg.site);return msg;},
  planCallOff(id,why,now){if(!id)return;let m=null;try{m=this.repo.get(id,'message');}catch{return;}if(m.status==='CALLED_OFF')return;m.status='CALLED_OFF';m.calledOffAt=iso(now);m.calledOffWhy=why;this.repo.save(m);},
  planCallOffAll(it,why,now){for(const m of this.planRows(ITEM_MSGS,it.id))if(m.status!=='CALLED_OFF')this.planCallOff(m.id,why,now);},
  // An item that is done: its unanswered messages can no longer be answered.
  planCloseMsgs(it,now){for(const m of this.planRows(ITEM_MSGS,it.id))if(MSG_OPEN.includes(m.status)&&!m.closedAt){m.closedAt=iso(now);this.repo.save(m);}},
  planMsg(id){if(!id)return null;try{return this.repo.get(id,'message');}catch{return null;}},
  planAnswerMsg(m,{yes,reason=null,by=null,via},at){m.status=yes?'YES':'NO';m.answeredAt=iso(at);m.answer={yes,reason:yes?null:reason,by,via};if(m.needsAnswer===false&&!m.seenAt)m.seenAt=iso(at);this.repo.save(m);
    if(!yes)this.notify("Can't make it",(m.personName||'Someone')+" can't make it on "+dayLabel(m.day)+(reason?': '+reason:'')+'. Ask someone else on the Today page.',m.site);return m;},
  planDeliverDue(now){for(const m of this.planRows(DUE_MSGS)){if(Date.parse(m.sendAt)>now)continue;let it=null;try{it=this.repo.get(m.item,'planItem');}catch{}if(!it||!PLAN_OPEN.includes(it.status)){this.planCallOff(m.id,'The plan changed',now);continue;}this.planDeliver(m,it,now);}},
  planSimReplies(now){const cfg=this.repo.all('config')[0];if(cfg?.planReplies===false)return;
    for(const m of this.planRows(SENT_MSGS)){if(!m.needsAnswer&&m.seenAt)continue;const s=planSimAnswer(m),at=Date.parse(m.sentAt)+s.delaySec*1000;if(now<at)continue;
      if(m.needsAnswer)this.planAnswerMsg(m,{yes:s.yes,reason:s.reason,by:null,via:'SIMULATED'},at);else{m.seenAt=iso(at);this.repo.save(m);}}},
  // ---------- the engine ----------
  planTick(elapsed=0){const now=this.planNow();let byCompany=runs.get(this.db);if(!byCompany)runs.set(this.db,byCompany=new Map());let st=byCompany.get(this.repo.company);if(!st)byCompany.set(this.repo.company,st={last:-Infinity,acc:0,day:null});
    st.acc+=Number(elapsed)||0;if(now-st.last<1000&&st.acc<1000)return false;st.last=now;st.acc=0;
    const today=localDay(new Date(now)),prune=st.day!==today;
    if(!prune&&!cached(this.db,PROBE).get(this.repo.company).busy)return false;
    try{savepoint(this.db,'plan_tick',()=>{if(prune)this.planPrune(today);this.planPass(now);});st.day=today;return true;}
    catch(error){logError('plan_tick_error',{message:error.message});return false;}},
  planPass(now=this.planNow()){
    this.planDeliverDue(now);this.planSimReplies(now);
    const items=this.planRows(OPEN_ITEMS).filter(i=>PLAN_OPEN.includes(i.status)).sort((a,b)=>a.day.localeCompare(b.day)||a.time.localeCompare(b.time)||String(a.createdAt).localeCompare(String(b.createdAt)));
    for(const it of items){try{savepoint(this.db,'plan_item',()=>this.planStep(it.id,now));}
      catch(error){if(!error.status)logError('plan_item_error',{item:it.id,message:error.message});try{savepoint(this.db,'plan_item_problem',()=>this.planEdit(it.id,x=>{x.problem=error.status?error.message:'Something went wrong. It tries again in a moment.';}));}catch{}}}
    this.planHomeSweep(now);this.planHireSweep(now);},
  planStep(id,now=this.planNow()){return this.planEdit(id,it=>{if(!PLAN_OPEN.includes(it.status))return;const today=localDay(new Date(now));
    if(it.type==='TRUCK')this.planStepTruck(it,now,today);else if(it.type==='MATERIALS')this.planStepMaterials(it,now,today);else if(it.type==='WORKERS')this.planStepWorkers(it,now,today);else if(it.type==='RESTACK')this.planStepRestack(it,now,today);
    if(!PLAN_OPEN.includes(it.status))this.planCloseMsgs(it,now);});},
  planDone(it,now,text){it.status='DONE';it.doneAt=iso(now);it.problem=null;if(text)this.planLog(it,text,now);},
  // A day that ended with nothing done (it never ran, or nobody confirmed) is never written as done: it waits on the calendar, red, like a list
  // that didn't go, until the office picks a new day or cancels it.
  planMissed(it,now,why){it.status='MISSED';it.missedAt=iso(now);it.why=why;it.problem="Didn't go: "+why+'. Pick a new day or cancel it.';this.planLog(it,"Didn't go: "+why+'.',now);},
  // ----- TRUCK -----
  planStepTruck(it,now,today){const end=today>it.day||(today===it.day&&now>=atLocal(it.day,DAY_END)),started=today>it.day||(today===it.day&&now>=atLocal(it.day,DAY_START));
    let problem=null;const driver=it.driver?this.teamPerson(it.driver):null,name=driver?.name??'The driver';
    if(it.driver&&!it.message&&!end){it.message=this.planAskPerson(it,it.driver,'driver','DRIVE',now);if(it.message)it.stage=started?'ON':'ASKING';}
    const m=this.planMsg(it.message);
    if(m&&m.status==='YES'){if(it.stage==='ASKING')it.stage='READY';if(it.heard!==m.id+':YES'){it.heard=m.id+':YES';this.planLog(it,name+' said yes.',now);}}
    else if(m&&m.status==='NO'){problem=name+" can't make it"+(m.answer?.reason?': '+m.answer.reason:'')+'. Pick another driver.';if(it.heard!==m.id+':NO'){it.heard=m.id+':NO';this.planLog(it,name+" can't make it.",now);}}
    if(!it.driver&&it.needsDriver)problem='Needs a driver. Pick one.';
    if(!it.truck&&!it.hire)problem=(it.truckGone?it.truckGone+' was removed. ':'')+'Cancel it and book another truck.';
    if(started&&!end&&it.status==='PLANNED'){it.status='ACTIVE';it.stage='ON';}
    if(it.hire&&!it.hire.truck&&!it.hire.goneAt&&started&&!end){const yard=this.planYard();if(yard){const big=it.hire.size!=='SMALL',names=new Set(this.repo.all('truck').filter(t=>!t.retired).map(t=>t.name));let n=1;while(names.has('Hire truck '+n))n++;
      const t=this.truck({name:'Hire truck '+n,yard:yard.id,payload:big?12500000:2000000,length:big?6000:4200,width:big?2050:1900,stackLimit:big?2:1});const f=this.repo.get(t.id,'truck');f.hired={item:it.id,day:it.day};this.repo.save(f);
      it.hire={...it.hire,truck:t.id,arrivedAt:iso(now)};this.planLog(it,t.name+' is at the yard.',now);this.notify('Hire truck',t.name+' is at the yard for today.',null);}}
    if(end){if(!it.hire?.truck){const why=it.status==='PLANNED'?'the day passed while the app was closed':!it.truck&&!it.hire?(it.truckGone??'the truck')+' was removed':it.driver&&m?.status!=='YES'?name+(m?.status==='NO'?" couldn't drive":' never said yes'):!it.driver&&it.needsDriver?'no driver was picked':null;
        if(why){this.planMissed(it,now,why);return;}}
      if(it.hire?.truck&&!it.hire.goneAt){if(!this.planHireGone(it,now)){it.status='ACTIVE';it.stage='ON';it.problem='Hire truck is still out. It goes back when it is home.';return;}}
      this.planDone(it,now);return;}
    it.problem=problem;},
  // A hired truck goes back when it is home and empty (retireTruck's own rules); true when it has gone.
  planHireGone(it,now){const t=this.planTruckOf(it);if(!t||t.retired){it.hire={...it.hire,goneAt:it.hire.goneAt??iso(now)};return true;}
    if(t.status!=='AT_YARD'||t.at!==t.yard||t.game||!this.idleTruck(t))return false;
    try{savepoint(this.db,'plan_hire_gone',()=>this.retireTruck(this.repo.get(t.id,'truck')));}catch(e){if(!e.status)throw e;return false;}
    it.hire={...it.hire,goneAt:iso(now)};this.planLog(it,t.name+' has gone back.',now);return true;},
  // Hired trucks whose booking was cancelled (or closed some other way): back when home and empty.
  planHireSweep(now){const today=localDay(new Date(now));for(const t of this.repo.all('truck')){if(!t.hired||t.retired)continue;let it=null;try{it=this.repo.get(t.hired.item,'planItem');}catch{}
    if(it&&PLAN_OPEN.includes(it.status))continue;if(!(!it||it.status==='CANCELLED'||today>t.hired.day||now>=atLocal(t.hired.day,DAY_END)||it.status==='DONE'))continue;
    try{savepoint(this.db,'plan_hire_sweep',()=>{if(it)this.planEdit(it.id,x=>{if(x.hire&&!x.hire.goneAt)this.planHireGone(x,now);});else if(t.status==='AT_YARD'&&!t.game&&this.idleTruck(t))this.retireTruck(this.repo.get(t.id,'truck'));});}catch(e){if(!e.status)logError('plan_hire_error',{truck:t.id,message:e.message});}}},
  // ----- MATERIALS -----
  planPacker(it){const yard=this.planYard();if(!yard)return null;const kinds=this.placeKinds?.();const pool=this.repo.all('resource').filter(r=>r.type==='WORKER'&&r.enabled&&r.location===yard.id&&!r.away);
    const named=pool.find(r=>r.id===it.packer);if(named)return named;return pool.filter(r=>this.roleOf(r,kinds)==='YARDSMAN').sort(byName)[0]??null;},
  planStepMaterials(it,now,today){const yard=this.planYard();if(!yard){it.problem='Set up your yard first.';return;}
    const cfg=this.repo.all('config')[0]??{},jobsOff=cfg.jobs===false||!!cfg.jobsFault,start=atLocal(it.day,it.time),due=today>it.day||(today===it.day&&now>=start),over=today>it.day||now>=atLocal(it.day,DAY_END);let problem=null,stuck=null;
    // the site went (removed, archived, being removed) with nothing out on a truck for it: called off
    let site=null;try{site=this.repo.get(it.site,'site');}catch{}const siteName=site?.name??'the site';
    if((!site||site.status!=='ACTIVE'||site.finishing)&&!(it.trips??[]).some(x=>!x.done)){this.planRelease(it,now);this.planCallOffAll(it,'The site was removed',now);it.status='CANCELLED';it.cancelledAt=iso(now);it.cancelReason='Site removed';it.problem=null;this.planLog(it,'Cancelled: '+siteName+' was removed.',now);return;}
    // held stillages that are no longer in the yard (moved by hand, removed): off the list
    if((it.left??[]).length){const keep=[];for(const id of it.left){let c=null;try{c=this.repo.get(id,'container');}catch{}if(c&&!c.retired&&c.location===yard.id)keep.push(id);else{this.planRelease(it,now,[id]);this.planLog(it,(c?.name??'A stillage')+' is no longer in the yard, so it was taken off the list.',now);}}it.left=keep;}
    // follow the trips: on the road, then delivered; an unload the site crane can't do (nobody there to work it) is said plainly, and tried again
    // once the crew is back
    for(const trip of it.trips??[]){if(trip.done)continue;let t=null;try{t=this.repo.get(trip.truck,'truck');}catch{}
      if(!trip.delivery){const d=this.planTripDelivery(trip,it.site);if(d){trip.delivery=d.id;it.stage='ON_THE_WAY';this.planLog(it,(t?.name??'The truck')+' is on the way to '+siteName+'.',now);}}
      if(trip.delivery){let d=null;try{d=this.repo.get(trip.delivery,'delivery');}catch{}if(d?.status==='DELIVERED'){trip.done=true;trip.delivered=true;trip.doneAt=iso(now);this.planLog(it,'Delivered to '+siteName+'.',now);}}
      else if(!t||t.game?.plan!==it.id){trip.done=true;trip.delivered=false;trip.doneAt=iso(now);this.planLog(it,"The load on "+(t?.name??'the truck')+" didn't go. It is back in the yard.",now);}
      if(!trip.done&&t?.status==='AT_SITE'&&t.at===it.site){const ids=new Set(trip.containers??[]),b=this.tasks().find(x=>active(x)&&x.state==='BLOCKED'&&ids.has(x.container));
        if(b){const crane=/operator|required workers/i.test(b.reason??'');stuck=t.name+' is waiting at '+siteName+': '+(crane?'nobody there to work the crane.':String(b.reason??'it cannot unload yet.'));
          const crew=this.repo.all('resource').filter(r=>r.type==='WORKER'&&r.enabled&&r.location===it.site&&!r.task&&!r.mountedOn).length;
          if(crane&&crew>=Math.max(1,cfg.craneWorkers??1)&&(!trip.retryAt||now>=Date.parse(trip.retryAt))){trip.retryAt=iso(now+60000);try{savepoint(this.db,'plan_unload_retry',()=>this.retry({id:b.id}));this.planLog(it,'The crew is back at '+siteName+': unloading again.',now);}catch(e){if(!e.status)throw e;}}}}}
    const trips=it.trips??[],out=trips.some(x=>!x.done);
    if(trips.length&&!out&&!(it.left??[]).length&&!['WAITING','PACKING'].includes(it.stage)){
      if(trips.some(x=>x.delivered)){it.stage='DELIVERED';this.planDone(it,now);this.notify('Delivered','Delivered to '+siteName+': the list for '+dayLabel(it.day)+'.',it.site);return;}
      it.status='CANCELLED';it.cancelledAt=iso(now);it.cancelReason='The load came back';this.planLog(it,'Nothing was delivered. Plan it again if it is still needed.',now);it.problem=null;return;}
    // the day is over and nothing is out on a truck: what went is delivered (the rest is let go), or it didn't go at all. Then it waits on the
    // calendar as MISSED (its stillages let go, nobody asked late) until the office picks a new day or cancels it.
    if(over&&!out){
      if(trips.some(x=>x.delivered)){const left=(it.left??[]).length;this.planRelease(it,now);it.stage='DELIVERED';it.leftOver=left;this.planDone(it,now,'Part of the list stayed in the yard ('+plural(left,'stillage')+'). Plan the rest if it is still needed.');this.notify('Delivered','Delivered to '+siteName+': part of the list for '+dayLabel(it.day)+'.',it.site);return;}
      const why=it.stage==='WAITING'?'the day passed while the app was closed':!(it.held??[]).length?'nothing on the list was free in the yard':trips.length?'the load came back':it.why??'no truck could take it before the end of the day';
      this.planRelease(it,now);it.status='MISSED';it.stage='MISSED';it.missedAt=iso(now);it.why=why;it.problem="Didn't go: "+why+'. Pick a new day or cancel it.';this.planLog(it,"Didn't go: "+why+'.',now);
      this.notify("Didn't go",'The list for '+siteName+' on '+dayLabel(it.day)+" didn't go: "+why+'. Pick a new day on the Today page.',it.site);return;}
    if(it.stage==='WAITING'&&now>=atLocal(it.packDay,DAY_START)){const packer=this.planPacker(it);
      if(packer){it.packer=packer.id;it.packMessage=this.planAskPerson(it,packer.id,'worker','PACK',now);this.planLog(it,packer.name+' has been asked to pack it.',now);}else this.planLog(it,'No yardsman in the team, so nobody was sent a message.',now);
      it.stage='PACKING';if(jobsOff&&this.planPack(it,now))this.planLog(it,'Packed by the office (yard jobs are switched off).',now);}
    if(it.stage==='PACKING'&&due){if(this.planPack(it,now))this.planLog(it,"Packed by the office so the truck isn't held up.",now);}
    // only once someone has tried to pack it (at its time, or by the office when yard jobs are off): until then the crew's PACK job is on the board
    if(it.stage==='PACKING'&&!(it.held??[]).length&&(due||jobsOff))problem='Nothing on the list is free in the yard right now.';
    // packed short: topped up as soon as more of it is free in the yard (stock back from a site, a stocktake finished)
    if(it.stage==='PACKED'&&(it.short??[]).length)this.planTopUp(it,now);
    // at its time: onto the booked truck (or the next free one) once it is free and its driver said yes
    if(['PACKED','LOADING','ON_THE_WAY'].includes(it.stage)&&(it.left??[]).length&&due){const pick=this.planPickTruck(it,yard,now);if(pick.problem){problem=pick.problem;it.why=pick.why??null;}else this.planSend(it,pick.truck,now);if(it.problem&&!problem)problem=it.problem;}
    if(it.stage!=='WAITING'&&it.status==='PLANNED')it.status='ACTIVE';// its day's work has started (packing)
    if(stuck)problem=stuck;
    if(!problem&&(it.short??[]).length)problem='Short: '+it.short.map(x=>(x.want-x.got)+' × '+this.planName(x.product,'material')).join(', ')+" weren't in the yard.";
    it.problem=problem;},
  // More stillages for a list packed short, when more of what it is missing is free in the yard.
  planTopUp(it,now){const yard=this.planYard(),want=(it.short??[]).map(x=>({product:x.product,quantity:x.want-x.got})).filter(l=>l.quantity>0);if(!yard||!want.length)return false;
    const pick=gpChoose(this.gameItems([yard.id]).get(yard.id),want);if(!pick.ids.length)return false;
    for(const id of pick.ids)for(const l of this.repo.lines(id))this.repo.add('reservation',{container:id,product:l.product_id,quantity:l.quantity,task:null,plan:it.id,active:true});
    const got={...(it.got??{})};for(const [p,q] of pick.got)got[p]=(got[p]??0)+q;
    it.held=[...(it.held??[]),...pick.ids];it.left=[...(it.left??[]),...pick.ids];it.got=got;it.short=(it.short??[]).map(x=>({...x,got:Math.min(x.want,x.got+(pick.got.get(x.product)??0))})).filter(x=>x.got<x.want);
    this.planLog(it,'Topped up: '+plural(pick.ids.length,'more stillage')+' set aside'+(it.short.length?'.':'. Nothing is short now.'),now);return true;},
  // The trip's run to the site: the delivery made when the truck left with the trip's stillages on board.
  planTripDelivery(trip,site){const ids=new Set(trip.containers??[]);let t=null;try{t=this.repo.get(trip.truck,'truck');}catch{}
    const mine=d=>d&&d.to===site&&d.truck===trip.truck&&d.id!==trip.before&&(d.containers??[]).some(id=>ids.has(id));
    if(t?.delivery){let d=null;try{d=this.repo.get(t.delivery,'delivery');}catch{}if(mine(d))return d;}
    return this.repo.all('delivery').filter(d=>mine(d)&&String(d.createdAt)>=String(trip.at)).at(-1)??null;},
  planPickTruck(it,yard,now){const free=this.gameFreeTrucks(yard);
    if(it.truckPlan){let tp=null;try{tp=this.repo.get(it.truckPlan,'planItem');}catch{}
      const drop=why=>{it.truckPlan=null;this.planLog(it,why,now);};
      if(!tp||tp.status==='CANCELLED')drop('The truck booking was cancelled, so it goes on the next free truck.');
      else{const t=this.planTruckOf(tp);
        if(tp.hire&&!tp.hire.truck&&!tp.hire.goneAt&&tp.status!=='DONE')return {problem:'Waiting for the hire truck to arrive.',why:'the hire truck never came'};
        if(!t||t.retired){drop((t?.name??tp.truckGone??'The booked truck')+' is not there any more, so it goes on the next free truck.');}
        else{if(tp.driver){const m=this.planMsg(tp.message),dn=this.planName(tp.driver,'the driver');if(m?.status!=='YES')return {problem:'Waiting for '+dn+' to say yes (or tap They said yes on the phone).',why:m?.status==='NO'?dn+" couldn't drive":dn+' never said yes'};}
          if(!free.some(x=>x.id===t.id))return {problem:'Waiting for '+t.name+' to come back.',why:t.name+' never came back to the yard'};return {truck:t};}}}
    // the next free truck, but never one booked today whose driver hasn't said yes (it would drive with nobody confirmed)
    const unsure=new Set();for(const x of this.planDayItems(dayOf(now),'TRUCK')){if(!PLAN_OPEN.includes(x.status))continue;const tt=this.planTruckOf(x);if(!tt)continue;const m=this.planMsg(x.message);if(x.needsDriver||(x.driver&&m?.status!=='YES'))unsure.add(tt.id);}
    const ok=free.filter(t=>!unsure.has(t.id));
    if(!ok.length)return free.length?{problem:'Waiting for a truck whose driver has said yes.',why:'no truck had a driver who said yes'}:{problem:'Waiting for a truck to come back.',why:'no truck was free'};return {truck:ok[0]};},
  // Hold whole stillages for the list (game-pick.js, as the board's Send picks them): a reservation per line with task:null and plan:<item>.
  planPack(it,now){const yard=this.planYard();if(!yard)return false;if((it.held??[]).length)return true;
    const items=this.gameItems([yard.id]).get(yard.id),pick=gpChoose(items,it.lines);if(!pick.ids.length){it.problem='Nothing on the list is free in the yard right now.';return false;}
    for(const id of pick.ids)for(const l of this.repo.lines(id))this.repo.add('reservation',{container:id,product:l.product_id,quantity:l.quantity,task:null,plan:it.id,active:true});
    it.held=[...pick.ids];it.left=[...pick.ids];it.got=Object.fromEntries(pick.got);it.short=pick.short;it.stage='PACKED';it.packedAt=iso(now);it.problem=null;
    this.planLog(it,'Packed: '+plural(pick.ids.length,'stillage')+' set aside for '+this.planSiteName(it.site)+'.',now);return true;},
  // A PACK yard job finished (jobs.js EFFECTS.PACK).
  planPackJob(id,w){const now=this.planNow();return this.planEdit(id,it=>{requireRule(PLAN_OPEN.includes(it.status)&&it.stage==='PACKING','Already packed.');
    requireRule(this.planPack(it,now),'Nothing on the list is free in the yard right now.');this.planLog(it,'Packed by '+w.name+'.',now);
    const m=this.planMsg(it.packMessage);if(m&&!m.seenAt&&m.person===w.id){m.seenAt=iso(now);this.repo.save(m);}return 'Packed '+plural(it.held.length,'stillage')+' for '+this.planSiteName(it.site);});},
  planRelease(it,now,only=null){const ids=only?new Set(only):null;for(const r of this.repo.all('reservation'))if(r.active&&r.plan===it.id&&(!ids||ids.has(r.container))){r.active=false;r.releasedAt=iso(now);this.repo.save(r);}
    if(!only){it.left=[];}},
  // The held stillages still in the yard onto the truck, tops of piles first, each in its own savepoint: what does not fit (or cannot be lifted
  // yet) stays held for the next trip. The board's autopilot then takes the trip (truck.game with plan: <item>).
  planSend(it,truck,now){const yard=this.planYard(),site=this.repo.get(it.site,'site');
    return savepoint(this.db,'plan_send',()=>{const stored=this.containers().filter(c=>c.location===yard.id),byId=new Map(stored.map(c=>[c.id,c]));
      const level=c=>{let n=0;for(let cur=c;cur?.support&&byId.has(cur.support)&&n<20;cur=byId.get(cur.support))n++;return n;};
      const ids=(it.left??[]).filter(id=>byId.has(id)).sort((a,b)=>level(byId.get(b))-level(byId.get(a))||String(byId.get(a).name).localeCompare(String(byId.get(b).name),undefined,{numeric:true}));
      const loaded=[];let first=null;
      for(const id of ids){try{savepoint(this.db,'plan_load',()=>{this.planRelease(it,now,[id]);this.loadTruck({truck:truck.id,containers:[id]});});loaded.push(id);}catch(e){if(!e.status)throw e;first??=e.message;}}
      if(!loaded.length){it.problem=first??'Nothing could be loaded.';return false;}
      const t=this.repo.get(truck.id,'truck'),before=t.delivery??null;t.destination=site.id;t.game={kind:'SEND',site:site.id,stage:'LOADING',since:iso(now),stillages:loaded.length,problem:null,retryAt:null,plan:it.id};this.repo.save(t);this.gameCrew(site);
      const pieces=loaded.reduce((n,id)=>n+this.repo.lines(id).reduce((k,l)=>k+l.quantity,0),0);
      it.trips=[...(it.trips??[]),{truck:t.id,truckName:t.name,at:iso(now),stillages:loaded.length,pieces,containers:loaded,before,delivery:null,done:false}];
      it.left=(it.left??[]).filter(id=>!loaded.includes(id));it.stage='LOADING';it.problem=null;this.planLog(it,t.name+' is loading '+plural(loaded.length,'stillage')+' for '+site.name+'.',now);return true;});},
  // ----- WORKERS -----
  planStepWorkers(it,now,today){const sendAt=atLocal(addDays(it.day,-1),SEND_BEFORE),start=atLocal(it.day,it.time),end=atLocal(it.day,DAY_END),siteName=this.planSiteName(it.site);
    const over=today>it.day||now>=end;
    if(over){if(it.status==='PLANNED'){this.planMissed(it,now,'the day passed while the app was closed');return;}
      let all=true;for(const p of it.people){if(!p.moved||p.homeAt)continue;if(this.planMoveWorker(p.person,'home',it,now)){p.homeAt=iso(now);this.planLog(it,this.planName(p.person)+' went home.',now);}else all=false;}
      if(all&&!it.people.some(p=>p.moved)){this.planMissed(it,now,!it.people.length?'nobody was free that day':it.people.some(p=>this.planMsg(p.message)?.status==='YES')?'nobody got to the site':'nobody confirmed they were coming');return;}
      if(all){this.planDone(it,now);}else it.problem='Waiting for everyone to finish before they go home.';return;}
    // the asks go out the day before at 3 pm (at once when it is booked later than that)
    if(now>=sendAt){let sent=0;for(const p of it.people){if(p.message)continue;p.message=this.planAskPerson(it,p.person,'worker','WORK',now,{quiet:true});if(p.message)sent++;}
      if(sent){if(it.stage==='BOOKED'&&Date.parse(it.createdAt)<sendAt&&now-sendAt>600000)this.planLog(it,'Sent late: the app was closed.',now);this.planLog(it,'Asked '+plural(sent,'person','people')+' to come to '+siteName+'.',now);this.notify('Message sent','Asked '+plural(sent,'person','people')+' to work at '+siteName+' on '+dayLabel(it.day)+'.',it.site);}
      if(it.stage==='BOOKED')it.stage='ASKING';}
    if(today===it.day&&now>=start){if(it.status==='PLANNED'){it.status='ACTIVE';it.stage='ON_SITE';}const first=!it.people.some(p=>p.moved);let moved=0;
      for(const p of it.people){if(p.moved)continue;const m=this.planMsg(p.message);if(m?.status!=='YES')continue;if(this.planMoveWorker(p.person,it.site,it,now)){p.moved=true;p.arrivedAt=iso(now);p.from=this.repo.get(p.person,'resource').away?.from??null;moved++;this.planLog(it,this.planName(p.person)+' is at '+siteName+'.',now);}}
      if(first&&moved)this.notify('On site',plural(moved,'worker is','workers are')+' at '+siteName+'.',it.site);}
    const gaps=it.count-it.people.length;it.problem=gaps>0?'Short by '+gaps+': nobody else is free that day. Tap Ask someone.':null;},
  // One person to a site (they are not stock: they go at once) or home again. Only when they are free: a worker on a forklift or crane move waits
  // for the next pass; a yard job is handed back. force: home even from a walk (used when their site goes).
  planMoveWorker(id,dest,it,now,{force=false}={}){let w=null;try{w=this.repo.get(id,'resource');}catch{return true;}if(!w.enabled)return true;
    if(dest==='home'){if(!w.away)return true;if(w.task||w.mountedOn||(!force&&!idleWorker(w)))return false;const kinds=this.placeKinds();const back=['yard','site'].includes(kinds.get(w.away.from))?w.away.from:this.planYard()?.id;if(!back)return false;
      if(w.job)this.releaseJob(w,'Going home');this.releaseMount(w);w.location=back;w.away=null;delete w.x;delete w.y;w.walk=null;w.workerMode='AUTO';w.workerReason=null;this.repo.save(w);return true;}
    if(w.away)return w.away.item===it.id&&w.location===dest;if(w.location===dest)return true;if(!idleWorker(w))return false;
    if(w.job)this.releaseJob(w,'Off to '+this.planSiteName(dest));w.away={item:it.id,from:w.location,since:iso(now)};w.location=dest;delete w.x;delete w.y;w.walk=null;w.workerMode='AUTO';w.workerReason=null;w.assignHoldUntil=null;this.repo.save(w);return true;},
  // Borrowed workers whose item was cancelled or has ended some other way go home when they are free.
  planHomeSweep(now){for(const w of this.repo.all('resource')){if(!w.away||w.type!=='WORKER')continue;let it=null;try{it=this.repo.get(w.away.item,'planItem');}catch{}
    if(it&&PLAN_OPEN.includes(it.status))continue;if(!this.planMoveWorker(w.id,'home',it,now))continue;
    if(it)this.planEdit(it.id,x=>{for(const p of x.people??[])if(p.person===w.id&&p.moved&&!p.homeAt){p.homeAt=iso(now);this.planLog(x,w.name+' went home.',now);}});}},
  // ----- RESTACK -----
  planStepRestack(it,now,today){const start=atLocal(it.day,it.time),end=atLocal(it.day,DAY_END),cfg=this.repo.all('config')[0]??{};
    if(it.stage==='WAITING'){if(today>it.day||now>=end){this.planMissed(it,now,/^Turn yard jobs on/.test(it.problem??'')?'yard jobs were switched off':'the day passed while the app was closed');return;}
      if(today===it.day&&now>=start){if(cfg.jobs===false||cfg.jobsFault){it.problem='Turn yard jobs on in the Control room so the crew can re-stack.';return;}
        it.status='ACTIVE';it.stage='WORKING';it.startedAt=iso(now);it.quietSince=null;it.problem=null;this.planLog(it,'The crew started re-stacking.',now);}else return;}
    if(it.stage!=='WORKING')return;
    const live=cached(this.db,"SELECT COUNT(*) n FROM objects WHERE company_id=? AND kind='job' AND json_extract(data,'$.yard')=? AND json_extract(data,'$.state') IN ('OPEN','ASSIGNED','IN_PROGRESS','BLOCKED') AND (json_extract(data,'$.key') LIKE 'P5:CONSOLIDATE:%' OR json_extract(data,'$.key') LIKE 'P7:STACK:%')").get(this.repo.company,it.yard).n;
    if(live)it.quietSince=null;else it.quietSince??=iso(now);
    const began=Date.parse(it.startedAt),quiet=it.quietSince?now-Date.parse(it.quietSince):0;
    if(!(today>it.day||now>=end||(now-began>=QUIET_MS&&quiet>=QUIET_MS)))return;
    const pieces=cached(this.db,"SELECT COALESCE(SUM(quantity),0) n FROM ledger WHERE company_id=? AND event='CONSOLIDATED' AND created_at>=?").get(this.repo.company,it.startedAt).n;
    const done=cached(this.db,"SELECT json_extract(data,'$.key') k FROM objects WHERE company_id=? AND kind='job' AND json_extract(data,'$.yard')=? AND json_extract(data,'$.state')='DONE' AND json_extract(data,'$.completedAt')>=? AND (json_extract(data,'$.key') LIKE 'P5:CONSOLIDATE:%' OR json_extract(data,'$.key') LIKE 'P7:STACK:%')").all(this.repo.company,it.yard,it.startedAt);
    const stacked=done.filter(r=>String(r.k).startsWith('P7:STACK:')).length;it.moved={pieces,jobs:done.length,stacked};it.finishedAt=iso(now);
    const text='Re-stack done: '+plural(pieces,'piece')+' topped up into fuller stillages, '+plural(stacked,'empty','empties')+' stacked.';this.planDone(it,now,text);this.notify('Re-stack done',text,null);},
  // The yard's re-stack switches while one is WORKING (jobs.js deriveJobs restack mode), or null.
  planRestackFor(yardId){const row=cached(this.db,"SELECT data FROM objects WHERE company_id=? AND kind='planItem' AND json_extract(data,'$.type')='RESTACK' AND json_extract(data,'$.stage')='WORKING' AND json_extract(data,'$.status')='ACTIVE' AND json_extract(data,'$.yard')=? LIMIT 1").get(this.repo.company,yardId);
    if(!row)return null;const d=JSON.parse(row.data);return {consolidate:d.consolidate!==false,stackEmpties:d.stackEmpties!==false};},
  // MATERIALS items being packed at this yard (jobs.js deriveJobs PACK jobs).
  planPacking(yardId){return cached(this.db,"SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='planItem' AND json_extract(data,'$.type')='MATERIALS' AND json_extract(data,'$.stage')='PACKING' AND json_extract(data,'$.status') IN ('PLANNED','ACTIVE') AND json_extract(data,'$.yard')=? ORDER BY rowid").all(this.repo.company,yardId).map(row=>this.repo.decode(row));},
  planPrune(today){const cut=addDays(today,-PRUNE_DAYS);
    for(const r of cached(this.db,"SELECT id,kind FROM objects WHERE company_id=? AND ((kind='planItem' AND json_extract(data,'$.status') IN ('DONE','CANCELLED','MISSED')) OR (kind='message' AND json_extract(data,'$.status') NOT IN ('WAITING_TO_SEND','SENT'))) AND json_extract(data,'$.day')<?").all(this.repo.company,cut))this.repo.remove(r.id,r.kind);
    for(const r of cached(this.db,"SELECT id FROM objects WHERE company_id=? AND kind='paperwork' AND json_extract(data,'$.archived')=1 AND COALESCE(json_extract(data,'$.expiresOn'),json_extract(data,'$.reviewedOn'))<?").all(this.repo.company,cut))this.repo.remove(r.id,'paperwork');},
  // ---------- hooks from the rest of the app ----------
  // A site removed, archived or being removed: its open lists and allocations are called off (a load already on a truck is left to the board,
  // which brings it home), and people borrowed there go home first.
  planSiteGone(siteId,why='removed'){const now=this.planNow();let name='the site';try{name=this.repo.get(siteId,'site').name;}catch{}let n=0;
    for(const it of this.planRows(OPEN_ITEMS)){if(it.site!==siteId)continue;if(it.type==='MATERIALS'&&['LOADING','ON_THE_WAY'].includes(it.stage))continue;
      this.planEdit(it.id,x=>{this.planRelease(x,now);this.planCallOffAll(x,'The site was '+why,now);for(const p of x.people??[])if(p.moved&&!p.homeAt&&this.planMoveWorker(p.person,'home',x,now,{force:true}))p.homeAt=iso(now);
        x.status='CANCELLED';x.cancelledAt=iso(now);x.cancelReason='Site '+why;x.problem=null;this.planLog(x,'Cancelled: '+name+' was '+why+'.',now);});n++;}
    for(const w of this.repo.all('resource'))if(w.away&&w.location===siteId)this.planMoveWorker(w.id,'home',null,now,{force:true});
    if(n)this.notify('Plans cancelled','Plans for '+name+' were cancelled because it was '+why+'.',null);return n;},
  // The Office reset a place's crew (logistics.js resources): people borrowed there go home first and are never switched off.
  planCrewReset(locId){const now=this.planNow();for(const w of this.repo.all('resource')){if(w.type!=='WORKER'||!w.away||w.location!==locId||w.task||w.mountedOn)continue;const item=w.away.item;
    if(this.planMoveWorker(w.id,'home',null,now,{force:true})){try{this.planEdit(item,x=>{for(const p of x.people??[])if(p.person===w.id){p.moved=false;p.arrivedAt=null;}this.planLog(x,'Sent home: site crew was reset.',now);});}catch(e){if(!e.status)throw e;}}}},
  planTruckGone(truckId){const now=this.planNow();let t=null;try{t=this.repo.get(truckId,'truck');}catch{return;}if(t.hired)return;
    for(const it of this.planRows(OPEN_ITEMS)){if(it.type!=='TRUCK'||it.truck!==truckId)continue;this.planEdit(it.id,x=>{x.truck=null;x.truckGone=t.name;x.problem=t.name+' was removed. Cancel it and book another truck.';this.planLog(x,t.name+' was removed.',now);});this.planUnlinkTruck(it.id,t.name+' was removed, so this list goes on the next free truck.',now);}},
  planUnlinkTruck(itemId,why,now){for(const x of this.planRows(OPEN_ITEMS))if(x.type==='MATERIALS'&&x.truckPlan===itemId)this.planEdit(x.id,m=>{m.truckPlan=null;this.planLog(m,why,now);});},
  // Someone left the team: their asks are called off, their places become gaps, and a list they were to pack falls back to the first yardsman.
  planPersonGone(kind,id){const now=this.planNow(),name=this.planName(id);
    for(const it of this.planRows(OPEN_ITEMS)){
      if(it.type==='TRUCK'&&it.driver===id)this.planEdit(it.id,x=>{this.planCallOff(x.message,name+' left the team',now);x.driver=null;x.message=null;x.needsDriver=true;x.stage='READY';this.planLog(x,name+' left the team. Needs a driver.',now);});
      else if(it.type==='WORKERS'&&it.people.some(p=>p.person===id&&!p.moved))this.planEdit(it.id,x=>{for(const p of x.people)if(p.person===id)this.planCallOff(p.message,name+' left the team',now);x.people=x.people.filter(p=>p.person!==id||p.moved);this.planLog(x,name+' left the team.',now);});
      else if(it.type==='MATERIALS'&&it.packer===id)this.planEdit(it.id,x=>{this.planCallOff(x.packMessage,name+' left the team',now);x.packer=null;if(x.stage==='WAITING')x.packMessage=null;this.planLog(x,name+' left the team; the first yardsman packs it.',now);});
      else continue;this.planStep(it.id,now);}
    for(const m of this.planRows(PERSON_MSGS,id))if(MSG_OPEN.includes(m.status)&&!m.closedAt)this.planCallOff(m.id,name+' left the team',now);},
  // ---------- commands (execute: operations.manage) ----------
  planReply(it,message){return {item:this.planItemView(this.repo.get(it.id??it,'planItem')),message};},
  planTruck(input){requireRule(input&&typeof input==='object','Choose a day and a truck.');const cal=this.planNowCal(),now=this.planNow(),day=this.planDay(input.day,cal),time=parseTime(input.time),yard=this.planYard();requireRule(yard,'Set up your yard first.');
    const has=v=>v!==undefined&&v!==null&&v!=='';requireRule(has(input.truck)!==has(input.hire),'Choose one of your trucks, or hire one in.');const same=this.planDayItems(day,'TRUCK').filter(x=>x.status!=='CANCELLED');let t=null,hire=null;
    if(has(input.truck)){t=this.repo.get(input.truck,'truck');requireRule(!t.retired,t.name+' has been removed.');requireRule(!t.hired,'Book a hire truck with Hire in a truck.');requireRule(!same.some(x=>x.truck===t.id),t.name+' is already booked on '+dayLabel(day)+'.');}
    else{requireRule(input.hire&&['BIG','SMALL'].includes(input.hire.size),'Choose a big or a small hire truck.');hire={size:input.hire.size,truck:null,arrivedAt:null,goneAt:null};}
    const driver=has(input.driver)?this.planDriver(input.driver,day,null):null;this.planWhen('TRUCK',day,time,now);
    const it=this.repo.add('planItem',{type:'TRUCK',day,time,site:null,status:'PLANNED',stage:driver?'ASKING':'READY',note:note(input.note),problem:null,log:[{at:iso(now),text:'Booked by '+this.user.name+'.'}],createdAt:iso(now),createdBy:this.user.id,updatedAt:iso(now),doneAt:null,cancelledAt:null,cancelledBy:null,cancelReason:null,truck:t?.id??null,hire,driver:driver?.id??null,message:null,needsDriver:false});
    this.planStep(it.id);const also=t&&[...this.repo.all('loadList'),...this.repo.all('request'),...this.repo.all('collection')].some(o=>(o.truck??o.plannedTruck)===t.id&&o.neededOn===day&&this.schedulable(o));
    return this.planReply(it,(t?t.name:(hire.size==='BIG'?'A big':'A small')+' hire truck')+' booked for '+dayLabel(day)+'. '+(driver?driver.name+' has been asked.':'No driver named.')+(also?' '+t.name+' also has a load booked that day. It will do both.':''));},
  // An active driver free that day (not driving another truck).
  planDriver(id,day,except){requireRule(typeof id==='string','Choose a driver.');let d=null;try{d=this.repo.get(id,'driver');}catch{}requireRule(d&&d.active,'Choose a driver from your team.');
    const clash=this.planDayItems(day,'TRUCK').find(x=>x.driver===d.id&&x.id!==except);if(clash)throw new AppError(409,d.name+' is already driving '+(clash.hire?'a hire truck':this.planName(clash.truck,'a truck'))+' that day.');return d;},
  planMaterialLines(lines,yard){const list=lineList(lines),lift=this.gameLift(yard);for(const l of list){const p=this.effective(l.product);requireRule(!p.retired,p.name+' has been removed from the catalogue.');requireRule(gpPerStillage(p,lift)>0,p.name+" has no weight in your parts list, so the crew can't lift it. Add its weight in the Office, Materials catalogue.");}return list;},
  planSite(id){requireRule(typeof id==='string'&&id,'Choose a site.');const s=this.repo.get(id,'site');this.assertSite(s.id);requireRule(s.status==='ACTIVE','Choose an active site.');requireRule(!s.finishing,s.name+' is being removed. Tap Keep it first.');return s;},
  planTruckItem(id,day){if(id===undefined||id===null||id==='')return null;requireRule(typeof id==='string','Choose a truck booked that day.');let tp=null;try{tp=this.repo.get(id,'planItem');}catch{}requireRule(tp&&tp.type==='TRUCK'&&tp.day===day&&PLAN_OPEN.includes(tp.status),'Choose a truck booked that day.');return tp;},
  planMaterials(input){requireRule(input&&typeof input==='object','Choose a day, a site and the parts.');const cal=this.planNowCal(),now=this.planNow(),day=this.planDay(input.day,cal),time=parseTime(input.time),yard=this.planYard();requireRule(yard,'Set up your yard first.');
    const site=this.planSite(input.site),lines=this.planMaterialLines(input.lines,yard),pack=input.pack===undefined||input.pack===null?'SAME_DAY':input.pack;requireRule(['SAME_DAY','DAY_BEFORE'].includes(pack),'Choose to pack it on the day or the day before.');
    const tp=this.planTruckItem(input.truckPlan,day);let packer=null;if(input.packer!==undefined&&input.packer!==null&&input.packer!==''){let w=null;try{w=this.repo.get(input.packer,'resource');}catch{}requireRule(w&&w.type==='WORKER'&&w.enabled&&w.location===yard.id,'Choose someone at the yard to pack it.');packer=w;}
    const packDay=pack==='SAME_DAY'?day:(addDays(day,-1)<cal.today?cal.today:addDays(day,-1));this.planWhen('MATERIALS',day,time,now);
    // a soft check against what is free in the yard now, made before anything is packed (never an error: planning is for the future)
    const free=this.planFree(yard),low=lines.find(l=>(free.get(l.product)??0)<l.quantity),snap=this.planSnapWords(lines,yard);
    const it=this.repo.add('planItem',{type:'MATERIALS',day,time,site:site.id,yard:yard.id,status:'PLANNED',stage:'WAITING',note:note(input.note),problem:null,log:[{at:iso(now),text:'Planned by '+this.user.name+'.'}],createdAt:iso(now),createdBy:this.user.id,updatedAt:iso(now),doneAt:null,cancelledAt:null,cancelledBy:null,cancelReason:null,
      lines,pack,packDay,truckPlan:tp?.id??null,packer:null,packMessage:null,held:[],got:{},short:[],left:[],trips:[]});
    const who=packer??this.planPacker(it);if(who)this.planEdit(it.id,x=>{x.packer=who.id;});
    this.planStep(it.id);
    return this.planReply(it,'List for '+site.name+' on '+dayLabel(day)+' planned. '+(who?who.name:'The crew')+' packs it '+(pack==='SAME_DAY'?'on the day.':'the day before.')+(low?' Only '+(free.get(low.product)??0)+' of '+this.planName(low.product,'that part')+' in the yard now.':'')+snap);},
  // The crew packs whole stillages (planPack, as the board's Send): what would go from the yard now for each line, said at booking when it is
  // more than was asked. " You asked for 30 Kwikstage standard 3.0 m. They come in stillages of 145, so 145 will go." ('' when every line is exact)
  planSnapWords(lines,yard){const {got}=gpChoose(this.gameItems([yard.id]).get(yard.id),lines),lift=this.gameLift(yard),out=[];
    for(const l of lines){const will=got.get(l.product)??0;if(will<=l.quantity)continue;const p=this.effective(l.product),per=gpPerStillage(p,lift);
      out.push('You asked for '+l.quantity+' '+p.name+'. '+(per>0&&will%per===0?'They come in stillages of '+per+', so ':'They go in whole stillages, so ')+will+' will go.');}
    return out.length?' '+out.slice(0,2).join(' ')+(out.length>2?' The same for '+plural(out.length-2,'more part')+'.':''):'';},
  // Pieces of each part free in the yard now (not held, not on a move).
  planFree(yard=this.planYard()){const free=new Map();if(!yard)return free;for(const c of this.gameItems([yard.id]).get(yard.id)??[])if(!c.busy)for(const [p,q] of c.lines)free.set(p,(free.get(p)??0)+q);return free;},
  // Who is free for a WORKERS item: scaffolders and leading hands at the yard first, then spare site crew from sites with no crane work that day
  // (always leaving the crane crew), then, as a last resort, yardsmen (never the one packing a list that day, and always leaving YARD_KEEP at
  // the yard); by name. Never someone already booked that day (someone who said they can't make it is free again).
  planPool(day,siteId,exclude=new Set()){const kinds=this.placeKinds(),workers=this.teamWorkers(kinds),keep=this.planKeep(),items=this.planDayItems(day);
    const taken=new Set([...exclude,...this.planTaken(day,items)]),crane=this.planCraneSites(day,items),home=w=>this.teamHome(w),free=w=>!taken.has(w.id);
    const packers=new Set(items.filter(x=>x.type==='MATERIALS'&&x.status!=='CANCELLED'&&x.packer).map(x=>x.packer));
    const tier1=workers.filter(w=>free(w)&&kinds.get(home(w))==='yard'&&['SCAFFOLDER','LEADING_HAND'].includes(this.roleOf(w,kinds))).sort(byName);
    const atSite=new Map();for(const w of workers)if(kinds.get(home(w))==='site'&&free(w))atSite.set(home(w),(atSite.get(home(w))??0)+1);
    const tier2=[];for(const w of workers.filter(w=>free(w)&&kinds.get(home(w))==='site'&&home(w)!==siteId&&!crane.has(home(w))).sort(byName)){const left=atSite.get(home(w));if(left<=keep)continue;atSite.set(home(w),left-1);tier2.push(w);}
    let atYard=workers.filter(w=>free(w)&&kinds.get(home(w))==='yard').length-tier1.length;const tier3=[];
    for(const w of workers.filter(w=>free(w)&&kinds.get(home(w))==='yard'&&this.roleOf(w,kinds)==='YARDSMAN'&&!packers.has(w.id)).sort(byName)){if(atYard<=YARD_KEEP)break;atYard--;tier3.push(w);}
    return [...tier1,...tier2,...tier3];},
  planKeep(){return Math.max(1,this.repo.all('config')[0]?.craneWorkers??1);},
  // People booked on a day (except on item `except`); a person who said they can't make it (and never went) is free again.
  planTaken(day,items=this.planDayItems(day),except=null){const taken=new Set();for(const x of items){if(x.type!=='WORKERS'||x.day!==day||x.id===except||x.status==='CANCELLED')continue;for(const p of x.people){if(!p.moved&&this.planMsg(p.message)?.status==='NO')continue;taken.add(p.person);}}return taken;},
  // Sites with crane work on a day: a list, a yard list, a single request or a collection for it (and today, a truck on its way there).
  planCraneSites(day,items=this.planDayItems(day)){const set=new Set();for(const o of [...this.repo.all('loadList'),...this.repo.all('request'),...this.repo.all('collection')])if(o.neededOn===day&&this.schedulable(o))set.add(o.site);
    for(const x of items)if(x.type==='MATERIALS'&&x.day===day&&PLAN_OPEN.includes(x.status))set.add(x.site);
    if(day===dayOf(this.planNow()))for(const t of this.repo.all('truck'))if(!t.retired&&t.game?.site)set.add(t.game.site);return set;},
  // The last of a site's crane crew on a day with crane work there: {person: site name} (they can't be booked away that day).
  planCraneHold(day,items=this.planDayItems(day),taken=this.planTaken(day,items)){const kinds=this.placeKinds(),crane=this.planCraneSites(day,items),keep=this.planKeep(),by=new Map(),out={};
    for(const w of this.teamWorkers(kinds)){const h=this.teamHome(w);if(kinds.get(h)!=='site'||!crane.has(h)||taken.has(w.id))continue;if(!by.has(h))by.set(h,[]);by.get(h).push(w);}
    for(const [h,list] of by)if(list.length<=keep)for(const w of list)out[w.id]=this.planSiteName(h);return out;},
  planPersonFree(id,day,except,{site=null,also=new Set()}={}){let w=null;try{w=this.repo.get(id,'resource');}catch{}requireRule(w&&w.type==='WORKER'&&w.enabled,'Choose someone in your team.');
    const items=this.planDayItems(day),taken=this.planTaken(day,items,except);
    const clash=items.find(x=>x.type==='WORKERS'&&x.id!==except&&x.status!=='CANCELLED'&&x.people.some(p=>p.person===w.id&&taken.has(w.id)));if(clash)throw new AppError(409,w.name+' is already at '+this.planSiteName(clash.site)+' that day.');
    // never the last of a site's crane crew on a day there is a delivery or a collection there
    const kinds=this.placeKinds(),home=this.teamHome(w);
    if(site&&kinds.get(home)==='site'&&home!==site&&this.planCraneSites(day,items).has(home)){const left=this.teamWorkers(kinds).filter(x=>this.teamHome(x)===home&&x.id!==w.id&&!taken.has(x.id)&&!also.has(x.id)).length;
      if(left<this.planKeep())throw new AppError(409,w.name+' is needed at '+this.planSiteName(home)+' that day to work the crane for a delivery. Pick someone else.');}
    return w;},
  planWorkers(input){requireRule(input&&typeof input==='object','Choose a day, a site and how many.');const cal=this.planNowCal(),now=this.planNow(),day=this.planDay(input.day,cal),time=parseTime(input.time),site=this.planSite(input.site),count=integer(input.count,'How many',1,20);
    requireRule(!this.planDayItems(day,'WORKERS').some(x=>x.site===site.id&&x.time===time),'Workers are already booked for '+site.name+' at '+timeWords(time)+' that day. Change the one already booked.');
    const chosen=input.people===undefined||input.people===null?[]:input.people;requireRule(Array.isArray(chosen)&&chosen.length<=count&&new Set(chosen).size===chosen.length,'Pick up to '+count+' different people.');
    this.planWhen('WORKERS',day,time);const people=[];for(const id of chosen)people.push(this.planPersonFree(id,day,null,{site:site.id,also:new Set(people.map(p=>p.id))}));const rest=this.planPool(day,site.id,new Set(people.map(p=>p.id))).slice(0,count-people.length);
    const rows=[...people,...rest].map(w=>({person:w.id,message:null,moved:false,from:null,arrivedAt:null,homeAt:null}));
    const it=this.repo.add('planItem',{type:'WORKERS',day,time,site:site.id,status:'PLANNED',stage:'BOOKED',note:note(input.note),problem:null,log:[{at:iso(now),text:'Booked by '+this.user.name+'.'}],createdAt:iso(now),createdBy:this.user.id,updatedAt:iso(now),doneAt:null,cancelledAt:null,cancelledBy:null,cancelReason:null,count,people:rows,pickedBy:people.length?'OFFICE':'AUTO'});
    this.planStep(it.id);const fresh=this.repo.get(it.id,'planItem'),sent=fresh.stage!=='BOOKED';
    return this.planReply(it,plural(count,'worker')+' booked for '+site.name+' on '+dayLabel(day)+' at '+timeWords(time)+'. '+(rows.length<count?'Short by '+(count-rows.length)+': nobody else is free that day. ':'')+(sent?"They've been sent a message.":'They get a message '+dayLabel(addDays(day,-1))+' at 3:00 pm.'));},
  planRestack(input){const cal=this.planNowCal(),now=this.planNow(),day=this.planDay(input?.day,cal),time=parseTime(input.time),yard=this.planYard();requireRule(yard,'Set up your yard first.');
    const consolidate=input.consolidate===undefined?true:input.consolidate,stackEmpties=input.stackEmpties===undefined?true:input.stackEmpties;requireRule(typeof consolidate==='boolean'&&typeof stackEmpties==='boolean','Choose on or off.');requireRule(consolidate||stackEmpties,'Tick at least one thing to do.');
    requireRule(!this.planDayItems(day,'RESTACK').length,'A re-stack is already booked for '+dayLabel(day)+'.');this.planWhen('RESTACK',day,time,now);
    const it=this.repo.add('planItem',{type:'RESTACK',day,time,site:null,yard:yard.id,status:'PLANNED',stage:'WAITING',note:note(input.note),problem:null,log:[{at:iso(now),text:'Booked by '+this.user.name+'.'}],createdAt:iso(now),createdBy:this.user.id,updatedAt:iso(now),doneAt:null,cancelledAt:null,cancelledBy:null,cancelReason:null,consolidate,stackEmpties,startedAt:null,finishedAt:null,quietSince:null,moved:{pieces:0,jobs:0,stacked:0}});
    this.planStep(it.id);return this.planReply(it,'Re-stack booked for '+dayLabel(day)+' at '+timeWords(time)+'.');},
  planItemFor(id){requireRule(typeof id==='string'&&id,'Choose something on the calendar.');let it=null;try{it=this.repo.get(id,'planItem');}catch{}requireRule(it,'That is no longer on the calendar.');return it;},
  planMove(input){const it=this.planItemFor(input?.id),cal=this.planNowCal(),now=this.planNow();requireRule(PLAN_FIXABLE.includes(it.status),'This is already '+(it.status==='DONE'?'done':'cancelled')+'.');if(it.status==='MISSED')requireRule(input.day!==undefined&&input.day!==null,'Pick a new day for it.');
    const day=input.day===undefined||input.day===null?it.day:this.planDay(input.day,cal),time=input.time===undefined||input.time===null?it.time:parseTime(input.time),what=this.planWhat(it);
    const hasLines=input.lines!==undefined&&input.lines!==null,hasTruck=input.truckPlan!==undefined;
    if(hasLines||hasTruck)requireRule(it.type==='MATERIALS'&&it.stage==='WAITING',"The list can only be changed before it's packed.");
    const yard=this.planYard(),lines=hasLines?this.planMaterialLines(input.lines,yard):null,tp=hasTruck?this.planTruckItem(input.truckPlan,day):undefined;
    const snap=lines?this.planSnapWords(lines,yard):'',sameLines=!lines||JSON.stringify(lines)===JSON.stringify(it.lines),sameTruck=tp===undefined||(tp?.id??null)===(it.truckPlan??null);
    if(day===it.day&&time===it.time&&sameLines&&sameTruck)return {...this.planReply(it,what+' is already on '+dayLabel(day)+' at '+timeWords(time)+'.'),changed:false};
    if(it.type==='TRUCK')requireRule(it.status==='MISSED'||(now<atLocal(it.day,DAY_START)&&it.status==='PLANNED'),'The truck day has started. Cancel it instead.');
    if(day!==it.day||time!==it.time)this.planWhen(it.type,day,time,now);
    if(it.type==='MATERIALS')requireRule(['WAITING','PACKING','PACKED','MISSED'].includes(it.stage),'The truck is already loading this list. Bring it back from the yard board instead.');
    if(it.type==='WORKERS')requireRule(!it.people.some(p=>p.moved),'People are already on site. Cancel it instead.');
    if(it.type==='RESTACK')requireRule(it.stage==='WAITING','The crew has started. Cancel it instead.');
    const moved=day!==it.day;
    if(it.type==='TRUCK'&&moved){if(it.truck)requireRule(!this.planDayItems(day,'TRUCK').some(x=>x.id!==it.id&&x.truck===it.truck),this.planName(it.truck,'That truck')+' is already booked on '+dayLabel(day)+'.');if(it.driver)this.planDriver(it.driver,day,it.id);}
    if(it.type==='WORKERS'){if(moved){const also=new Set();for(const p of it.people){this.planPersonFree(p.person,day,it.id,{site:it.site,also});also.add(p.person);}}requireRule(!this.planDayItems(day,'WORKERS').some(x=>x.id!==it.id&&x.site===it.site&&x.time===time),'Workers are already booked for '+this.planSiteName(it.site)+' at '+timeWords(time)+' that day. Change the one already booked.');}
    if(it.type==='RESTACK'&&moved)requireRule(!this.planDayItems(day,'RESTACK').some(x=>x.id!==it.id),'A re-stack is already booked for '+dayLabel(day)+'.');
    this.planEdit(it.id,x=>{const was=dayLabel(x.day)+' '+timeWords(x.time);x.day=day;x.time=time;if(x.status==='MISSED')Object.assign(x,{status:'PLANNED',problem:null,why:null,missedAt:null});
      if(x.type==='TRUCK'){if(x.message){this.planCallOff(x.message,'Moved to '+dayLabel(day),now);x.message=null;}x.stage=x.driver?'ASKING':'READY';}
      if(x.type==='MATERIALS'){this.planRelease(x,now);this.planCallOff(x.packMessage,'Moved to '+dayLabel(day),now);Object.assign(x,{packMessage:null,held:[],got:{},short:[],left:[],stage:'WAITING',status:'PLANNED',problem:null,why:null,missedAt:null});x.packDay=x.pack==='SAME_DAY'?day:(addDays(day,-1)<cal.today?cal.today:addDays(day,-1));if(lines)x.lines=lines;if(tp!==undefined)x.truckPlan=tp?.id??null;else if(moved&&x.truckPlan)x.truckPlan=null;}
      if(x.type==='WORKERS'){for(const p of x.people){this.planCallOff(p.message,'Moved to '+dayLabel(day),now);p.message=null;}x.stage='BOOKED';}
      this.planLog(x,'Moved from '+was+' to '+dayLabel(day)+' '+timeWords(time)+'.',now);});
    if(it.type==='TRUCK'&&moved)this.planUnlinkTruck(it.id,this.planWhat(it)+' moved to '+dayLabel(day)+', so this list goes on the next free truck.',now);
    this.planStep(it.id);return {...this.planReply(it,what+' moved to '+dayLabel(day)+' at '+timeWords(time)+'.'+(it.type==='WORKERS'&&it.people.some(p=>p.message)?' Everyone is asked again with the new time.':'')+snap),changed:true};},
  planWhat(it){if(it.type==='TRUCK')return it.hire?'The hire truck':this.planName(it.truck,'The truck');if(it.type==='MATERIALS')return 'The list for '+this.planSiteName(it.site);if(it.type==='WORKERS')return 'The workers for '+this.planSiteName(it.site);return 'The re-stack';},
  planCancel(input){const it=this.planItemFor(input?.id),now=this.planNow();requireRule(PLAN_FIXABLE.includes(it.status),'This is already '+(it.status==='DONE'?'done':'cancelled')+'.');
    requireRule(!(it.type==='MATERIALS'&&['LOADING','ON_THE_WAY'].includes(it.stage)),'The truck is already loading this list. Bring it back from the yard board instead.');
    const reason=note(input.reason),what=this.planWhat(it);
    this.planEdit(it.id,x=>{this.planRelease(x,now);this.planCallOffAll(x,'Cancelled by the office',now);for(const p of x.people??[])if(p.moved&&!p.homeAt&&this.planMoveWorker(p.person,'home',x,now))p.homeAt=iso(now);
      if(x.hire?.truck&&!x.hire.goneAt)this.planHireGone(x,now);x.status='CANCELLED';x.cancelledAt=iso(now);x.cancelledBy=this.user.id;x.cancelReason=reason;x.problem=null;this.planLog(x,'Cancelled by '+this.user.name+'.',now);});
    if(it.type==='TRUCK')this.planUnlinkTruck(it.id,what+' was cancelled, so this list goes on the next free truck.',now);
    return this.planReply(it,'Cancelled: '+what.charAt(0).toLowerCase()+what.slice(1)+' on '+dayLabel(it.day)+'.');},
  planAsk(input){const it=this.planItemFor(input?.item),now=this.planNow();requireRule(PLAN_OPEN.includes(it.status),'This is already '+(it.status==='DONE'?'done':'cancelled')+'.');
    if(it.type==='TRUCK'){const d=this.planDriver(input.person,it.day,it.id);requireRule(!(dayOf(now)>it.day||now>=atLocal(it.day,DAY_END)),'That day is over.');
      this.planEdit(it.id,x=>{if(x.message)this.planCallOff(x.message,x.driver===d.id?'Asked again':'Another driver was asked',now);x.driver=d.id;x.needsDriver=false;x.stage=x.status==='ACTIVE'?'ON':'ASKING';x.message=this.planAskPerson(x,d.id,'driver','DRIVE',now);x.problem=null;this.planLog(x,d.name+' has been asked.',now);});
      this.planStep(it.id);return this.planReply(it,d.name+' has been asked.');}
    requireRule(it.type==='WORKERS','Only trucks and workers are asked.');const replace=input.replace===undefined||input.replace===null||input.replace===''?null:input.replace;
    // the same person again ("Ask again"): their old ask is called off and a new one goes out (attempt 2, 3 ...)
    if(replace&&replace===input.person){const row=it.people.find(p=>p.person===replace),w=this.teamPerson(replace);requireRule(row&&w,'Choose who to ask again.');requireRule(!row.moved,w.name+' is already on site.');
      this.planEdit(it.id,x=>{const r=x.people.find(p=>p.person===replace);this.planCallOff(r.message,'Asked again',now);r.message=null;this.planLog(x,'Asked '+w.name+' again.',now);});this.planStep(it.id);
      const f=this.repo.get(it.id,'planItem').people.find(p=>p.person===replace);return this.planReply(it,f.message?w.name+' has been asked again.':w.name+' gets a message '+dayLabel(addDays(it.day,-1))+' at 3:00 pm.');}
    const w=this.planPersonFree(input.person,it.day,null,{site:it.site});requireRule(!it.people.some(p=>p.person===w.id),w.name+' is already on this.');
    if(replace){const row=it.people.find(p=>p.person===replace);requireRule(row,'Choose who to swap out.');requireRule(!row.moved,this.planName(replace)+' is already on site.');}
    else requireRule(it.people.length<it.count,'All '+it.count+' places are filled. Pick who to swap out.');
    this.planEdit(it.id,x=>{if(replace){const row=x.people.find(p=>p.person===replace);this.planCallOff(row.message,'Someone else was asked',now);x.people=x.people.filter(p=>p.person!==replace);this.planLog(x,this.planName(replace)+' swapped for '+w.name+'.',now);}else this.planLog(x,w.name+' added.',now);
      x.people=[...x.people,{person:w.id,message:null,moved:false,from:null,arrivedAt:null,homeAt:null}];x.pickedBy='OFFICE';});
    this.planStep(it.id);const f=this.repo.get(it.id,'planItem'),row=f.people.find(p=>p.person===w.id);
    return this.planReply(it,row.message?w.name+' has been asked.':w.name+' gets a message '+dayLabel(addDays(it.day,-1))+' at 3:00 pm.');},
  messageAnswer(input){requireRule(input&&typeof input.id==='string','Choose a message.');let m=null;try{m=this.repo.get(input.id,'message');}catch{}requireRule(m,'That message is no longer there.');
    requireRule(typeof input.yes==='boolean',"Choose I'll be there or Can't make it.");const via=input.via===undefined||input.via===null?'OFFICE':input.via;requireRule(['PHONE_VIEW','OFFICE'].includes(via),'Choose how the answer came in.');
    requireRule(m.status!=='CALLED_OFF','This was called off.');requireRule(m.status!=='WAITING_TO_SEND',"This hasn't been sent yet.");requireRule(m.needsAnswer,"This one doesn't need an answer. Tap Got it.");
    const it=this.planItemFor(m.item),now=this.planNow();requireRule(PLAN_OPEN.includes(it.status)&&!m.closedAt,'This is already finished.');
    if(via==='PHONE_VIEW')requireRule(now<atLocal(m.day,m.time),'Too late to answer, call the office.');
    if(it.type==='WORKERS'){const row=it.people.find(p=>p.message===m.id);if(row?.moved&&!row.homeAt)requireRule(input.yes,this.planName(row.person,'They')+' is already at '+this.planSiteName(it.site)+' and comes home at 5 pm.');}
    const reason=input.yes?null:note(input.reason);this.planAnswerMsg(m,{yes:input.yes,reason,by:this.user.id,via},now);this.planStep(it.id);
    return {...this.planReply(it,input.yes?(via==='OFFICE'?'Marked as yes for '+m.personName+'.':'Thanks. See you there.'):'Got it. The office will sort it.'),messageView:this.planMsgView(this.repo.get(m.id,'message'),now)};},
  messageSeen(input){requireRule(input&&typeof input.id==='string','Choose a message.');let m=null;try{m=this.repo.get(input.id,'message');}catch{}requireRule(m,'That message is no longer there.');requireRule(m.subject==='PACK','Answer this one with the two buttons.');requireRule(m.status!=='CALLED_OFF','This was called off.');
    const now=this.planNow();if(!m.seenAt){m.seenAt=iso(now);this.repo.save(m);}return {ok:true,message:'Got it.',messageView:this.planMsgView(m,now)};},
  planReplies(input){requireRule(typeof input?.on==='boolean','Choose on or off.');const c=this.ensureConfig();c.planReplies=input.on;this.repo.save(c);return {on:input.on,message:input.on?'People answer by themselves (demo).':'People no longer answer by themselves. Answer for them on the Today page.'};}
};
const dayOf=now=>localDay(new Date(now));
