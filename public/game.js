// The game board: the main screen. The live world map (yard, sites, roads, trucks) fills the screen; a Factorio-style inventory window sits beside
// it (a bottom sheet on a phone); three big buttons do the three things people do (Send, Bring back, Add stock); one speech-bubble hint at a time;
// little pops when a truck sets off or a delivery lands. Every other page lives behind the Office door. The server does the work
// (src/domain/game.js); the crew, forklifts, trucks and site cranes move by themselves and the owner watches.
// operations.js owns the poll: it calls gmUpdate(ctx) with every new state; this module keeps its own DOM and patches only what changed. The
// stillage lists behind the Send / Bring back slider are fetched only while one of them is open (GET /api/game-items), never with the poll.
import {esc,num} from './visual.js';
import {ovImg} from './art.js';
import {gaItem,gaTab,GA_TABS,GA_ROW_ORDER,GA_BUTTONS,gaImg,gaKind,gaLook,gaFamily,gaLength,gaLenTag,gaSprite,gaYardPad,gaSystemPic} from './game-art.js';
import {gpStops,gpSnap,gpFill,gpCount,gpChoose} from './game-pick.js';
import {wmShell,wmFocus} from './world.js';
const byName=new Intl.Collator(undefined,{numeric:true}).compare;
const SYS_CLASS={quickstage:'qs','at-pac':'at','tube-clip':'tc'},SYS_NAME={quickstage:'Quickstage','at-pac':'AT-PAC','tube-clip':'Tube & Clip'};
const SYSTEMS=[['quickstage','Quickstage','Cups and blades'],['at-pac','AT-PAC','Ringlock rosettes'],['tube-clip','Tube & Clip','Tubes and fittings']];
const TARE=50000,HEAVY=10000000,PICKING=['send','back','add'];
// A truck in words: 'Big truck' (12.5 t) or 'Truck' (2 t), as on the map. Fleet codes (T-01) stay on the Office pages.
const truckKind=t=>(t?.payload??0)>=HEAVY?'Big truck':'Truck';
// ---------------------------------------------------------------- state of the board (per browser tab)
const G={mode:'yard',site:null,truck:null,tab:null,picks:new Map(),sel:null,showAll:false,busy:false,office:false,ctx:null,seen:null,counts:new Map(),bumps:new Set(),cols:10,rows:4,who:null,hintOff:new Set(),
 hoverId:null,hoverT:0,pressT:0,items:{loc:null,list:null,at:0,busy:false},pending:null,win:null,systems:new Set(),lastSite:null,quiet:new Map(),aimT:0};
const store={get(k){try{return localStorage.getItem(k);}catch{return null;}},set(k,v){try{localStorage.setItem(k,v);}catch{}}};
const hintKey=()=>'gm-hints:'+(G.ctx?.account?.company?.id??'')+':'+(G.ctx?.account?.user?.id??'');
function resetFor(ctx){const who=(ctx.account?.company?.id??'')+'|'+(ctx.account?.user?.id??'');if(who===G.who)return;G.who=who;G.mode='yard';G.site=null;G.truck=null;G.tab=null;G.picks=new Map();G.sel=null;G.office=false;G.seen=null;G.counts=new Map();G.ctx=ctx;
 G.items={loc:null,list:null,at:0,busy:false};G.pending=null;G.win=null;G.systems=new Set();G.lastSite=null;G.hintOff=new Set(String(store.get(hintKey())??'').split(',').filter(Boolean));}
const phone=()=>typeof matchMedia==='function'&&matchMedia('(max-width:760px)').matches;
const ops=()=>!!G.ctx?.account?.permissions?.includes('operations.manage');
// ---------------------------------------------------------------- reading the state
const yardOf=s=>s?.yards?.[0]??null;
const products=s=>(s?.products??[]).filter(p=>!p.retired);
const rowsAt=(s,loc)=>{const m=new Map();for(const r of s?.stock?.[loc]?.rows??[])m.set(r.product,r);return m;};
const activeSites=s=>(s?.sites??[]).filter(x=>x.status==='ACTIVE').sort((a,b)=>byName(a.name,b.name));
const siteName=(s,id)=>(s?.sites??[]).find(x=>x.id===id)?.name??(s?.yards??[]).find(y=>y.id===id)?.name??'the site';
const hasStock=(s,loc)=>(s?.stock?.[loc]?.pieces??0)>0;
const perStillage=p=>p?.packQuantity>0?p.packQuantity:p?.unitWeight>0?Math.max(1,Math.floor((1500000-TARE)/p.unitWeight)):null;
// Where the slider's stillages come from: the yard for Send, the site for Bring back.
const pickLoc=s=>G.mode==='send'?yardOf(s)?.id??null:G.mode==='back'?G.site:null;
const itemsFor=loc=>G.items.loc===loc&&G.items.list?G.items.list:null;
// What the grid shows in each mode: [{p, count, dim}] (count = the corner number; quiet = no number).
function gridItems(s){const all=products(s),yard=yardOf(s),mode=G.mode;
 if(mode==='add')return all.map(p=>({p,count:0,quiet:true}));
 if(mode==='send'){const at=rowsAt(s,yard?.id);return all.map(p=>({p,count:at.get(p.id)?.free??0})).filter(x=>x.count>0||G.picks.has(x.p.id));}
 if(mode==='back'||mode==='site'){const at=rowsAt(s,G.site);return all.map(p=>({p,count:at.get(p.id)?.quantity??0})).filter(x=>x.count>0||G.picks.has(x.p.id));}
 if(mode==='truck'){const at=rowsAt(s,G.truck);return all.map(p=>({p,count:at.get(p.id)?.quantity??0})).filter(x=>x.count>0);}
 if(mode==='parts')return [];
 const at=rowsAt(s,yard?.id);return all.map(p=>{const q=at.get(p.id)?.quantity??0;return {p,count:q,dim:!q};}).filter(x=>G.showAll||x.count>0);}
// The slider's stops for one product: whole stillages at the place (Send: the yard; Bring back: the site); Add stock: whole packs, or stillages a
// forklift lifts.
function stopsFor(s,p){if(!p)return [];if(G.mode==='add'){const step=perStillage(p)??10,out=[];for(let k=1;k<=40;k++)out.push({qty:k*step,n:k});return out;}
 const list=itemsFor(pickLoc(s));return list?gpStops(list,p.id).map((x,i)=>({qty:x.qty,n:i+1})):[];}
