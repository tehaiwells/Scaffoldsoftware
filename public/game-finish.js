// Remove site: one obvious button (a bin and the words) everywhere a site is made or picked (src/domain/sitefinish.js is the server side).
//  - Where: under each site tile in the Send / Bring back window, in the "Open a new site" window (the sites already on the map), in the site
//    window you get by tapping a site on the map, and on the Office's Client sites page.
//  - Pressing it: a site never used goes completely at once; a used site with nothing there goes off the map at once (kept as history under
//    Removed sites in the Office, with Open again). Both show a calm pop with Undo for about 10 s.
//    Scaffold still there or a truck on its way: ONE calm question in place ("George St still has scaffold on it. Bring it all back and remove
//    the site?" [Bring it back and remove] [Keep it]); then everything comes home by itself, the site says "Removing — bringing it all home" with
//    a Keep it link, and when the last stillage is back it goes with a calm pop ("George St is finished and removed.").
//  - Right after a site is made on the board: "George St added" with Undo.
//  - Something in the way (a stocktake, a truck run by hand, an Office booking): its plain words and the one button that fixes it (sfBlock, the
//    same rule the server enforces).
// Nothing here touches the DOM at module level (the server imports sfBlock and sfAsk).
export const SF_OPEN_RT=['REQUESTED','BOOKED','LOADING','ON THE WAY'];
const CLOSED=['DELIVERED','CANCELLED','RETURNED'],UNDO_MS=10000;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// ---------------------------------------------------------------- the rules (shared with the server)
// Why removing cannot start now, in plain words, and what fixes it: {why, fix:{view, tab?, label} | {act:'home', truck, label}}; null when it can.
// d: {counts, here (ids of the stillages at the site), requests, collections, trucks, tasks (open ones)}.
export function sfBlock(site,d){const id=site.id,name=site.name;
 if((d.counts??[]).some(c=>c.state==='OPEN'&&(c.scope===id||d.here?.has?.(c.scope))))return {why:'A stocktake is open at '+name+'. Finish it first.',fix:{view:'STOCK',tab:'CONTAINERS',label:'Open the stocktake'}};
 const lifting=new Set((d.tasks??[]).flatMap(t=>[t.from,t.to]));
 const hand=(d.trucks??[]).find(t=>!t.retired&&!t.game&&((t.status==='AT_SITE'&&t.at===id)||(t.status==='IN_TRANSIT'&&t.destination===id)||(t.status==='AT_YARD'&&t.destination===id)));
 if(hand){if(hand.status==='AT_SITE'&&!lifting.has(hand.id))return {why:'A truck run by hand is at '+name+'. Send it back to the yard first.',fix:{act:'home',truck:hand.id,label:'Send it back'}};
  return {why:'A truck run by hand is '+(hand.status==='IN_TRANSIT'?'on its way to ':'working for ')+name+'. Let it finish first.',fix:{view:'CONTROL',label:'Open the Control room'}};}
 if((d.requests??[]).some(r=>r.site===id&&!CLOSED.includes(r.status)))return {why:'A delivery to '+name+' is booked in the Office. Cancel it first.',fix:{view:'SCHEDULE',label:'Open the Schedule'}};
 const board=new Set((d.trucks??[]).map(t=>t.game?.collection).filter(Boolean));
 if((d.collections??[]).some(o=>o.site===id&&SF_OPEN_RT.includes(o.status)&&!board.has(o.id)))return {why:'A collection from '+name+' is booked in the Office. Cancel it first.',fix:{view:'SCHEDULE',label:'Open the Schedule'}};
 return null;}
