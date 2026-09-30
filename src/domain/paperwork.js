// Paperwork on the Today page: SWMS, JHSA, permits and other papers per site (or for the whole company). JHSAs, permits and other papers
// have an expiry date. A SWMS does not expire: it is reviewed. It keeps the day it was last reviewed and is flagged for review when that is
// older than the company's review period (12 months unless the owner changes it). A SWMS saved before this rule, with a date instead of a
// review day, keeps that date as the day to review it by. A company-wide SWMS never stands in for a site's own. Commands need
// requests.create (simulation.js); a paper for a site is checked with assertSite (a supervisor keeps their own sites' papers), a company-wide one
// needs operations.manage. Nothing is deleted: Remove archives it.
import { requireRule } from './geometry.js';
import { addDays,daysBetween,dayLabel } from './schedule.js';
import { integer } from './geometry.js';
export const PAPER_TYPES=['SWMS','JHSA','PERMIT','OTHER'],PAPER_WORDS={SWMS:'SWMS',JHSA:'JHSA',PERMIT:'Permit',OTHER:'Paperwork'};
export const SOON_DAYS=14,SWMS_REVIEW_MONTHS=12;
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const text=(v,label,max)=>{if(v===undefined||v===null)return null;requireRule(typeof v==='string',label+' must be text.');const s=v.trim();if(!s)return null;requireRule(s.length<=max,label+' can be at most '+max+' characters.');return s;};
const expiry=v=>{requireRule(typeof v==='string'&&DAY.test(v)&&addDays(v,0)===v,'Choose the expiry date.');requireRule(v>='2000-01-01'&&v<='2099-12-31','Choose an expiry date between 2000 and 2099.');return v;};
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],p2=n=>String(n).padStart(2,'0');
const shortDay=(day,today)=>{const [y,m,d]=day.split('-').map(Number);return d+' '+MON[m-1]+(day.slice(0,4)!==today.slice(0,4)?' '+y:'');};
// 'YYYY-MM-DD' plus n months, kept inside the month (31 Jan + 1 month = 28 or 29 Feb).
export function addMonths(day,n){const [y,m,d]=day.split('-').map(Number),first=new Date(Date.UTC(y,m-1+n,1)),last=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();
  return first.getUTCFullYear()+'-'+p2(first.getUTCMonth()+1)+'-'+p2(Math.min(d,last));}
const reviewDay=(v,today)=>{requireRule(typeof v==='string'&&DAY.test(v)&&addDays(v,0)===v,'Choose the day it was last reviewed.');requireRule(v>='2000-01-01','Choose a review day from 2000 on.');requireRule(v<=today,"The last review can't be in the future.");return v;};
// A SWMS: due for review its review period after the last review (or by its old date). The status codes match paperStatus (the card sorts and
// counts by them) with review:true, so the page says "review", never "expired".
export function swmsStatus(p,today,months=SWMS_REVIEW_MONTHS){const due=p.reviewedOn?addMonths(p.reviewedOn,months):p.expiresOn,d=daysBetween(today,due);
  if(d<0)return {status:'EXPIRED',days:d,due,review:true,words:'Review overdue'+(p.reviewedOn?': last reviewed '+shortDay(p.reviewedOn,today):'')};
  if(d<=SOON_DAYS)return {status:'SOON',days:d,due,review:true,words:d===0?'Review due today':d===1?'Review due tomorrow':'Review due in '+d+' days'};
  return {status:'OK',days:d,due,review:true,words:p.reviewedOn?'Reviewed '+shortDay(p.reviewedOn,today):'Review by '+shortDay(due,today)};}