const unitWord=(p,n)=>G.mode==='add'&&p?.packQuantity>0?(n===1?'pack':'packs'):(n===1?'stillage':'stillages');
// Sort order: kind (tube, standard, ledger ...), its look, its family, then short to long.
const sortKey=(a,b)=>GA_ROW_ORDER.indexOf(gaKind(a.p))-GA_ROW_ORDER.indexOf(gaKind(b.p))||byName(gaLook(a.p),gaLook(b.p))||byName(a.p.system??'',b.p.system??'')||byName(gaFamily(a.p),gaFamily(b.p))||((gaLength(a.p)??0)-(gaLength(b.p)??0))||byName(a.p.name,b.p.name);
// ---------------------------------------------------------------- the skeleton
export function gmShell(ctx){resetFor(ctx);G.ctx=ctx;const s=ctx.state,company=esc(ctx.account?.company?.name??'Your company');
 const top='<header class="gm-top"><div class="gm-brand"><span class="gm-mark" aria-hidden="true">'+gaImg(GA_BUTTONS.stock(),'gm-mark-img')+'</span><b>'+company+'</b></div>'
  +'<div class="gm-top-right"><button type="button" class="gm-office-btn" data-gm-office aria-haspopup="dialog" aria-expanded="false">'+gaImg(GA_BUTTONS.office(),'gm-office-img')+'<span>Office</span></button></div></header>';
 if(!yardOf(s))return '<div class="gm" data-gm="start">'+top+startHTML(ctx)+officeHTML(ctx)+'</div>';
 return '<div class="gm" data-gm="board">'+top+'<div class="gm-body"><section class="gm-board scene world-scene" aria-label="Your yard and sites">'+wmShell()
  +'<div class="gm-trips" data-gm-trips></div><div class="gm-hint" data-gm-hint></div><div class="gm-pops" data-gm-pops role="status" aria-live="polite"></div>'
  +'<div class="gm-view-btns"><button type="button" class="gm-round" data-gm-cam="fit" title="See everything" aria-label="See the whole map">'+viewIcon()+'</button></div>'
  +'<div class="gm-win2" data-gm-win2 hidden></div>'
  +'<nav class="gm-bar" aria-label="What do you want to do?">'+bigBtn('send','Send','Send scaffolding to a site')+bigBtn('back','Bring back','Bring scaffolding back from a site')+bigBtn('add','Add stock','Add stock arriving at the yard')+bigBtn('stock','Stock','See the yard stock',' gm-phone-only')+'</nav></section>'
  +'<aside class="gm-dock" data-gm-dock aria-label="Inventory"><div class="gm-win" data-gm-win><div data-gm-head></div><div class="gm-tabs" data-gm-tabs role="tablist" aria-label="Kinds of material"></div><div class="gm-grid-wrap" data-gm-grid></div><div data-gm-amt></div><div data-gm-acts></div></div></aside></div>'
  +'<div class="gm-card" data-gm-card hidden></div>'+officeHTML(ctx)+'</div>';}
const bigBtn=(k,label,title,cls='')=>'<button type="button" class="gm-big gm-big-'+k+cls+'" data-gm-go="'+k+'" title="'+title+'"><span class="gm-big-pic">'+gaImg(GA_BUTTONS[k](),'gm-big-img')+'</span><span class="gm-big-label">'+label+'</span></button>';
const viewIcon=()=>'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// ---------------------------------------------------------------- first run: the yard size
function startHTML(ctx){const can=ctx.account?.permissions?.includes('operations.manage');
 const tile=(k,name,words)=>'<button type="button" class="gm-size" data-gm-size="'+k+'"><span class="gm-size-pic">'+gaYardPad(k,'gm-size-img')+'</span><b>'+name+'</b><small>'+words+'</small></button>';
 return '<div class="gm-start"><div class="gm-start-in"><p class="gm-start-kicker">Welcome, '+esc(ctx.account?.user?.name??'')+'</p><h1>How big is your yard?</h1><p class="gm-start-sub">Pick the closest. You can change the shape later.</p>'
  +(can?'<div class="gm-sizes">'+tile('S','Small','A few stacks')+tile('M','Medium','A busy yard')+tile('L','Large','A big depot')+'</div><button type="button" class="gm-link" data-gm-draw>Draw my own shape instead</button>':'<p class="gm-start-sub">The owner sets up the yard first.</p>')+'</div></div>';}
// ---------------------------------------------------------------- the Office: a drawer of picture tiles for every other page, in three groups
export const OFFICE_TILES=[
 ['TODAY','Today','Loads due today, on a phone too','sg-list','day'],['SCHEDULE','Schedule','Every load and collection by day','hr-board','day'],['SITES','Client sites','Sites, their plans and dockets','si-site','day'],['STOCK','Stock ledger','Every piece in and out, counts','spr-stillage','day'],['MATERIALS','Materials catalogue','Your parts, weights and packs','spr-bundle','day'],
 ['WORKERS','Workers','Your crew and their jobs','spr-worker','yard'],['EQUIPMENT','Equipment','Forklifts and cranes','spr-forklift','yard'],['TRUCK12','Big trucks','12.5 t trucks, decks and dockets','spr-truck12','yard'],['TRUCK2','Small trucks','2 t trucks for quick runs','spr-truck2','yard'],['YARD','Yard layout','Yard shape, stillages, planner','sg-yard','yard'],['CONTROL','Control room','Crew orders, fleet, full stock grids','spr-worker-busy','yard'],
 ['HIRE','Hire','What is out on hire, and rates','hr-tag','biz'],['REPORTS','Reports','History charts','hc-board','biz'],['OVERVIEW','Overview','The whole business at a glance','spr-forklift-load','biz']];
const OFFICE_GROUPS=[['day','Every day'],['yard','Yard and fleet'],['biz','Business']];
export function officeHTML(ctx){const hire=ctx.hire!==false,s=ctx.state,can=ctx.account?.permissions?.includes('operations.manage');
 const tile=([v,label,sub,art])=>'<button type="button" class="gm-tile'+(ctx.view===v?' current':'')+'" data-view="'+v+'"'+(ctx.view===v?' aria-current="page"':'')+' aria-label="'+esc(label)+'" title="'+esc(sub)+'"><span class="gm-tile-pic">'+gaSprite(art,'gm-tile-img')+'</span><b>'+esc(label)+'</b></button>';
 const groups=OFFICE_GROUPS.map(([g,name])=>{let list=OFFICE_TILES.filter(t=>t[4]===g&&(t[0]!=='HIRE'||hire)&&(can||t[0]!=='CONTROL')).map(tile).join('');
  if(g==='biz')list+='<button type="button" class="gm-tile" id="settings" aria-label="Account" title="Company, team, logo, backups"><span class="gm-tile-pic">'+gaImg(GA_BUTTONS.office(),'gm-tile-img')+'</span><b>Account</b></button>';
  return '<h3 class="gm-tiles-h">'+name+'</h3><div class="gm-tiles-g">'+list+'</div>';}).join('');
 return '<div class="gm-office" data-gm-office-panel hidden><div class="gm-office-in" role="dialog" aria-modal="false" aria-labelledby="gm-office-h"><div class="gm-office-head"><h2 id="gm-office-h">Office</h2><p>Everything else lives here.'+(s&&yardOf(s)&&can?' The yard keeps working while you look.':'')+'</p><button type="button" class="gm-x" data-gm-office-x aria-label="Close the office">&times;</button></div><nav class="gm-tiles" aria-label="Main navigation">'+groups+'</nav></div></div>';}
// Opening and closing the Office drawer (also used on the Office pages by operations.js).
export function gmOfficeToggle(open){const panel=document.querySelector('[data-gm-office-panel]');if(!panel)return;G.office=open??panel.hidden;panel.hidden=!G.office;for(const b of document.querySelectorAll('[data-gm-office]'))b.setAttribute('aria-expanded',String(G.office));if(G.office)panel.querySelector('.gm-tile')?.focus({preventScroll:true});}
// ---------------------------------------------------------------- the inventory window
function headHTML(s){const sites=activeSites(s),site=sites.find(x=>x.id===G.site);let title='Yard stock',sub='',extra='';
 if(G.mode==='send'){title=site?'Send to '+site.name:'Send to a site';sub='Tap what goes, then how much';}
 else if(G.mode==='back'){title=site?'Bring back from '+site.name:'Bring back';sub=site?'Tap what comes back, or bring everything':'From which site?';}
 else if(G.mode==='add'){title='Add stock to the yard';sub='Tap what arrived, then how much';}
 else if(G.mode==='parts'){title='Your scaffold parts';sub='Which scaffold do you use? Tap one or more.';}
 else if(G.mode==='site'){title=site?.name??'Site';sub='On site now';}
 else if(G.mode==='truck'){const t=(s.trucks??[]).find(x=>x.id===G.truck);const w=t?truckWords(s,t):null;title=w?.word??'Truck';sub=t?truckKind(t)+(w.fill>0?' · '+w.load.toLowerCase():' · empty'):'';}
 else if(!products(s).length){title='Your scaffold parts';sub='Which scaffold do you use? Tap one or more.';}
 const x=G.mode==='yard'?'':'<button type="button" class="gm-x" data-gm-close aria-label="Close">&times;</button>';
 if(G.mode==='yard'&&products(s).length&&hasStock(s,yardOf(s)?.id))extra='<button type="button" class="gm-chip'+(G.showAll?' on':'')+'" data-gm-all aria-pressed="'+G.showAll+'">'+(G.showAll?'Only what I have':'Show every part')+'</button>';
 let h='<div class="gm-win-head"><div><h2>'+esc(title)+'</h2>'+(sub?'<p>'+sub+'</p>':'')+'</div>'+extra+x+'</div>';
 if(G.mode==='send'||G.mode==='back'){const list=G.mode==='back'?sites.filter(x=>hasStock(s,x.id)||x.id===G.site):sites;
  h+='<div class="gm-sites" role="radiogroup" aria-label="Site">'+list.map(x=>'<button type="button" role="radio" aria-checked="'+(x.id===G.site)+'" class="gm-site'+(x.id===G.site?' on':'')+'" data-gm-site="'+esc(x.id)+'">'+gaSprite('si-site','gm-site-img')+'<span>'+esc(x.name)+'</span></button>').join('')
   +(G.mode==='send'?'<button type="button" class="gm-site gm-site-new" data-gm-newsite><span class="gm-plus" aria-hidden="true">+</span><span>New site</span></button>':'')+'</div>';
  if(!list.length)h+='<p class="gm-empty-line">'+(G.mode==='send'?'No sites yet. Tap <b>+ New site</b>.':'Nothing is out on a site yet.')+'</p>';}
 return h;}