// The one question before a site with scaffold on it (or a truck on its way) is removed.
export const sfAsk=(site,stock)=>(stock?site.name+' still has scaffold on it.':'A truck is still going to '+site.name+'.')+' Bring it all back and remove the site?';
// ---------------------------------------------------------------- pictures (inline SVG: presentation attributes only, no style attribute)
export const sfBin=(cls='sf-bin')=>'<svg class="'+cls+'" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5h16M9.5 6.5V4h5v2.5M6.3 6.5l1.1 13.5h9.2l1.1-13.5M10 10.5v6M14 10.5v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const homeSVG='<svg class="sf-home" viewBox="0 0 32 32" aria-hidden="true"><path d="M5 15L16 6l11 9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.5 13.5V26h15V13.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/><path d="M12.5 20h7M16.5 17l3 3-3 3" fill="none" stroke="#f0a81c" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const tickSVG='<span class="gm-tick" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
// ---------------------------------------------------------------- state (per browser tab)
const F={ask:null,block:null,busy:false,undos:new Map(),seq:0};// ask: the site waiting for its one question; block: {site, why, fix}
const piecesAt=(s,id)=>s?.stock?.[id]?.containers??0;
const hereOf=(s,id)=>{const out=new Set();for(const c of s?.containers??[])if(c.location===id)out.add(c.id);for(const c of s?.world?.items??[])if(c.location===id)out.add(c.id);return out;};
const stockAt=(s,id)=>piecesAt(s,id)>0||hereOf(s,id).size>0;
const blockOf=(s,site)=>sfBlock(site,{counts:s.counts,here:hereOf(s,site.id),requests:s.requests,collections:s.collections,trucks:s.trucks,tasks:s.tasks});
// Scaffold still there or something on its way for it (so Remove site asks first and brings it all home).
const busyAt=(s,id)=>stockAt(s,id)||(s.trucks??[]).some(t=>!t.retired&&(t.game?.site===id||(t.status==='AT_SITE'&&t.at===id)||(t.status==='IN_TRANSIT'&&(t.destination===id||t.at===id))))||(s.gameOrders??[]).some(o=>o.site===id&&o.type!=='SEND')||(s.tasks??[]).some(t=>t.handling===id);
// A site Send can go to (not one being removed).
export const sfSendable=site=>!site?.finishing;
export const sfSub=site=>site?.finishing?'Removing — bringing it all home':null;
// ---------------------------------------------------------------- the button and what takes its place
// kind: 'tile' (under a site tile, and in the new-site window), 'win' (the site window), 'office' (Client sites).
export function sfRemoveBtn(site,kind='win'){const id=esc(site.id),dis=F.busy?' disabled':'';
 if(kind==='tile')return '<button type="button" class="sf-rm sf-rm-tile" data-sf-remove="'+id+'" aria-label="Remove '+esc(site.name)+'"'+dis+'>'+sfBin()+'<span>Remove</span></button>';
 if(kind==='office')return '<button type="button" class="secondary si-archive sf-rm-office" data-sf-remove="'+id+'"'+dis+'>'+sfBin()+'<span>Remove site</span></button>';
 return '<button type="button" class="sf-rm sf-rm-win" data-sf-remove="'+id+'"'+dis+'>'+sfBin()+'<span>Remove site</span></button>';}
// The question, a reason it cannot go yet, or "Removing — bringing it all home" for this site; null when the button shows.
function panel(s,site,office=false,short=false){const id=site.id,go=office?'':'gm-go ',alt=office?'secondary':'gm-go gm-go-alt',dis=F.busy?' disabled':'';
 if(site.finishing){const n=piecesAt(s,id),stuck=(s.trucks??[]).find(t=>t.game?.site===id&&t.game.problem)?.game.problem??site.finishing.problem;
  return '<div class="sf-box sf-going" role="status">'+homeSVG+'<div class="sf-txt"><b>'+(short?'Bringing it all home':'Removing — bringing it all home')+'</b><small>'+(n?n+(n===1?' stillage':' stillages')+' still on site':'The last truck is on its way home')+'</small>'+(stuck?'<small class="sf-stuck">'+esc(stuck)+'</small>':'')+'</div><button type="button" class="sf-link" data-sf-keep="'+esc(id)+'"'+dis+'>Keep it</button></div>';}
 if(F.block?.site===id){const b=F.block;
  return '<div class="sf-box sf-why" role="alert"><p>'+esc(b.why)+'</p><div class="sf-two">'+(b.fix?'<button type="button" class="'+go+'sf-fix" data-sf-fix="'+esc(id)+'"'+dis+'>'+esc(b.fix.label)+'</button>':'')+'<button type="button" class="'+alt+'" data-sf-no>Not now</button></div></div>';}
 if(F.ask===id)return '<div class="sf-box sf-ask" role="group" aria-label="Remove '+esc(site.name)+'"><p>'+sfBin('sf-bin sf-bin-big')+'<span>'+esc(sfAsk(site,stockAt(s,id)))+'</span></p><div class="sf-two"><button type="button" class="'+go+'sf-sure" data-sf-sure="'+esc(id)+'"'+dis+'>Bring it back and remove</button><button type="button" class="'+alt+'" data-sf-no>Keep it</button></div></div>';
 return null;}