export const paperState=(p,today,months)=>p.type==='SWMS'?swmsStatus(p,today,months):{...paperStatus(p.expiresOn,today),due:p.expiresOn,review:false};
// EXPIRED before today, SOON up to 14 days ahead (today included), else OK; with the words the card shows.
export function paperStatus(expiresOn,today){const d=daysBetween(today,expiresOn);
  if(d<0)return {status:'EXPIRED',days:d,words:'Expired '+(d===-1?'yesterday':-d+' days ago')};
  if(d<=SOON_DAYS)return {status:'SOON',days:d,words:d===0?'Expires today':d===1?'Expires tomorrow':'Expires in '+d+' days'};
  const [,m,day]=expiresOn.split('-').map(Number);return {status:'OK',days:d,words:'Good until '+day+' '+['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1]+(expiresOn.slice(0,4)!==today.slice(0,4)?' '+expiresOn.slice(0,4):'')};}
export const paperworkMethods={
  // The company's SWMS review period in months (the owner sets it on the Paperwork card).
  paperMonths(){return this.repo.all('paperSettings')[0]?.swmsReviewMonths??SWMS_REVIEW_MONTHS;},
  paperworkSettings(input){this.auth.require(this.user,'company.manage');const months=integer(input?.swmsReviewMonths,'Review period',1,60);
    const s=this.repo.all('paperSettings')[0];if(s){s.swmsReviewMonths=months;this.repo.save(s);}else this.repo.add('paperSettings',{swmsReviewMonths:months});
    return {swmsReviewMonths:months,message:'A SWMS is now flagged for review '+months+(months===1?' month':' months')+' after its last review.'};},
  paperworkScope(site){if(site){const s=this.repo.get(site,'site');this.assertSite(s.id);return s;}this.auth.require(this.user,'operations.manage');return null;},
  paperworkAdd(input){requireRule(input&&typeof input==='object','Choose the paperwork.');const type=input.type;requireRule(PAPER_TYPES.includes(type),'Choose SWMS, JHSA, Permit or Other.');
    const site=input.site===undefined||input.site===null||input.site===''?null:input.site;requireRule(site===null||typeof site==='string','Choose a site or the whole company.');
    const s=this.paperworkScope(site);if(s)requireRule(s.status==='ACTIVE','Choose an active site.');
    let title=text(input.title,'Name',80);if(!title){requireRule(type==='SWMS'||type==='JHSA','Give the '+(type==='PERMIT'?'permit':'paperwork')+' a name, like "Council footpath permit".');title=type;}
    const today=this.calendar().today,swms=type==='SWMS',reviewedOn=swms&&(input.reviewedOn!==undefined&&input.reviewedOn!==null||input.expiresOn===undefined||input.expiresOn===null)?reviewDay(input.reviewedOn,today):null;
    const expiresOn=reviewedOn?null:expiry(input.expiresOn),st=paperState({type,expiresOn,reviewedOn},today,this.paperMonths());
    const p=this.repo.add('paperwork',{type,title,site:s?.id??null,expiresOn,reviewedOn,reference:text(input.reference,'Reference',60),note:text(input.note,'Note',200),createdAt:new Date().toISOString(),by:this.user.id,renewedAt:null,archived:false});
    return {paperwork:this.paperView(p,today),message:title+(s?' for '+s.name:'')+' saved. '+(st.review?(st.status==='EXPIRED'?'Its review is overdue.':st.words+'.'):st.status==='EXPIRED'?'It has expired ('+st.words.toLowerCase().replace('expired ','')+').':st.words+'.')};},
  paperworkUpdate(input){const p=this.repo.get(input?.id,'paperwork');this.paperworkScope(p.site);requireRule(!p.archived,'This paperwork was removed.');const today=this.calendar().today;let renewed=false,reviewed=false;
    if(input.reviewedOn!==undefined){requireRule(p.type==='SWMS','Only a SWMS is reviewed. Give this one a new expiry date.');p.reviewedOn=reviewDay(input.reviewedOn,today);p.expiresOn=null;p.renewedAt=new Date().toISOString();reviewed=true;}
    else if(input.expiresOn!==undefined){const e=expiry(input.expiresOn);if(e!==p.expiresOn){p.expiresOn=e;p.renewedAt=new Date().toISOString();renewed=true;}}
    if(input.title!==undefined){const t=text(input.title,'Name',80);requireRule(t||p.type==='SWMS'||p.type==='JHSA','Give the paperwork a name.');p.title=t??p.type;}
    if(input.reference!==undefined)p.reference=text(input.reference,'Reference',60);if(input.note!==undefined)p.note=text(input.note,'Note',200);
    this.repo.save(p);const st=paperState(p,today,this.paperMonths());
    return {paperwork:this.paperView(p,today),message:reviewed?p.title+' marked as reviewed on '+dayLabel(p.reviewedOn)+'. Next review due '+shortDay(st.due,today)+'.':renewed?p.title+' renewed. '+st.words+'.':p.title+' saved.'};},
  paperworkRemove(input){const p=this.repo.get(input?.id,'paperwork');this.paperworkScope(p.site);requireRule(!p.archived,'This paperwork was already removed.');p.archived=true;p.archivedAt=new Date().toISOString();this.repo.save(p);return {ok:true,message:p.title+' removed.'};},
  paperView(p,today,siteName,months=this.paperMonths()){const st=paperState(p,today,months);let name=siteName;if(name===undefined&&p.site){try{name=this.repo.get(p.site,'site').name;}catch{name=null;}}
    return {id:p.id,type:p.type,typeWords:PAPER_WORDS[p.type],title:p.title,site:p.site,siteName:p.site?name??null:null,wholeCompany:!p.site,expiresOn:p.expiresOn??null,expiresLabel:p.expiresOn?dayLabel(p.expiresOn):null,reviewedOn:p.reviewedOn??null,dueLabel:dayLabel(st.due),reference:p.reference??null,note:p.note??null,renewedAt:p.renewedAt??null,...st};},
  // The Paperwork card: the viewer's sites' papers and the company's, expired first, then due soon (soonest first), then good; and active sites
  // that have gear there or something planned but no SWMS of their own on file (a company-wide SWMS never clears a site's warning).
  paperworkView(today,sites,{ops,owner=false,planned=new Set(),gearAt=new Set()}={}){const bySite=new Map(sites.map(s=>[s.id,s])),months=this.paperMonths();
    const items=this.repo.all('paperwork').filter(p=>!p.archived&&(p.site?bySite.has(p.site):true)).map(p=>this.paperView(p,today,p.site?bySite.get(p.site).name:null,months));
    const rank={EXPIRED:0,SOON:1,OK:2},due=i=>i.reviewedOn?addMonths(i.reviewedOn,months):i.expiresOn;items.sort((a,b)=>rank[a.status]-rank[b.status]||due(a).localeCompare(due(b))||a.title.localeCompare(b.title));
    const counts={expired:0,review:0,soon:0,ok:0};for(const i of items)counts[i.status==='EXPIRED'?(i.review?'review':'expired'):i.status==='SOON'?'soon':'ok']++;
    const company=items.some(i=>i.type==='SWMS'&&i.wholeCompany);
    const missing=sites.filter(s=>(gearAt.has(s.id)||planned.has(s.id))&&!items.some(i=>i.type==='SWMS'&&i.site===s.id)).map(s=>({site:s.id,siteName:s.name}));
    return {items,counts,missing,companySwms:company,reviewMonths:months,canSetReview:!!owner,canAdd:true,canAddCompany:!!ops,
      words:[counts.expired?counts.expired+' expired':null,counts.review?counts.review+(counts.review===1?' SWMS':' SWMSs')+' due for review':null,counts.soon?counts.soon+' due soon':null].filter(Boolean).join(' · ')||(items.length?'All good':'Nothing on file yet')};}
};