function tabsHTML(s,list){if(!list.length)return '';const has=new Map();for(const x of list)has.set(gaTab(x.p),(has.get(gaTab(x.p))??0)+1);has.set('all',list.length);
 // All is where a short list lives (the yard at a glance, a site, a truck); a long one (the whole catalogue in Add stock) opens on its first kind
 if(!G.tab||!has.has(G.tab))G.tab=list.length<=40?'all':GA_TABS.find(t=>t.id!=='all'&&has.has(t.id))?.id??'all';
 const shown=GA_TABS.filter(t=>has.has(t.id));if(shown.length<=2)return '';// one kind only: no tabs needed
 return shown.map(t=>'<button type="button" role="tab" class="gm-tab'+(t.id===G.tab?' on':'')+'" data-gm-tab="'+t.id+'" aria-selected="'+(t.id===G.tab)+'" title="'+t.name+'">'+t.pic()+'<span>'+t.name+'</span></button>').join('');}
function gridHTML(s,list){const cols=G.cols,many=new Set(list.map(x=>x.p.system)).size>1;
 if(G.mode==='parts'||(G.mode==='yard'&&!products(s).length))return partsHTML(s);
 const tabs=GA_TABS.filter(t=>list.some(x=>gaTab(x.p)===t.id)).length>1,here=!tabs||G.tab==='all'?list:list.filter(x=>gaTab(x.p)===G.tab);
 if(!here.length){const words=G.mode==='send'?'Nothing to send from the yard yet. Tap <b>Add stock</b> first.':G.mode==='back'||G.mode==='site'?(G.site?'Nothing is on this site.':'Pick a site.'):G.mode==='truck'?'Nothing on board.':'Your yard is empty. Tap <b>Add stock</b>.';
  return '<div class="gm-grid" data-cols="'+cols+'">'+voids(cols*G.rows)+'</div><p class="gm-empty-line gm-empty-over">'+words+'</p>';}
 const sorted=[...here].sort((a,b)=>GA_TABS.findIndex(t=>t.id===gaTab(a.p))-GA_TABS.findIndex(t=>t.id===gaTab(b.p))||sortKey(a,b));let html='',rows=0;
 // Add stock on one kind's tab: a row per kind of part, like Factorio's request window; everything else: one packed grid, like its inventory
 if(G.mode==='add'&&G.tab!=='all'){let k=null,n=0;for(const x of sorted){const kind=gaKind(x.p);if(kind!==k&&n){html+=voids((cols-n%cols)%cols);rows+=Math.ceil(n/cols);n=0;}k=kind;html+=slotHTML(x,many);n++;}if(n){html+=voids((cols-n%cols)%cols);rows+=Math.ceil(n/cols);}}
 else{html=sorted.map(x=>slotHTML(x,many)).join('')+voids((cols-sorted.length%cols)%cols);rows=Math.ceil(sorted.length/cols);}
 if(rows<G.rows)html+=voids((G.rows-rows)*cols);
 return '<div class="gm-grid" data-cols="'+cols+'" role="list">'+html+'</div>';}
const voids=n=>'<span class="gm-slot gm-void" aria-hidden="true"></span>'.repeat(Math.max(0,n));
function slotHTML(x,many){const p=x.p,pick=G.picks.get(p.id),where=G.mode==='truck'?'on board':G.mode==='back'||G.mode==='site'?'on site':'in the yard',tag=PICKING.includes(G.mode)?gaLenTag(p):'';
 const label=p.name+(x.quiet?'':': '+num(x.count)+' '+where)+(pick?', '+num(pick)+' picked':'');
 const corner=pick?'<b class="gm-n gm-n-pick">'+gpCount(pick)+'</b>':x.count&&!x.quiet?'<b class="gm-n">'+gpCount(x.count)+'</b>':'';
 return '<button type="button" role="listitem" class="gm-slot'+(x.dim?' dim':'')+(pick?' picked':'')+(G.sel===p.id?' sel':'')+(G.bumps.has(p.id)?' bump':'')+'" data-gm-slot="'+esc(p.id)+'" aria-label="'+esc(label)+'"'+(PICKING.includes(G.mode)?' aria-pressed="'+(!!pick)+'"':'')+'>'+gaItem(p)
  +(tag?'<i class="gm-len">'+esc(tag)+'</i>':'')+(many?'<s class="gm-sys '+(SYS_CLASS[p.system]??'')+'"></s>':'')+corner+'</button>';}
// "Which scaffold do you use?": the three systems as pictures; the reviewed supplier lists load for the ones picked.
function partsHTML(s){const on=G.systems;return '<div class="gm-parts"><div class="gm-sysgrid" role="group" aria-label="Scaffold systems">'+SYSTEMS.map(([id,name,words])=>'<button type="button" class="gm-sys-btn'+(on.has(id)?' on':'')+'" data-gm-system="'+id+'" aria-pressed="'+on.has(id)+'">'+gaSystemPic(id,'gm-sys-img')+'<b>'+name+'</b><small>'+words+'</small></button>').join('')+'</div>'
 +'<p class="gm-parts-note">We load your supplier\'s own parts list with the real weights. You can add your own list later in the Office.</p></div>';}
function amountHTML(s){if(!G.sel||!PICKING.includes(G.mode))return '';const p=products(s).find(x=>x.id===G.sel);if(!p)return '';
 const stops=stopsFor(s,p),q=G.picks.get(p.id)??0,i=stops.findIndex(x=>x.qty===q),idx=i<0?(q?stops.filter(x=>x.qty<q).length:0):i+1,max=stops.length;
 const words=q?(G.mode==='add'&&!(p.packQuantity>0)&&!(p.unitWeight>0)?num(q)+' pieces':idx+' '+unitWord(p,idx)+(G.mode!=='add'&&idx===max?' · all of it':'')):'None yet';
 const loading=!PICKING.includes(G.mode)||G.mode==='add'||itemsFor(pickLoc(s));
 return '<div class="gm-amt"><div class="gm-amt-top">'+gaItem(p,'gm-amt-pic')+'<div class="gm-amt-name"><b>'+esc(p.name)+'</b><small data-gm-words>'+esc(words)+'</small></div><button type="button" class="gm-chip" data-gm-unpick>Remove</button></div>'
  +(max?'<div class="gm-amt-row"><button type="button" class="gm-step" data-gm-step="-1" aria-label="Less">&minus;</button><input type="range" class="gm-range" data-gm-live data-gm-range min="0" max="'+max+'" step="1" value="'+idx+'" aria-label="How many of '+esc(p.name)+'"><button type="button" class="gm-step" data-gm-step="1" aria-label="More">+</button><input type="number" class="gm-num" data-gm-live data-gm-num min="0" step="1" value="'+q+'" inputmode="numeric" aria-label="Amount of '+esc(p.name)+'"></div>'
   :'<p class="gm-empty-line">'+(loading?'None of this can be moved right now.':'Looking in the stillages&hellip;')+'</p>')+'</div>';}