// A site tile in the Send / Bring back window, with its Remove button under it.
export function sfTile(site,tile,ops){if(!ops)return tile;return '<div class="sf-tile">'+tile+(site.finishing?'<span class="sf-rm sf-rm-tile sf-rm-going" title="Removing — bringing it all home">Removing&hellip;</span>':sfRemoveBtn(site,'tile'))+'</div>';}
// Under the tiles: the question (or reason) for a site in the row, else "Removing" for the site picked.
export function sfBelowTiles(s,list,picked,ops){if(!ops)return '';const ask=list.find(x=>x.id===F.ask||x.id===F.block?.site)??list.find(x=>x.id===picked&&x.finishing);return ask?panel(s,ask)??'':'';}
// The "Open a new site" window: the sites already on the map, each with Remove.
export function sfNewSiteList(s,sites,ops){if(!ops||!sites.length)return '';
 return '<div class="sf-nw"><p class="sf-nw-h">Already on the map</p><ul class="sf-nw-list">'+sites.map(x=>{const p=panel(s,x);return '<li'+(p?' class="sf-open"':'')+'><span class="sf-nw-name">'+esc(x.name)+'</span>'+(p??sfRemoveBtn(x,'tile'))+'</li>';}).join('')+'</ul></div>';}
// The site window (tap a site on the map): base is the board's own Send here / Bring back row.
export function sfActs(s,site,ops,base){if(!site||!ops)return base;const p=panel(s,site,false,true);return p?'<div class="gm-acts sf-acts">'+p+'</div>':base+sfRemoveBtn(site,'win');}
// The Office, Client sites: a site card's Remove site (or its question, or Removing).
export function sfOfficeActs(s,site){return '<div class="sf-office">'+(panel(s,site,true)??sfRemoveBtn(site,'office'))+'</div>';}
// ---------------------------------------------------------------- taps
// api: {ctx (state, cmd, refresh, notify, go), refresh() (draw again), pop(text, kind), gone(id) (the site left the board)}.
async function sfRun(api,action,data,ok,fail){if(F.busy)return;F.busy=true;api.refresh();
 try{const r=await api.ctx.cmd(action,data);F.busy=false;ok?.(r);await api.ctx.refresh?.();}
 catch(e){F.busy=false;if(fail)fail(e);else (api.ctx.notify??api.pop)?.(e.message,'warn');}finally{F.busy=false;api.refresh();}}
const removed=(api,id)=>r=>{F.ask=null;F.block=null;if(r.removed||r.archived)api.gone?.(id);
 if(r.removed)undoPop(api,r.message,{kind:'make',...r.undo});else if(r.archived)undoPop(api,r.message,{kind:'reopen',site:id});else api.pop(r.message,'go');};
export function sfClick(b,api){const s=api.ctx?.state,d=b.dataset;if(!s)return false;
 const siteOf=id=>(s.sites??[]).find(x=>x.id===id);
 if(d.sfRemove!==undefined){const site=siteOf(d.sfRemove);if(!site)return true;
  const block=blockOf(s,site);if(block){F.block={site:site.id,...block};F.ask=null;api.refresh();return true;}
  if(busyAt(s,site.id)){F.ask=site.id;F.block=null;api.refresh();return true;}
  sfRun(api,'gameRemoveSite',{site:site.id},removed(api,site.id),e=>{F.ask=null;F.block={site:site.id,why:e.message,fix:null};});return true;}
 if(d.sfSure!==undefined){const id=d.sfSure;
  sfRun(api,'gameRemoveSite',{site:id,bringBack:true},removed(api,id),e=>{F.ask=null;F.block={site:id,why:e.message,fix:null};});return true;}
 if(d.sfNo!==undefined){F.ask=null;F.block=null;api.refresh();return true;}
 if(d.sfFix!==undefined){const b2=F.block;if(!b2?.fix)return true;
  if(b2.fix.act==='home'){const yard=s.yards?.[0]?.id;sfRun(api,'dispatch',{id:b2.fix.truck,destination:yard},()=>{F.block=null;api.pop('The truck is going back to the yard.','go');},e=>{F.block={...b2,why:e.message};});return true;}
  F.block=null;api.ctx.go?.(b2.fix.view,b2.fix.tab?{stockTab:b2.fix.tab}:undefined);return true;}
 if(d.sfKeep!==undefined){sfRun(api,'gameKeepOpen',{site:d.sfKeep},r=>api.pop(r.message,'go'));return true;}
 if(d.sfReopen!==undefined){sfRun(api,'gameReopen',{site:d.sfReopen},r=>api.pop(r.message,'tick'));return true;}
 if(d.sfUndo!==undefined){const u=F.undos.get(d.sfUndo);F.undos.delete(d.sfUndo);b.closest('.sf-pop')?.remove();if(!u)return true;
  if(u.kind==='new')sfRun(api,'gameRemoveSite',{site:u.site},r=>{F.ask=null;F.block=null;api.gone?.(u.site);api.pop(r.message,'go');});
  else if(u.kind==='make'){const {kind,...data}=u;sfRun(api,'gameSite',data,r=>api.pop(r.site.name+' is back','tick'));}
  else if(u.kind==='reopen')sfRun(api,'gameReopen',{site:u.site},r=>api.pop(r.message,'tick'));
  return true;}
 return false;}
