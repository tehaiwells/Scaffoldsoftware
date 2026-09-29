// Paperwork on the Today page: SWMS, JHSA, permits and other papers per site (or for the whole company) with an expiry date. Commands need
// requests.create (simulation.js); a paper for a site is checked with assertSite (a supervisor keeps their own sites' papers), a company-wide one
// needs operations.manage. Nothing is deleted: Remove archives it.
import { requireRule } from './geometry.js';
import { addDays,daysBetween,dayLabel } from './schedule.js';
export const PAPER_TYPES=['SWMS','JHSA','PERMIT','OTHER'],PAPER_WORDS={SWMS:'SWMS',JHSA:'JHSA',PERMIT:'Permit',OTHER:'Paperwork'};
export const SOON_DAYS=14;
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const text=(v,label,max)=>{if(v===undefined||v===null)return null;requireRule(typeof v==='string',label+' must be text.');const s=v.trim();if(!s)return null;requireRule(s.length<=max,label+' can be at most '+max+' characters.');return s;};
const expiry=v=>{requireRule(typeof v==='string'&&DAY.test(v)&&addDays(v,0)===v,'Choose the expiry date.');requireRule(v>='2000-01-01'&&v<='2099-12-31','Choose an expiry date between 2000 and 2099.');return v;};
// EXPIRED before today, SOON up to 14 days ahead (today included), else OK; with the words the card shows.
export function paperStatus(expiresOn,today){const d=daysBetween(today,expiresOn);
  if(d<0)return {status:'EXPIRED',days:d,words:'Expired '+(d===-1?'yesterday':-d+' days ago')};
  if(d<=SOON_DAYS)return {status:'SOON',days:d,words:d===0?'Expires today':d===1?'Expires tomorrow':'Expires in '+d+' days'};
  const [,m,day]=expiresOn.split('-').map(Number);return {status:'OK',days:d,words:'Good until '+day+' '+['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1]+(expiresOn.slice(0,4)!==today.slice(0,4)?' '+expiresOn.slice(0,4):'')};}
export const paperworkMethods={
  paperworkScope(site){if(site){const s=this.repo.get(site,'site');this.assertSite(s.id);return s;}this.auth.require(this.user,'operations.manage');return null;},
  paperworkAdd(input){requireRule(input&&typeof input==='object','Choose the paperwork.');const type=input.type;requireRule(PAPER_TYPES.includes(type),'Choose SWMS, JHSA, Permit or Other.');
    const site=input.site===undefined||input.site===null||input.site===''?null:input.site;requireRule(site===null||typeof site==='string','Choose a site or the whole company.');
    const s=this.paperworkScope(site);if(s)requireRule(s.status==='ACTIVE','Choose an active site.');
    let title=text(input.title,'Name',80);if(!title){requireRule(type==='SWMS'||type==='JHSA','Give the '+(type==='PERMIT'?'permit':'paperwork')+' a name, like "Council footpath permit".');title=type;}
    const expiresOn=expiry(input.expiresOn),today=this.calendar().today,st=paperStatus(expiresOn,today);
    const p=this.repo.add('paperwork',{type,title,site:s?.id??null,expiresOn,reference:text(input.reference,'Reference',60),note:text(input.note,'Note',200),createdAt:new Date().toISOString(),by:this.user.id,renewedAt:null,archived:false});
    return {paperwork:this.paperView(p,today),message:title+(s?' for '+s.name:'')+' saved. '+(st.status==='EXPIRED'?'It has expired ('+st.words.toLowerCase().replace('expired ','')+').':st.words+'.')};},
  paperworkUpdate(input){const p=this.repo.get(input?.id,'paperwork');this.paperworkScope(p.site);requireRule(!p.archived,'This paperwork was removed.');const today=this.calendar().today;let renewed=false;
    if(input.expiresOn!==undefined){const e=expiry(input.expiresOn);if(e!==p.expiresOn){p.expiresOn=e;p.renewedAt=new Date().toISOString();renewed=true;}}
    if(input.title!==undefined){const t=text(input.title,'Name',80);requireRule(t||p.type==='SWMS'||p.type==='JHSA','Give the paperwork a name.');p.title=t??p.type;}
    if(input.reference!==undefined)p.reference=text(input.reference,'Reference',60);if(input.note!==undefined)p.note=text(input.note,'Note',200);
    this.repo.save(p);const st=paperStatus(p.expiresOn,today);return {paperwork:this.paperView(p,today),message:renewed?p.title+' renewed. '+st.words+'.':p.title+' saved.'};},
  paperworkRemove(input){const p=this.repo.get(input?.id,'paperwork');this.paperworkScope(p.site);requireRule(!p.archived,'This paperwork was already removed.');p.archived=true;p.archivedAt=new Date().toISOString();this.repo.save(p);return {ok:true,message:p.title+' removed.'};},
  paperView(p,today,siteName){const st=paperStatus(p.expiresOn,today);let name=siteName;if(name===undefined&&p.site){try{name=this.repo.get(p.site,'site').name;}catch{name=null;}}
    return {id:p.id,type:p.type,typeWords:PAPER_WORDS[p.type],title:p.title,site:p.site,siteName:p.site?name??null:null,wholeCompany:!p.site,expiresOn:p.expiresOn,expiresLabel:dayLabel(p.expiresOn),reference:p.reference??null,note:p.note??null,renewedAt:p.renewedAt??null,...st};},
  // The Paperwork card: the viewer's sites' papers and the company's, expired first, then due soon (soonest first), then good; and active sites
  // that have gear there or something planned but no SWMS on file.
  paperworkView(today,sites,{ops,planned=new Set(),gearAt=new Set()}={}){const bySite=new Map(sites.map(s=>[s.id,s]));
    const items=this.repo.all('paperwork').filter(p=>!p.archived&&(p.site?bySite.has(p.site):true)).map(p=>this.paperView(p,today,p.site?bySite.get(p.site).name:null));
    const rank={EXPIRED:0,SOON:1,OK:2};items.sort((a,b)=>rank[a.status]-rank[b.status]||a.expiresOn.localeCompare(b.expiresOn)||a.title.localeCompare(b.title));
    const counts={expired:0,soon:0,ok:0};for(const i of items)counts[i.status==='EXPIRED'?'expired':i.status==='SOON'?'soon':'ok']++;
    const swms=new Set(items.filter(i=>i.type==='SWMS'&&i.status!=='EXPIRED'&&i.site).map(i=>i.site)),company=items.some(i=>i.type==='SWMS'&&i.wholeCompany&&i.status!=='EXPIRED');
    const missing=company?[]:sites.filter(s=>(gearAt.has(s.id)||planned.has(s.id))&&!swms.has(s.id)&&!items.some(i=>i.type==='SWMS'&&i.site===s.id)).map(s=>({site:s.id,siteName:s.name}));
    return {items,counts,missing,canAdd:true,canAddCompany:!!ops,words:[counts.expired?counts.expired+' expired':null,counts.soon?counts.soon+' due soon':null].filter(Boolean).join(' · ')||(items.length?'All good':'Nothing on file yet')};}
};