// What else rides along in the picked stillages (a mixed stillage, or what is stacked on one): shown before Send so nothing is a surprise.
function extrasHTML(s){if(!['send','back'].includes(G.mode)||!G.picks.size)return '';const list=itemsFor(pickLoc(s));if(!list)return '';
 const r=gpChoose(list,[...G.picks].map(([product,quantity])=>({product,quantity})));if(!r.extra.size)return '';const ps=new Map(products(s).map(p=>[p.id,p]));
 return '<div class="gm-extra"><span>Also on those stillages:</span><div class="gm-extra-row">'+[...r.extra].slice(0,8).map(([id,q])=>{const p=ps.get(id);return p?'<span class="gm-slot gm-mini" title="'+esc(p.name)+'">'+gaItem(p)+'<b class="gm-n">'+gpCount(q)+'</b></span>':'';}).join('')+'</div></div>';}
function actsHTML(s){const site=activeSites(s).find(x=>x.id===G.site),picks=[...G.picks].filter(([,q])=>q>0);
 if(G.mode==='send'){const ok=!!site&&picks.length>0&&!G.busy;
  return '<div class="gm-acts">'+extrasHTML(s)+(picks.length?'<p class="gm-est">'+esc(loadWords(s,picks))+'</p>':'')+'<button type="button" class="gm-go gm-go-big" data-gm-do="send"'+(ok?'':' disabled')+'>'+gaImg(GA_BUTTONS.send(),'gm-go-img')+(site?'Send to '+esc(site.name):'Send')+'</button><p class="gm-foot">On the next free truck, today. The crew loads it for you.</p></div>';}
 if(G.mode==='back'){const has=site&&hasStock(s,site.id);return '<div class="gm-acts">'+extrasHTML(s)+(picks.length?'<button type="button" class="gm-go gm-go-big" data-gm-do="back"'+(G.busy?' disabled':'')+'>'+gaImg(GA_BUTTONS.back(),'gm-go-img')+'Bring these back</button>':'')+'<button type="button" class="gm-go'+(picks.length?' gm-go-alt':' gm-go-big')+'" data-gm-do="backall"'+(has&&!G.busy?'':' disabled')+'>'+(picks.length?'':gaImg(GA_BUTTONS.back(),'gm-go-img'))+'Bring everything back</button><p class="gm-foot">The next free truck goes there, the site crane loads it.</p></div>';}
 if(G.mode==='add')return '<div class="gm-acts"><button type="button" class="gm-go gm-go-big" data-gm-do="add"'+(picks.length&&!G.busy?'':' disabled')+'>'+gaImg(GA_BUTTONS.add(),'gm-go-img')+'Add to the yard</button></div>';
 if(G.mode==='parts'||(G.mode==='yard'&&!products(s).length))return '<div class="gm-acts"><button type="button" class="gm-go gm-go-big" data-gm-do="parts"'+(G.systems.size&&!G.busy?'':' disabled')+'>'+gaImg(GA_BUTTONS.stock(),'gm-go-img')+'Load my parts list</button></div>';
 if(G.mode==='site')return '<div class="gm-acts gm-acts-2"><button type="button" class="gm-go" data-gm-go="send" data-gm-for="'+esc(G.site)+'">'+gaImg(GA_BUTTONS.send(),'gm-go-img')+'Send here</button><button type="button" class="gm-go gm-go-alt" data-gm-go="back" data-gm-for="'+esc(G.site)+'"'+(hasStock(s,G.site)?'':' disabled')+'>'+gaImg(GA_BUTTONS.back(),'gm-go-img')+'Bring back</button></div>';
 if(G.mode==='truck'){const t=(s.trucks??[]).find(x=>x.id===G.truck);if(!t)return '';const w=truckWords(s,t);return '<div class="gm-acts"><div class="gm-fill gm-fill-big" title="'+esc(w.load)+'"><b data-style="width:'+Math.round(w.fill*100)+'%"></b></div><div class="gm-acts-2"><button type="button" class="gm-go" data-gm-cam="truck" data-gm-for="'+esc(t.id)+'">Follow it</button><button type="button" class="gm-go gm-go-alt" data-view="'+(t.payload>=HEAVY?'TRUCK12':'TRUCK2')+'">Truck page</button></div></div>';}
 return '';}
// Words for how full the trucks will be: the picked pieces' weight plus a stillage each, against a 12.5 t truck.
function loadWords(s,picks){const ps=new Map(products(s).map(p=>[p.id,p]));let g=0,known=true,n=0;for(const [id,q] of picks){const p=ps.get(id);if(!(p?.unitWeight>0)){known=false;continue;}g+=p.unitWeight*q;const per=perStillage(p);n+=per?Math.ceil(q/per):1;}g+=n*TARE;
 if(!known&&!g)return 'Weight not known for this part';const t=g/12500000;if(t>1)return 'About '+Math.ceil(t)+' truckloads';return 'Fills a truck: '+gpFill(t).toLowerCase();}
// ---------------------------------------------------------------- trucks on a trip, in words, top left (nothing when all are parked)
function truckWords(s,t){const tasks=s.tasks??[],to=tasks.some(x=>x.to===t.id),from=tasks.some(x=>x.from===t.id),g=t.game,dest=t.destination??g?.site;
 const fill=Math.min(1,Math.max(0,(t.loadedWeight??0)/(t.payload||1))),load=gpFill(fill);let word;
 if(g?.problem)word='Waiting: '+g.problem;
 else if(t.status==='IN_TRANSIT'){const home=(s.yards??[]).some(y=>y.id===t.destination),left=(t.remainingMs??0)/1000;word=(home?'Coming back to the yard':'On the way to '+siteName(s,t.destination))+(left<8?' · arriving soon':'');}
 else if(to)word=t.status==='AT_SITE'?'Loading at '+siteName(s,t.at):'Loading'+(dest?' for '+siteName(s,dest):'');
 else if(from)word='Unloading'+(t.status==='AT_SITE'?' at '+siteName(s,t.at):'');
 else if(t.status==='AT_SITE')word='At '+siteName(s,t.at);
 else word=fill>0?'Loaded, waiting':'Ready at the yard';
 if(fill>0&&!g?.problem)word+=' · '+load.toLowerCase();
 return {word,fill,load,state:g?.problem?'warn':t.status==='IN_TRANSIT'?'road':to||from?'busy':'idle'};}
function tripsHTML(s){const list=(s.trucks??[]).filter(t=>!t.retired&&(t.game||t.status==='IN_TRANSIT')).sort((a,b)=>byName(a.name,b.name));
 const orders=(s.gameOrders??[]).map(o=>'<div class="gm-trip wait"><span class="gm-trip-wait" aria-hidden="true"></span><span class="gm-trip-t"><b>Waiting for a truck</b><small>'+(o.type==='SEND'?'To ':'Back from ')+esc(siteName(s,o.site))+'</small></span><button type="button" class="gm-x gm-x-sm" data-gm-cancel="'+esc(o.id)+'" aria-label="Do not send this">&times;</button></div>').join('');
 return list.map(t=>{const w=truckWords(s,t);return '<button type="button" class="gm-trip '+w.state+(G.truck===t.id&&G.mode==='truck'?' on':'')+'" data-gm-truck="'+esc(t.id)+'" title="'+esc(truckKind(t)+': '+w.word)+'">'+ovImg(t.payload>=HEAVY?'spr-truck12':'spr-truck2','gm-trip-img')+'<span class="gm-trip-t"><small>'+esc(w.word)+'</small><i class="gm-fill" aria-hidden="true"><b data-style="width:'+Math.round(w.fill*100)+'%"></b></i></span></button>';}).join('')+orders;}