// ---------------------------------------------------------------- pops with Undo (about 10 s)
function undoPop(api,text,undo,siteId){const box=typeof document!=='undefined'?document.querySelector('[data-gm-pops]'):null;if(!box){api.pop(text,'go');return;}
 const token='u'+(++F.seq);F.undos.set(token,undo);
 const el=document.createElement('div');el.className='gm-pop sf-pop';if(siteId)el.dataset.sfPop=siteId;
 el.innerHTML=tickSVG+'<span>'+esc(text)+'</span><button type="button" class="sf-undo" data-sf-undo="'+token+'">Undo</button>';
 box.append(el);while(box.children.length>2)box.firstElementChild.remove();document.querySelector('.gm-board')?.classList.add('popping');
 setTimeout(()=>{F.undos.delete(token);el.classList.add('out');setTimeout(()=>{el.remove();if(!box.children.length)document.querySelector('.gm-board')?.classList.remove('popping');},600);},UNDO_MS);}
// Right after a site is made on the board.
export function sfUndo(site,api){if(site)undoPop(api??{pop:()=>{}},site.name+' added',{kind:'new',site:site.id},site.id);}
// Every poll: an "added" Undo for a site that is gone or already in use quietly goes; a question for a site that is gone is dropped.
export function sfUpdate(s){const sites=new Map((s?.sites??[]).map(x=>[x.id,x]));
 if(typeof document!=='undefined')for(const el of document.querySelectorAll('[data-sf-pop]')){const site=sites.get(el.dataset.sfPop);if(!site||site.status!=='ACTIVE'||busyAt(s,site.id)){F.undos.delete(el.querySelector('[data-sf-undo]')?.dataset.sfUndo);el.remove();}}
 const live=id=>{const x=sites.get(id);return x&&x.status==='ACTIVE'&&!x.finishing;};
 if(F.ask&&!live(F.ask))F.ask=null;if(F.block&&!live(F.block.site))F.block=null;}
// ---------------------------------------------------------------- the Office, Client sites: Removed sites, Open again
export function sfFinishedHTML(sites,ops){const done=(sites??[]).filter(x=>x.status==='ARCHIVED').sort((a,b)=>String(b.finishedAt??'').localeCompare(String(a.finishedAt??''))||a.name.localeCompare(b.name));if(!done.length)return '';
 const when=x=>{const t=Date.parse(x.finishedAt??'');return t>0?'Removed '+new Date(t).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}):'Removed';};
 return '<section class="panel sf-done" id="si-finished" aria-labelledby="sf-done-h"><div class="sf-done-head">'+sfBin('sf-bin sf-bin-big')+'<div><h2 id="sf-done-h">Removed / finished sites</h2><p>Kept here as history. Open one again if you need it.</p></div></div><ul class="sf-done-list">'
  +done.map(x=>'<li><span class="sf-done-name"><b>'+esc(x.name)+'</b><small>'+esc([when(x),x.client,x.address].filter(Boolean).join(' · '))+'</small></span>'+(ops?'<button type="button" class="secondary" data-sf-reopen="'+esc(x.id)+'">Open again</button>':'')+'</li>').join('')+'</ul></section>';}
export const __sf={state:()=>F,reset:()=>{F.ask=null;F.block=null;F.busy=false;F.undos.clear();}};