// ---------------------------------------------------------------- hints: one at a time, game-tutorial style, each dismissable for good
function hintOf(s){const stuck=(s.trucks??[]).find(t=>t.game?.problem);if(stuck)return {id:'',text:'A truck is waiting'+(stuck.status==='AT_SITE'?' at '+siteName(s,stuck.at):'')+': '+stuck.game.problem,warn:true};
 // the crew cannot finish a lift for a truck on a trip: say why, and where to sort it out
 const blocked=(s.tasks??[]).find(x=>x.state==='BLOCKED'&&(s.trucks??[]).some(t=>t.game&&(x.to===t.id||x.from===t.id)));if(blocked)return {id:'',text:'The crew is stuck: '+(blocked.reason??'a lift cannot be finished')+' Open the Office, Control room, to sort it out.',warn:true};
 const yard=yardOf(s),stockHere=hasStock(s,yard?.id),sites=activeSites(s),delivered=(s.sites??[]).some(x=>x.lastDeliveryAt),moving=(s.trucks??[]).some(t=>t.game);
 let h=null;
 // no parts yet: the inventory window itself asks (a phone, where it is folded away, gets the hint)
 if(!products(s).length)h=phone()?{id:'parts',text:'Welcome! First, load your scaffold parts.',act:['Load my parts','parts'],point:'add'}:null;
 else if(!stockHere)h={id:'add',text:'Tap Add stock to fill your yard with scaffolding.',act:['Add stock','add'],point:'add'};
 else if(!sites.length)h={id:'site',text:'Now open your first client site: tap an empty block on the map.',act:['Open a site','newsite']};
 else if(moving&&!delivered)h={id:'watch',text:'Sit back and watch: the crew loads the truck, it drives there and the site crane unloads it.'};
 else if(!delivered)h={id:'send',text:'Tap Send to send scaffolding to '+sites[0].name+'. The crew does the rest.',act:['Send','send'],point:'send'};
 else h={id:'tapsite',text:'Tap a site on the map to see what is there.',target:sites.find(x=>hasStock(s,x.id))?.id??sites[0].id};
 return h&&!G.hintOff.has(h.id)?h:null;}
function hintHTML(s){const h=(G.mode==='yard'||G.mode==='site'||G.mode==='truck')&&!G.win?hintOf(s):hintOf(s)?.warn?hintOf(s):null;if(!h)return '';
 return '<div class="gm-bubble'+(h.warn?' warn':'')+(h.point?' point-'+h.point:'')+(h.target?' aimed':'')+'" data-hint="'+esc(h.id)+'"'+(h.target?' data-aim="'+esc(h.target)+'"':'')+'>'+ovImg('spr-worker','gm-boss')+'<p>'+esc(h.text)+'</p>'+(h.act?'<button type="button" class="gm-go gm-hint-go" data-gm-hint-act="'+h.act[1]+'">'+esc(h.act[0])+'</button>':'')+(h.id?'<button type="button" class="gm-x" data-gm-hint-x aria-label="Hide this tip">&times;</button>':'')+'</div>';}
// A hint about a place points at it on the map (the camera moves, so it is re-aimed now and then; CSS glides it).
function aimHint(){const box=document.querySelector('[data-gm-hint]'),b=box?.querySelector('.gm-bubble[data-aim]'),board=document.querySelector('.gm-board');if(!b||!board){box?.classList.remove('aimed');return;}
 const B=board.getBoundingClientRect(),ground=document.querySelector('[data-wm-site="'+CSS.escape(b.dataset.aim)+'"] .wm-site-ground'),g=ground?.getBoundingClientRect();
 // aimed only while the site's ground is well inside the map; otherwise the bubble waits above the buttons
 const r=g&&g.width&&g.right>B.left+40&&g.left<B.right-40&&g.bottom>B.top+40&&g.top<B.bottom-160?g:null;
 if(!r||phone()){box.classList.remove('aimed','below');box.style.left='';box.style.top='';return;}
 const w=box.offsetWidth,h=box.offsetHeight;let x=r.left-B.left+r.width/2-w/2,y=r.top-B.top-h-14;const below=y<64;if(below)y=r.bottom-B.top+14;y=Math.max(10,Math.min(y,B.height-h-120));x=Math.max(10,Math.min(x,B.width-w-10));
 box.classList.add('aimed');box.classList.toggle('below',below);box.style.left=Math.round(x)+'px';box.style.top=Math.round(y)+'px';}
// ---------------------------------------------------------------- pops: a truck sets off, a delivery lands, a collection is home
const POPS={'Delivered':'tick','Back at the yard':'tick','Truck departed':'go','Not sent':'warn'};
function pops(s){const list=s.notifications??[],ids=list.map(n=>n.id);if(G.seen===null){G.seen=new Set(ids);return;}for(const n of list){if(G.seen.has(n.id))continue;G.seen.add(n.id);const kind=POPS[n.title];if(!kind)continue;
  let text=n.body;if(n.title==='Delivered')text=n.body.split('!')[0]+'!';else if(n.title==='Back at the yard'){const m=n.body.match(/is back from (.*?) and/);text=m?'Back at the yard from '+m[1]+'!':'Back at the yard!';}
  else if(n.title==='Truck departed'){const m=n.body.match(/^(.*) is travelling to (.*)\.$/);if(m&&(s.yards??[]).some(y=>y.name===m[2]))continue;if(m&&G.quiet.get(m[1])>Date.now())continue;text=m?'A truck is on its way to '+m[2]:n.body;}
  pop(text,kind);}}
export function pop(text,kind='tick'){const box=document.querySelector('[data-gm-pops]');if(!box)return;const el=document.createElement('div');el.className='gm-pop '+kind;el.innerHTML=(kind==='tick'?'<span class="gm-tick" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>':kind==='go'?'<span class="gm-go-dot" aria-hidden="true"></span>':kind==='warn'?'<span class="gm-warn-dot" aria-hidden="true">!</span>':'')+'<span>'+esc(text)+'</span>';
 box.append(el);while(box.children.length>2)box.firstElementChild.remove();document.querySelector('.gm-board')?.classList.add('popping');setTimeout(()=>{el.classList.add('out');setTimeout(()=>{el.remove();if(!box.children.length)document.querySelector('.gm-board')?.classList.remove('popping');},600);},kind==='warn'?7000:kind==='tick'?4200:3200);}
// ---------------------------------------------------------------- the small window over the map: a new site
function win2HTML(){if(G.win?.kind!=='newsite')return '';
 return '<div class="gm-nw" role="dialog" aria-labelledby="gm-nw-h"><button type="button" class="gm-x" data-gm-win-x aria-label="Close">&times;</button><div class="gm-nw-pic">'+gaSprite('si-site','gm-nw-img')+'</div><h3 id="gm-nw-h">Open a new site</h3><p>'+(G.win.then==='send'?'Where does it go? ':'')+'What is the site called?</p>'
  +'<form class="gm-newsite" data-gm-newsite-form><input name="name" required maxlength="120" placeholder="e.g. George St" aria-label="Site name" autocomplete="off"><button type="submit" class="gm-go">Open site</button></form></div>';}
function openWin(win){G.win=win;hideCard();const el=document.querySelector('[data-gm-win2]');if(el){el.__h=null;}refreshNow();setTimeout(()=>document.querySelector('[data-gm-newsite-form] input')?.focus(),40);}
function closeWin(){G.win=null;refreshNow();}
// ---------------------------------------------------------------- update (every poll) and patching
const setHTML=(el,html)=>{if(!el)return false;if(el.__h===html)return false;el.__h=html;el.innerHTML=html;return true;};
function measure(){const p=phone();G.cols=p?Math.max(5,Math.min(9,Math.floor(((typeof innerWidth==='number'?innerWidth:375)-24+4)/46))):10;
 const wrap=document.querySelector('[data-gm-grid]');let rows=p?2:4;if(!p&&wrap&&wrap.clientHeight>0){const cell=(G.cols===10&&innerWidth>=1600?40:36)+3;rows=Math.max(3,Math.floor((wrap.clientHeight-10)/cell));}G.rows=rows;}
export function gmUpdate(ctx){G.ctx=ctx;resetFor(ctx);const root=document.querySelector('[data-gm]');if(!root)return;const s=ctx.state;if(root.dataset.gm==='start'){bindOnce(root);return;}
 ctx.wm?.();
 // keep the picks honest: what is no longer there cannot stay picked
 if(G.site&&!activeSites(s).some(x=>x.id===G.site)){G.site=null;if(['site','back'].includes(G.mode))G.mode='yard';}
 if(G.mode==='truck'&&!(s.trucks??[]).some(t=>t.id===G.truck&&!t.retired))G.mode='yard';
 if(G.mode==='parts'&&products(s).length&&!G.busy)G.mode='add';
 ensureItems(s);
 const list=gridItems(s),counts=new Map(list.map(x=>[x.p.id,x.count]));if(G.mode==='yard'){for(const [id,n] of counts){const was=G.counts.get(id);if(was!=null&&n>was)bumpSoon(id);}G.counts=counts;}
 const body=root.querySelector('.gm-body'),win=root.querySelector('[data-gm-win]');if(win)win.className='gm-win mode-'+G.mode;
 body?.classList.toggle('dock-open',G.mode!=='yard');body?.classList.toggle('picking',PICKING.includes(G.mode)&&!!G.sel);
 setHTML(root.querySelector('[data-gm-head]'),headHTML(s));setHTML(root.querySelector('[data-gm-tabs]'),tabsHTML(s,list));
 const amt=root.querySelector('[data-gm-amt]');if(!amt?.contains(document.activeElement)||!document.activeElement?.matches('input'))setHTML(amt,amountHTML(s));
 setHTML(root.querySelector('[data-gm-acts]'),actsHTML(s));
 measure();const grid=root.querySelector('[data-gm-grid]');const top=grid?.scrollTop??0;if(setHTML(grid,gridHTML(s,list))&&grid)grid.scrollTop=top;
 setHTML(root.querySelector('[data-gm-trips]'),tripsHTML(s));
 const hint=hintHTML(s);setHTML(root.querySelector('[data-gm-hint]'),hint);aimHint();
 const w2=root.querySelector('[data-gm-win2]');if(w2){setHTML(w2,win2HTML());w2.hidden=!G.win;}
 const hp=G.mode==='yard'&&!G.win?hintOf(s)?.point:null;
 for(const b of root.querySelectorAll('.gm-bar [data-gm-go]')){b.classList.toggle('hinted',b.dataset.gmGo===hp);b.classList.toggle('on',b.dataset.gmGo===G.mode||(b.dataset.gmGo==='stock'&&G.mode==='yard'&&!!body?.classList.contains('sheet')));}
 pops(s);bindOnce(root);syncCard();
 if(!G.aimT)G.aimT=setInterval(()=>{if(!document.querySelector('[data-gm="board"]')){clearInterval(G.aimT);G.aimT=0;return;}aimHint();},700);}
function bumpSoon(id){G.bumps.add(id);setTimeout(()=>{G.bumps.delete(id);document.querySelector('[data-gm-slot="'+CSS.escape(id)+'"]')?.classList.remove('bump');},900);}
// The stillages behind the slider (Send: the yard, Bring back: the site), fetched when Send or Bring back opens and kept fresh while it stays open.
function ensureItems(s){const loc=pickLoc(s);if(!loc||G.items.busy||!G.ctx?.get)return;if(G.items.loc===loc&&Date.now()-G.items.at<3000)return;
 G.items.busy=true;const who=G.who;G.ctx.get('game-items?loc='+encodeURIComponent(loc)).then(r=>{if(G.who!==who)return;G.items={loc:r.loc,list:r.items??[],at:Date.now(),busy:false};
  if(G.pending&&PICKING.includes(G.mode)){const p=products(G.ctx.state).find(x=>x.id===G.pending),first=stopsFor(G.ctx.state,p)[0];if(first&&!G.picks.get(p.id))G.picks.set(p.id,first.qty);G.pending=null;}
  // an amount that no longer matches a whole stillage snaps to one that does
  for(const [id,q] of G.picks){const st=stopsFor(G.ctx.state,{id});const v=gpSnap(st,q);if(v&&v!==q)G.picks.set(id,v);}
  refreshNow();}).catch(()=>{G.items.busy=false;G.items.at=Date.now();});}
// The site the map lights up.
export const gmGlow=()=>['send','back','site'].includes(G.mode)?G.site:null;
// A tap on the map (world.js ctx.onPick): a site opens its inventory (or becomes the Send / Bring back target), a truck its own, the yard the yard's,
// an empty block a new site there.
export function gmPick(kind,id){const ctx=G.ctx;if(!ctx)return false;
 if(kind==='lot'){if(!ops())return false;if(G.win){closeWin();return true;}openWin({kind:'newsite',col:id.col,row:id.row,then:G.mode==='send'?'send':null});return true;}
 if(kind==='yard'){if(PICKING.includes(G.mode)&&G.picks.size)return true;if(G.mode!=='yard')setMode('yard');if(phone())openSheet();refreshNow();return true;}
 if(kind==='site'){if(G.mode==='send'||G.mode==='back'){if(G.mode==='back'&&G.site!==id){G.picks=new Map();G.sel=null;}G.site=id;G.lastSite=id;}else{G.mode='site';G.site=id;G.picks=new Map();G.sel=null;if(!G.hintOff.has('tapsite')){G.hintOff.add('tapsite');store.set(hintKey(),[...G.hintOff].join(','));}}openSheet();refreshNow();return true;}
 if(kind==='truck'){G.mode='truck';G.truck=id;G.sel=null;openSheet();refreshNow();wmFocus('truck',id);return true;}return false;}
const refreshNow=()=>{if(G.ctx)gmUpdate(G.ctx);};
const openSheet=()=>document.querySelector('.gm-body')?.classList.add('sheet');
function setMode(mode,site){hideCard();G.mode=mode;G.picks=new Map();G.sel=null;G.pending=null;G.busy=false;G.win=null;const s=G.ctx.state,sites=activeSites(s);
 if(site)G.site=site;else if(mode==='send'){if(!sites.some(x=>x.id===G.site))G.site=sites.find(x=>x.id===G.lastSite)?.id??sites[0]?.id??null;}
 else if(mode==='back'){const withStock=sites.filter(x=>hasStock(s,x.id));if(!withStock.some(x=>x.id===G.site))G.site=withStock.find(x=>x.id===G.lastSite)?.id??withStock[0]?.id??null;}
 if(mode==='add'&&!products(s).length)G.mode='parts';
 if(mode==='yard')document.querySelector('.gm-body')?.classList.remove('sheet');else openSheet();
 G.tab=null;refreshNow();if(G.site&&(mode==='send'||mode==='back'))wmFocus('site',G.site);
 // the first Send with no site yet: name one first
 if(mode==='send'&&!site&&!sites.length&&ops())openWin({kind:'newsite',then:'send'});}
// ---------------------------------------------------------------- events (one delegated set per board)
function bindOnce(root){if(root.__gmBound)return;root.__gmBound=true;
 root.addEventListener('click',onClick);root.addEventListener('input',onInput);root.addEventListener('change',onChange);root.addEventListener('submit',onSubmit);
 root.addEventListener('pointerover',onOver);root.addEventListener('pointerout',onOut);root.addEventListener('pointerdown',onDown);root.addEventListener('pointerup',()=>clearTimeout(G.pressT));root.addEventListener('pointercancel',()=>clearTimeout(G.pressT));
 root.addEventListener('focusin',e=>{const b=e.target.closest?.('[data-gm-slot]');if(b&&b.matches(':focus-visible'))showCard(b);});root.addEventListener('focusout',()=>hideCard());
 if(!G.keys){G.keys=true;document.addEventListener('keydown',e=>{if(e.key!=='Escape'||!document.querySelector('[data-gm]'))return;if(G.office){gmOfficeToggle(false);return;}if(G.win){closeWin();return;}if(!document.querySelector('[data-gm-card]')?.hidden){hideCard();return;}if(G.mode!=='yard')setMode('yard');});
  addEventListener('resize',()=>{if(document.querySelector('[data-gm="board"]'))refreshNow();});}}
async function run(action,data,ok){const ctx=G.ctx;if(G.busy)return null;G.busy=true;refreshNow();try{const r=await ctx.cmd(action,data);if(r?.truck?.name)G.quiet.set(r.truck.name,Date.now()+20000);await ctx.refresh();G.busy=false;if(ok)ok(r);return r;}catch(e){ctx.notify(e.message);return null;}finally{G.busy=false;refreshNow();}}
function onClick(e){const ctx=G.ctx,s=ctx?.state;if(!ctx)return;const t=e.target;const b=t.closest('button');if(!b)return;
 if(b.dataset.view){e.preventDefault();gmOfficeToggle(false);ctx.go(b.dataset.view);return;}
 if(b.id==='settings'){gmOfficeToggle(false);ctx.settings?.();return;}
 if(b.hasAttribute('data-gm-office')){gmOfficeToggle();return;}if(b.hasAttribute('data-gm-office-x')){gmOfficeToggle(false);return;}
 if(b.dataset.gmSize){run('gameStart',{size:b.dataset.gmSize},r=>setTimeout(()=>pop(r.message,'tick'),900));return;}
 if(b.hasAttribute('data-gm-draw')){ctx.go('YARD');return;}
 if(b.dataset.gmGo){const k=b.dataset.gmGo;if(k==='stock'){const body=document.querySelector('.gm-body');if(G.mode==='yard'&&body?.classList.contains('sheet'))body.classList.remove('sheet');else{setMode('yard');openSheet();}refreshNow();return;}
  if(G.mode===k&&!b.dataset.gmFor){setMode('yard');return;}setMode(k,b.dataset.gmFor);return;}
 if(b.hasAttribute('data-gm-close')){setMode('yard');return;}
 if(b.hasAttribute('data-gm-win-x')){closeWin();return;}
 if(b.dataset.gmCam){if(b.dataset.gmCam==='truck')wmFocus('truck',b.dataset.gmFor);else wmFocus('fit');return;}
 if(b.hasAttribute('data-gm-all')){G.showAll=!G.showAll;refreshNow();return;}
 if(b.dataset.gmTab){G.tab=b.dataset.gmTab;refreshNow();const g=document.querySelector('[data-gm-grid]');if(g)g.scrollTop=0;return;}
 if(b.dataset.gmSite){if(G.mode==='back'&&G.site!==b.dataset.gmSite){G.picks=new Map();G.sel=null;}G.site=b.dataset.gmSite;G.lastSite=G.site;refreshNow();wmFocus('site',G.site);return;}
 if(b.hasAttribute('data-gm-newsite')){openWin({kind:'newsite',then:'send'});return;}
 if(b.dataset.gmSystem){const id=b.dataset.gmSystem;if(G.systems.has(id))G.systems.delete(id);else G.systems.add(id);refreshNow();return;}
 if(b.dataset.gmTruck){if(G.mode==='truck'&&G.truck===b.dataset.gmTruck){setMode('yard');return;}gmPick('truck',b.dataset.gmTruck);return;}
 if(b.dataset.gmCancel){run('gameCancel',{id:b.dataset.gmCancel},r=>pop(r.message,'go'));return;}
 if(b.dataset.gmSlot){hideCard();const id=b.dataset.gmSlot;if(!PICKING.includes(G.mode)){showCard(b,true);return;}
  if(G.sel===id){refreshNow();return;}G.sel=id;if(!G.picks.get(id)){const p=products(s).find(x=>x.id===id),first=stopsFor(s,p)[0];if(first)G.picks.set(id,first.qty);else if(G.mode!=='add')G.pending=id;}refreshNow();return;}
 if(b.hasAttribute('data-gm-unpick')){G.picks.delete(G.sel);G.sel=null;refreshNow();return;}
 if(b.dataset.gmStep){const p=products(s).find(x=>x.id===G.sel);if(!p)return;const stops=stopsFor(s,p),q=G.picks.get(p.id)??0,i=stops.findIndex(x=>x.qty===q);let k=(i<0?stops.filter(x=>x.qty<q).length-1:i)+Number(b.dataset.gmStep);k=Math.max(-1,Math.min(stops.length-1,k));if(k<0)G.picks.delete(p.id);else G.picks.set(p.id,stops[k].qty);refreshNow();return;}
 if(b.dataset.gmHintAct){const a=b.dataset.gmHintAct;if(a==='newsite')openWin({kind:'newsite',then:'send'});else if(a==='parts')setMode('parts');else setMode(a);return;}
 if(b.hasAttribute('data-gm-hint-x')){const id=b.closest('[data-hint]')?.dataset.hint;if(id){G.hintOff.add(id);store.set(hintKey(),[...G.hintOff].join(','));}refreshNow();return;}
 if(b.dataset.gmDo){const lines=[...G.picks].filter(([,q])=>q>0).map(([product,quantity])=>({product,quantity}));const site=G.site,name=siteName(s,site),done=()=>{setMode('yard');wmFocus('director');};
  if(b.dataset.gmDo==='send')run('gameSend',{site,lines},r=>{G.lastSite=site;pop(r.queued?r.message:'The crew is loading a truck for '+name,'go');if(r.left?.length)ctx.notify(r.message);done();});
  else if(b.dataset.gmDo==='back'||b.dataset.gmDo==='backall')run('gameCollect',b.dataset.gmDo==='back'?{site,lines}:{site,all:true},r=>{if(r.truck)G.quiet.set(r.truck.name,Date.now()+20000);pop(r.queued?r.message:'A truck is on its way to '+name+' to bring '+(b.dataset.gmDo==='back'?'it':'everything')+' back','go');done();});
  else if(b.dataset.gmDo==='add')run('gameAddStock',{lines},()=>{pop('Added to the yard!','tick');setMode('yard');});
  else if(b.dataset.gmDo==='parts')run('gameCatalogue',{systems:[...G.systems]},r=>{pop(r.message,'tick');G.mode='add';G.tab=null;});
  return;}}
function setPickFromIndex(k){const s=G.ctx.state,p=products(s).find(x=>x.id===G.sel);if(!p)return;const stops=stopsFor(s,p);if(!stops.length)return;if(k<=0)G.picks.delete(p.id);else G.picks.set(p.id,stops[Math.min(k,stops.length)-1].qty);const q=G.picks.get(p.id)??0,n=Math.min(k,stops.length);
 const box=document.querySelector('[data-gm-num]');if(box&&document.activeElement!==box)box.value=String(q);const w=document.querySelector('[data-gm-words]');if(w)w.textContent=q?n+' '+unitWord(p,n)+(G.mode!=='add'&&n===stops.length?' · all of it':''):'None yet';
 const slot=document.querySelector('[data-gm-slot="'+CSS.escape(p.id)+'"]');if(slot){slot.classList.toggle('picked',q>0);let em=slot.querySelector('.gm-n');if(q){if(!em){em=document.createElement('b');slot.append(em);}em.className='gm-n gm-n-pick';em.textContent=gpCount(q);}else if(em?.classList.contains('gm-n-pick'))em.remove();}}
function onInput(e){if(e.target.matches('[data-gm-range]'))setPickFromIndex(Number(e.target.value));}
function onChange(e){const t=e.target;if(t.matches('[data-gm-range]')){setPickFromIndex(Number(t.value));t.blur();refreshNow();return;}
 if(t.matches('[data-gm-num]')){const s=G.ctx.state,p=products(s).find(x=>x.id===G.sel);if(!p)return;const want=Math.max(0,Math.floor(Number(t.value)||0));let q=want;
  if(G.mode==='add'){const step=p.packQuantity>0?p.packQuantity:null;if(step&&want)q=Math.ceil(want/step)*step;}else q=gpSnap(stopsFor(s,p),want);
  if(q)G.picks.set(p.id,q);else G.picks.delete(p.id);t.blur();refreshNow();}}
function onSubmit(e){const f=e.target.closest('[data-gm-newsite-form]');if(!f)return;e.preventDefault();const d=Object.fromEntries(new FormData(f));if(!String(d.name??'').trim())return;const w=G.win??{};
 run('gameSite',{name:d.name,...(Number.isInteger(w.col)&&Number.isInteger(w.row)?{col:w.col,row:w.row}:{})},r=>{G.win=null;G.lastSite=r.site.id;pop(r.site.name+' is on the map!','tick');setMode('send',r.site.id);setTimeout(()=>wmFocus('site',r.site.id),700);});}
// ---------------------------------------------------------------- the hover card (mouse hover, keyboard focus, or a long press / a tap outside the picking modes)
function onOver(e){if(e.pointerType==='touch')return;const b=e.target.closest?.('[data-gm-slot]');if(!b)return;clearTimeout(G.hoverT);G.hoverT=setTimeout(()=>showCard(b),PICKING.includes(G.mode)?500:200);}
function onOut(e){const b=e.target.closest?.('[data-gm-slot]');if(!b)return;if(e.relatedTarget&&b.contains(e.relatedTarget))return;clearTimeout(G.hoverT);hideCard();}
function onDown(e){if(e.pointerType!=='touch')return;const b=e.target.closest?.('[data-gm-slot]');if(!b)return;clearTimeout(G.pressT);G.pressT=setTimeout(()=>showCard(b,true),480);}
// Beside the inventory window, level with the slot, so it never covers the grid. A phone: in the strip of map between the top bar and the sheet;
// where that strip is too short for the card, a one-line card (the name and how many are in the yard); shorter still, no card (the amount panel
// already names the part). It never covers the top bar, the inventory or the big buttons.
function showCard(b,sticky=false){const card=document.querySelector('[data-gm-card]'),s=G.ctx?.state;if(!card||!s)return;const id=b.dataset.gmSlot,p=products(s).find(x=>x.id===id);if(!p)return;G.hoverId=id;G.cardTight=false;
 card.innerHTML=cardHTML(s,p);card.__h=null;card.hidden=false;card.classList.remove('tight');card.classList.toggle('sticky',sticky);const r=b.getBoundingClientRect(),dock=document.querySelector('[data-gm-win]')?.getBoundingClientRect(),w=card.offsetWidth;let h=card.offsetHeight,x,y;
 const topBar=document.querySelector('.gm-top')?.getBoundingClientRect(),top=(topBar?.bottom??0)+6;
 if(phone()||!dock){const bar=document.querySelector('.gm-bar')?.getBoundingClientRect(),bottom=Math.min(dock&&dock.height?dock.top:r.top,bar&&bar.height?bar.top:innerHeight)-6;
  if(h>bottom-top){G.cardTight=true;card.innerHTML=cardTight(s,p);card.classList.add('tight');h=card.offsetHeight;}
  if(h>bottom-top){hideCard();return;}
  x=Math.max(8,Math.min(innerWidth-card.offsetWidth-8,r.left+r.width/2-card.offsetWidth/2));y=bottom-h;}
 else{x=dock.left-w-12;y=r.top-10;if(x<8)x=Math.min(innerWidth-w-8,dock.right+12);if(y+h>innerHeight-8)y=innerHeight-h-8;if(y<top)y=top;}
 card.style.left=Math.round(x)+'px';card.style.top=Math.round(y)+'px';}
// The one-line card for a short strip of map on a phone.
export function cardTight(s,p){const q=rowsAt(s,yardOf(s)?.id).get(p.id)?.quantity??0;return '<div class="gm-card-line"><b>'+esc(p.name)+'</b><span>'+num(q)+' in the yard</span></div>';}
function hideCard(){const card=document.querySelector('[data-gm-card]');if(card&&!card.hidden){card.hidden=true;G.hoverId=null;}}
function syncCard(){if(!G.hoverId)return;const b=document.querySelector('[data-gm-slot="'+CSS.escape(G.hoverId)+'"]');if(!b||!b.getClientRects().length||getComputedStyle(b.closest('.gm-dock')??b).visibility==='hidden'){hideCard();return;}const card=document.querySelector('[data-gm-card]');const s=G.ctx.state,p=products(s).find(x=>x.id===G.hoverId);if(card&&p){const html=G.cardTight?cardTight(s,p):cardHTML(s,p);if(card.__h!==html){card.__h=html;card.innerHTML=html;}}}
export function cardHTML(s,p){const yard=yardOf(s),yr=rowsAt(s,yard?.id).get(p.id),sites=activeSites(s).map(x=>({name:x.name,q:rowsAt(s,x.id).get(p.id)?.quantity??0})).filter(x=>x.q>0),trucks=(s.trucks??[]).map(t=>({name:truckKind(t).toLowerCase(),q:rowsAt(s,t.id).get(p.id)?.quantity??0})).filter(x=>x.q>0);
 const line=(k,v,cls='')=>'<li class="'+cls+'"><span>'+esc(k)+'</span><b>'+num(v)+'</b></li>',len=gaLength(p);
 return '<div class="gm-card-head">'+gaItem(p,'gm-card-pic')+'<div><b>'+esc(p.name)+'</b><small>'+esc([SYS_NAME[p.system]??p.system,p.category].filter(Boolean).join(' · '))+'</small></div></div><ul>'
  +line('In the yard',yr?.quantity??0,'yard')+(yr&&yr.free!==yr.quantity?line('free to send',yr.free??0,'sub'):'')+sites.map(x=>line(x.name,x.q)).join('')+(trucks.length>1?line('On the trucks',trucks.reduce((n,x)=>n+x.q,0)):trucks.map(x=>line('On a '+x.name,x.q)).join(''))+'</ul>'
  +'<p>'+[len&&gaLenTag(p)?'Length '+(Math.round(len*100)/100)+' m':'',p.packQuantity>0?'1 pack = '+num(p.packQuantity)+' pieces':'',p.unitWeight>0?(Math.round(p.unitWeight/100)/10)+' kg each':''].filter(Boolean).join(' · ')+'</p></div>';}
export const __gm={state:()=>G,setMode:(m,site)=>{G.mode=m;if(site)G.site=site;},setTruck:id=>{G.mode='truck';G.truck=id;},head:s=>headHTML(s),setItems:(loc,list)=>{G.items={loc,list,at:Date.now(),busy:false};},pick:(id,q)=>{if(q)G.picks.set(id,q);else G.picks.delete(id);G.sel=id;},gridItems:s=>gridItems(s),hint:s=>hintOf(s),truckWords:(s,t)=>truckWords(s,t),loadWords:(s,p)=>loadWords(s,p),grid:(s)=>{const l=gridItems(s);tabsHTML(s,l);return gridHTML(s,l);},tabs:s=>tabsHTML(s,gridItems(s)),acts:s=>actsHTML(s),amount:s=>amountHTML(s),trips:s=>tripsHTML(s),start:ctx=>startHTML(ctx),office:ctx=>officeHTML(ctx),shell:ctx=>gmShell(ctx),reset:()=>{G.who=null;}};
