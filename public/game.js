// The game board: the main screen. The live world map (yard, sites, roads, trucks) fills the screen; a Factorio-style inventory window sits beside
// it; three big buttons do the three things people do (Send, Bring back, Add stock); one speech-bubble hint at a time; little pops when a truck
// sets off or a delivery lands. Every other page lives behind the Office door. The server does the work (src/domain/game.js); the crew,
// forklifts, trucks and site cranes move by themselves and the owner watches.
// operations.js owns the poll: it calls gmUpdate(ctx) with every new state; this module keeps its own DOM and patches only what changed.
import {esc,num} from './visual.js';
import {ovImg} from './art.js';
import {gaItem,gaTab,GA_TABS,GA_ROW_ORDER,GA_BUTTONS,gaImg,gaKind,gaLenTag,gaSprite,gaYardPad} from './game-art.js';
import {gpStops,gpSnap,gpFill,gpCount} from './game-pick.js';
import {wmShell,wmFocus} from './world.js';
const byName=new Intl.Collator(undefined,{numeric:true}).compare;
const SYS_CLASS={quickstage:'qs','at-pac':'at','tube-clip':'tc'},SYS_NAME={quickstage:'Quickstage','at-pac':'AT-PAC','tube-clip':'Tube & Clip'};
const TARE=50000,HEAVY=10000000;
// ---------------------------------------------------------------- state of the board (per browser tab)
const G={mode:'yard',site:null,truck:null,tab:null,picks:new Map(),sel:null,showAll:false,busy:false,newSite:false,office:false,ctx:null,seen:null,counts:new Map(),bumps:new Set(),cols:10,who:null,hintOff:new Set(),hoverId:null,hoverT:0,pressT:0,flash:null};
const store={get(k){try{return localStorage.getItem(k);}catch{return null;}},set(k,v){try{localStorage.setItem(k,v);}catch{}}};
const hintKey=()=>'gm-hints:'+(G.ctx?.account?.company?.id??'')+':'+(G.ctx?.account?.user?.id??'');
function resetFor(ctx){const who=(ctx.account?.company?.id??'')+'|'+(ctx.account?.user?.id??'');if(who===G.who)return;G.who=who;G.mode='yard';G.site=null;G.truck=null;G.tab=null;G.picks=new Map();G.sel=null;G.newSite=false;G.office=false;G.seen=null;G.counts=new Map();G.ctx=ctx;
 G.hintOff=new Set(String(store.get(hintKey())??'').split(',').filter(Boolean));}
// ---------------------------------------------------------------- reading the state
const yardOf=s=>s?.yards?.[0]??null;
const products=s=>(s?.products??[]).filter(p=>!p.retired);
const rowsAt=(s,loc)=>{const m=new Map();for(const r of s?.stock?.[loc]?.rows??[])m.set(r.product,r);return m;};
const itemsAt=(s,loc)=>s?.game?.items?.[loc]??[];
const activeSites=s=>(s?.sites??[]).filter(x=>x.status==='ACTIVE').sort((a,b)=>byName(a.name,b.name));
const siteName=(s,id)=>(s?.sites??[]).find(x=>x.id===id)?.name??(s?.yards??[]).find(y=>y.id===id)?.name??'the site';
const perStillage=p=>p?.packQuantity>0?p.packQuantity:p?.unitWeight>0?Math.max(1,Math.floor((1500000-TARE)/p.unitWeight)):null;
// What the grid shows in each mode: [{p, count, dim}] (count = the corner number).
function gridItems(s){const all=products(s),yard=yardOf(s),mode=G.mode;
 if(mode==='add'){const at=rowsAt(s,yard?.id);return all.map(p=>({p,count:at.get(p.id)?.quantity??0,quiet:true}));}
 if(mode==='send'){const at=rowsAt(s,yard?.id);return all.map(p=>({p,count:at.get(p.id)?.free??0})).filter(x=>x.count>0||G.picks.has(x.p.id));}
 if(mode==='back'||mode==='site'){const at=rowsAt(s,G.site);return all.map(p=>({p,count:at.get(p.id)?.quantity??0})).filter(x=>x.count>0||G.picks.has(x.p.id));}
 if(mode==='truck'){const at=rowsAt(s,G.truck);return all.map(p=>({p,count:at.get(p.id)?.quantity??0})).filter(x=>x.count>0);}
 const at=rowsAt(s,yard?.id);return all.map(p=>{const q=at.get(p.id)?.quantity??0;return {p,count:q,dim:!q};}).filter(x=>G.showAll||x.count>0);}
// The slider's stops for one product: whole stillages at the place (Send: the yard; Bring back: the site); Add stock: whole packs, or stillages a forklift lifts.
function stopsFor(s,p){if(G.mode==='add'){const step=perStillage(p)??10,out=[];for(let k=1;k<=40;k++)out.push({qty:k*step,n:k});return out;}
 const loc=G.mode==='send'?yardOf(s)?.id:G.site;return gpStops(itemsAt(s,loc),p.id).map((x,i)=>({qty:x.qty,n:i+1}));}
const unitWord=(p,n)=>G.mode==='add'&&p?.packQuantity>0?(n===1?'pack':'packs'):(n===1?'stillage':'stillages');
// ---------------------------------------------------------------- the skeleton
export function gmShell(ctx){resetFor(ctx);G.ctx=ctx;const s=ctx.state,company=esc(ctx.account?.company?.name??'Your company');
 const top='<header class="gm-top"><div class="gm-brand"><span class="gm-mark" aria-hidden="true">'+gaImg(GA_BUTTONS.stock(),'gm-mark-img')+'</span><b>'+company+'</b></div>'
  +'<div class="gm-top-right"><button type="button" class="gm-office-btn" data-gm-office aria-haspopup="dialog" aria-expanded="false">'+gaImg(GA_BUTTONS.office(),'gm-office-img')+'<span>Office</span></button></div></header>';
 if(!yardOf(s))return '<div class="gm" data-gm="start">'+top+startHTML(ctx)+officeHTML(ctx)+'</div>';
 return '<div class="gm" data-gm="board">'+top+'<div class="gm-body"><section class="gm-board scene world-scene" aria-label="Your yard and sites">'+wmShell()
  +'<div class="gm-hint" data-gm-hint></div><div class="gm-pops" data-gm-pops role="status" aria-live="polite"></div><div class="gm-fleet" data-gm-fleet></div>'
  +'<div class="gm-view-btns"><button type="button" class="gm-round" data-gm-cam="fit" title="See everything" aria-label="See the whole map">'+viewIcon()+'</button></div>'
  +'<nav class="gm-bar" aria-label="What do you want to do?">'+bigBtn('send','Send','Send scaffolding to a site')+bigBtn('back','Bring back','Bring scaffolding back from a site')+bigBtn('add','Add stock','Add stock arriving at the yard')+bigBtn('stock','Stock','See the yard stock',' gm-phone-only')+'</nav></section>'
  +'<aside class="gm-dock" data-gm-dock aria-label="Inventory"><div class="gm-win" data-gm-win><div data-gm-head></div><div class="gm-tabs" data-gm-tabs role="tablist" aria-label="Kinds of material"></div><div class="gm-grid-wrap" data-gm-grid></div><div data-gm-amt></div><div data-gm-acts></div></div><div class="gm-hint-dock" data-gm-hint2></div></aside></div>'
  +'<div class="gm-card" data-gm-card hidden></div>'+officeHTML(ctx)+'</div>';}
const bigBtn=(k,label,title,cls='')=>'<button type="button" class="gm-big gm-big-'+k+cls+'" data-gm-go="'+k+'" title="'+title+'"><span class="gm-big-pic">'+gaImg(GA_BUTTONS[k](),'gm-big-img')+'</span><span class="gm-big-label">'+label+'</span></button>';
const viewIcon=()=>'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// ---------------------------------------------------------------- first run: the yard size
function startHTML(ctx){const ops=ctx.account?.permissions?.includes('operations.manage');
 const tile=(k,name,words,m)=>'<button type="button" class="gm-size" data-gm-size="'+k+'"><span class="gm-size-pic">'+gaYardPad(k,'gm-size-img')+'</span><b>'+name+'</b><small>'+words+'</small><em>'+m+'</em></button>';
 return '<div class="gm-start"><div class="gm-start-in"><p class="gm-start-kicker">Welcome, '+esc(ctx.account?.user?.name??'')+'</p><h1>How big is your yard?</h1><p class="gm-start-sub">Pick the closest. You can change the shape later.</p>'
  +(ops?'<div class="gm-sizes">'+tile('S','Small','A few stacks of stillages','about 20 × 16 m')+tile('M','Medium','Room for a busy yard','about 30 × 20 m')+tile('L','Large','A big depot','about 40 × 25 m')+'</div><button type="button" class="gm-link" data-gm-draw>Draw my own shape instead</button>':'<p class="gm-start-sub">The owner sets up the yard first.</p>')+'</div></div>';}
// ---------------------------------------------------------------- the Office: a drawer of big picture tiles for every other page
export const OFFICE_TILES=[['TODAY','Today','Loads due today, on a phone too','sg-list'],['SCHEDULE','Schedule','Every load and collection by day','hr-board'],['HOME','Control room','Crew orders, fleet, the full stock grids','spr-worker-busy'],['OVERVIEW','Overview','The whole business at a glance','spr-forklift-load'],['WORKERS','Workers','Your crew and their jobs','spr-worker'],['EQUIPMENT','Equipment','Forklifts, cranes and trucks','spr-forklift'],['TRUCK12','Truck 12.5 tonne','12.5 t trucks, decks and dockets','spr-truck12'],['TRUCK2','Truck 2 tonne','2 t trucks for quick runs','spr-truck2'],['STOCK','Stock','Every piece in and out, counts','spr-stillage'],['MATERIALS','Materials list','Your parts, weights and packs','spr-bundle'],['SITES','Client sites','Sites, their plans and dockets','si-site'],['HIRE','Hire','What is out on hire, and rates','hr-tag'],['REPORTS','Reports','History charts','hc-board'],['YARD','Yard (layout plan)','Yard shape, stillages, planner','sg-yard']];
export function officeHTML(ctx){const hire=ctx.hire!==false,s=ctx.state,ops=ctx.account?.permissions?.includes('operations.manage');
 const tiles=OFFICE_TILES.filter(([v])=>(v!=='HIRE'||hire)&&(ops||!['HOME'].includes(v))).map(([v,label,sub,art])=>'<button type="button" class="gm-tile'+(ctx.view===v?' current':'')+'" data-view="'+v+'"'+(ctx.view===v?' aria-current="page"':'')+' aria-label="'+esc(label)+'"><span class="gm-tile-pic">'+gaSprite(art,'gm-tile-img')+'</span><b>'+esc(label==='Truck 12.5 tonne'?'Big trucks':label==='Truck 2 tonne'?'Small trucks':label==='Yard (layout plan)'?'Yard layout':label==='Materials list'?'Materials catalogue':label==='Stock'?'Stock ledger':label)+'</b><small>'+esc(sub)+'</small></button>').join('')
  +'<button type="button" class="gm-tile" id="settings" aria-label="Account"><span class="gm-tile-pic">'+gaImg(GA_BUTTONS.office(),'gm-tile-img')+'</span><b>Account</b><small>Company, team, logo, backups</small></button>';
 return '<div class="gm-office" data-gm-office-panel hidden><div class="gm-office-in" role="dialog" aria-modal="false" aria-labelledby="gm-office-h"><div class="gm-office-head"><h2 id="gm-office-h">Office</h2><p>Everything else lives here.'+(s&&yardOf(s)&&ops?' The yard keeps working while you look.':'')+'</p><button type="button" class="gm-x" data-gm-office-x aria-label="Close the office">&times;</button></div><nav class="gm-tiles" aria-label="Main navigation">'+tiles+'</nav></div></div>';}
// Opening and closing the Office drawer (also used on the Office pages by operations.js).
export function gmOfficeToggle(open){const panel=document.querySelector('[data-gm-office-panel]');if(!panel)return;G.office=open??panel.hidden;panel.hidden=!G.office;for(const b of document.querySelectorAll('[data-gm-office]'))b.setAttribute('aria-expanded',String(G.office));if(G.office)panel.querySelector('.gm-tile')?.focus({preventScroll:true});}
// ---------------------------------------------------------------- the inventory window
function headHTML(s){const sites=activeSites(s),site=sites.find(x=>x.id===G.site);let title='Yard stock',sub='',extra='';
 if(G.mode==='send'){title='Send to a site';sub=site?'Pick what goes to <b>'+esc(site.name)+'</b>':'Where to?';}
 else if(G.mode==='back'){title='Bring back';sub=site?'Pick what comes back from <b>'+esc(site.name)+'</b>, or everything':'From which site?';}
 else if(G.mode==='add'){title='Add stock to the yard';sub='Tap what arrived';}
 else if(G.mode==='site'){title=site?.name??'Site';sub=site?.address&&site.address!=='Demonstration site'?esc(site.address):'On site now';}
 else if(G.mode==='truck'){const t=(s.trucks??[]).find(x=>x.id===G.truck);title=t?.name??'Truck';sub=t?esc(truckWords(s,t).word):'';}
 else sub=products(s).length?'Everything in your yard':'';
 const x=G.mode==='yard'?'':'<button type="button" class="gm-x" data-gm-close aria-label="Close">&times;</button>';
 if(G.mode==='yard'&&products(s).length)extra='<button type="button" class="gm-chip'+(G.showAll?' on':'')+'" data-gm-all aria-pressed="'+G.showAll+'">'+(G.showAll?'Only what I have':'Show every part')+'</button>';
 let h='<div class="gm-win-head"><div><h2>'+esc(title)+'</h2>'+(sub?'<p>'+sub+'</p>':'')+'</div>'+extra+x+'</div>';
 if(G.mode==='send'||G.mode==='back'){const list=G.mode==='back'?sites:sites;
  h+='<div class="gm-sites" role="radiogroup" aria-label="Site">'+list.map(x=>{const has=(s.stock?.[x.id]?.pieces??0)>0;return '<button type="button" role="radio" aria-checked="'+(x.id===G.site)+'" class="gm-site'+(x.id===G.site?' on':'')+(G.mode==='back'&&!has?' dim':'')+'" data-gm-site="'+esc(x.id)+'">'+gaSprite('si-site','gm-site-img')+'<span>'+esc(x.name)+'</span></button>';}).join('')
   +(G.mode==='send'?'<button type="button" class="gm-site gm-site-new'+(G.newSite?' on':'')+'" data-gm-newsite aria-expanded="'+G.newSite+'"><span class="gm-plus" aria-hidden="true">+</span><span>New site</span></button>':'')+'</div>';
  if(G.mode==='send'&&G.newSite)h+='<form class="gm-newsite" data-gm-newsite-form><input name="name" required maxlength="120" placeholder="Site name, e.g. George St" aria-label="Site name" autocomplete="off"><input name="address" maxlength="200" placeholder="Address (you can skip this)" aria-label="Address" autocomplete="off"><button type="submit" class="gm-go">Add site</button></form>';
  if(!list.length&&!G.newSite)h+='<p class="gm-empty-line">'+(G.mode==='send'?'No sites yet. Tap <b>+ New site</b>.':'No sites yet.')+'</p>';}
 return h;}
function tabsHTML(s,list){const has=new Map();for(const x of list)has.set(gaTab(x.p),(has.get(gaTab(x.p))??0)+1);if(list.length)has.set('all',list.length);
 // All is where a short list lives (the yard at a glance, a site, a truck); a long one (the whole catalogue in Add stock) opens on its first kind
 if(!G.tab||!has.has(G.tab))G.tab=list.length&&list.length<=50?'all':GA_TABS.find(t=>t.id!=='all'&&has.has(t.id))?.id??'all';
 return GA_TABS.map(t=>'<button type="button" role="tab" class="gm-tab'+(t.id===G.tab?' on':'')+(has.has(t.id)?'':' dim')+'" data-gm-tab="'+t.id+'" aria-selected="'+(t.id===G.tab)+'" title="'+t.name+'">'+t.pic()+'<span>'+t.name+'</span></button>').join('');}
function gridHTML(s,list){const systems=new Set(list.map(x=>x.p.system)),many=systems.size>1,cols=G.cols;
 if(!products(s).length)return '<div class="gm-empty"><p><b>Your shelves are empty.</b> Load your scaffold parts to start.</p><button type="button" class="gm-go" data-gm-parts>Load my parts list</button><small>The supplier lists you gave us, for the systems you use. Or import your own list in the Office.</small></div>';
 const all=G.tab==='all',here=all?list:list.filter(x=>gaTab(x.p)===G.tab),TAB_ORDER=GA_TABS.map(t=>t.id);
 if(!here.length){const words=G.mode==='send'?'Nothing to send from the yard yet. Add stock first.':G.mode==='back'||G.mode==='site'?(G.site?'Nothing on this site.':'Pick a site.'):G.mode==='truck'?'Nothing on board.':'Nothing here yet. Tap Add stock.';return '<div class="gm-grid" data-cols="'+cols+'">'+voids(cols*3)+'</div><p class="gm-empty-line">'+words+'</p>';}
 const sortIn=(a,b)=>GA_ROW_ORDER.indexOf(gaKind(a.p))-GA_ROW_ORDER.indexOf(gaKind(b.p))||byName(a.p.system??'',b.p.system??'')||((a.p.length??0)-(b.p.length??0))||byName(a.p.name,b.p.name);let html='',rows=0;
 // All: one packed grid, kind after kind (like a game inventory); a kind tab: a row per kind of part (like a request window)
 if(all){const g=[...here].sort((a,b)=>TAB_ORDER.indexOf(gaTab(a.p))-TAB_ORDER.indexOf(gaTab(b.p))||sortIn(a,b));html=g.map(x=>slotHTML(x,many)).join('')+voids((cols-g.length%cols)%cols);rows=Math.ceil(g.length/cols);}
 else{const groups=new Map();for(const x of here){const k=gaKind(x.p);let g=groups.get(k);if(!g)groups.set(k,g=[]);g.push(x);}
  for(const k of [...groups.keys()].sort((a,b)=>GA_ROW_ORDER.indexOf(a)-GA_ROW_ORDER.indexOf(b))){const g=groups.get(k).sort(sortIn);html+=g.map(x=>slotHTML(x,many)).join('')+voids((cols-g.length%cols)%cols);rows+=Math.ceil(g.length/cols);}}
 if(rows<3)html+=voids((3-rows)*cols);
 return '<div class="gm-grid" data-cols="'+cols+'" role="list">'+html+'</div>';}
const voids=n=>'<span class="gm-slot gm-void" aria-hidden="true"></span>'.repeat(Math.max(0,n));
function slotHTML(x,many){const p=x.p,pick=G.picks.get(p.id),where=G.mode==='send'||G.mode==='add'||G.mode==='yard'?'in the yard':G.mode==='truck'?'on board':'on site',tag=gaLenTag(p);
 const label=p.name+': '+num(x.count)+' '+where+(pick?', '+num(pick)+' picked':'');
 return '<button type="button" role="listitem" class="gm-slot'+(x.dim?' dim':'')+(pick?' picked':'')+(G.sel===p.id?' sel':'')+(G.bumps.has(p.id)?' bump':'')+'" data-gm-slot="'+esc(p.id)+'" aria-label="'+esc(label)+'">'+gaItem(p)
  +(tag?'<i class="gm-len">'+esc(tag)+'</i>':'')+(many?'<s class="gm-sys '+(SYS_CLASS[p.system]??'')+'"></s>':'')+(x.count||!(x.dim||x.quiet)?'<b class="gm-n">'+gpCount(x.count)+'</b>':'')+(pick?'<em class="gm-pick">'+gpCount(pick)+'</em>':'')+'</button>';}
function amountHTML(s){if(!G.sel||!['send','back','add'].includes(G.mode))return '';const p=products(s).find(x=>x.id===G.sel);if(!p)return '';
 const stops=stopsFor(s,p),q=G.picks.get(p.id)??0,i=stops.findIndex(x=>x.qty===q),idx=i<0?(q?stops.filter(x=>x.qty<q).length:0):i+1,n=idx;
 const max=stops.length,words=q?(G.mode==='add'&&!(p.packQuantity>0)&&!(p.unitWeight>0)?num(q)+' pieces':n+' '+unitWord(p,n)):'None yet';
 return '<div class="gm-amt"><div class="gm-amt-top">'+gaItem(p,'gm-amt-pic')+'<div class="gm-amt-name"><b>'+esc(p.name)+'</b><small data-gm-words>'+esc(words)+'</small></div><button type="button" class="gm-chip" data-gm-unpick>Remove</button></div>'
  +(max?'<div class="gm-amt-row"><button type="button" class="gm-step" data-gm-step="-1" aria-label="Less">&minus;</button><input type="range" class="gm-range" data-gm-live data-gm-range min="0" max="'+max+'" step="1" value="'+idx+'" aria-label="How many of '+esc(p.name)+'"><button type="button" class="gm-step" data-gm-step="1" aria-label="More">+</button><input type="number" class="gm-num" data-gm-live data-gm-num min="0" step="1" value="'+q+'" inputmode="numeric" aria-label="Amount of '+esc(p.name)+'"></div>':'<p class="gm-empty-line">None of this can be moved right now.</p>')+'</div>';}
function actsHTML(s){const site=activeSites(s).find(x=>x.id===G.site),picks=[...G.picks].filter(([,q])=>q>0);
 if(G.mode==='send'){const est=loadWords(s,picks),ok=!!site&&picks.length>0&&!G.busy;
  return '<div class="gm-acts">'+(picks.length?'<p class="gm-est">'+esc(est)+'</p>':'')+'<button type="button" class="gm-go gm-go-big" data-gm-do="send"'+(ok?'':' disabled')+'>'+gaImg(GA_BUTTONS.send(),'gm-go-img')+(site?'Send to '+esc(site.name):'Send')+'</button></div>';}
 if(G.mode==='back'){const has=site&&(s.stock?.[site.id]?.pieces??0)>0;return '<div class="gm-acts">'+(picks.length?'<button type="button" class="gm-go gm-go-big" data-gm-do="back"'+(G.busy?' disabled':'')+'>'+gaImg(GA_BUTTONS.back(),'gm-go-img')+'Bring these back</button>':'')+'<button type="button" class="gm-go'+(picks.length?' gm-go-alt':' gm-go-big')+'" data-gm-do="backall"'+(has&&!G.busy?'':' disabled')+'>'+(picks.length?'':gaImg(GA_BUTTONS.back(),'gm-go-img'))+'Bring everything back</button></div>';}
 if(G.mode==='add')return '<div class="gm-acts"><button type="button" class="gm-go gm-go-big" data-gm-do="add"'+(picks.length&&!G.busy?'':' disabled')+'>'+gaImg(GA_BUTTONS.add(),'gm-go-img')+'Add to the yard</button></div>';
 if(G.mode==='site')return '<div class="gm-acts gm-acts-2"><button type="button" class="gm-go" data-gm-go="send" data-gm-for="'+esc(G.site)+'">'+gaImg(GA_BUTTONS.send(),'gm-go-img')+'Send here</button><button type="button" class="gm-go gm-go-alt" data-gm-go="back" data-gm-for="'+esc(G.site)+'"'+((s.stock?.[G.site]?.pieces??0)>0?'':' disabled')+'>'+gaImg(GA_BUTTONS.back(),'gm-go-img')+'Bring back</button></div>';
 if(G.mode==='truck'){const t=(s.trucks??[]).find(x=>x.id===G.truck);if(!t)return '';return '<div class="gm-acts gm-acts-2"><button type="button" class="gm-go" data-gm-cam="truck" data-gm-for="'+esc(t.id)+'">Follow it</button><button type="button" class="gm-go gm-go-alt" data-view="'+(t.payload>=HEAVY?'TRUCK12':'TRUCK2')+'">Truck page</button></div>';}
 return '';}
// Words for how full the trucks will be: the picked pieces' weight plus a stillage each, against a 12.5 t truck.
function loadWords(s,picks){const ps=new Map(products(s).map(p=>[p.id,p]));let g=0,known=true,n=0;for(const [id,q] of picks){const p=ps.get(id);if(!(p?.unitWeight>0)){known=false;continue;}g+=p.unitWeight*q;const per=perStillage(p);n+=per?Math.ceil(q/per):1;}g+=n*TARE;
 if(!known&&!g)return 'Weight not known for this part';const t=g/12500000;if(t>1)return 'About '+Math.ceil(t)+' truckloads';return 'Fills a truck: '+gpFill(t).toLowerCase();}
// ---------------------------------------------------------------- trucks along the bottom: a picture, the name, a word and a fill bar
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
function fleetHTML(s){const list=(s.trucks??[]).filter(t=>!t.retired).sort((a,b)=>byName(a.name,b.name));if(!list.length)return '';
 return list.map(t=>{const w=truckWords(s,t);return '<button type="button" class="gm-truck '+w.state+(G.truck===t.id&&G.mode==='truck'?' on':'')+'" data-gm-truck="'+esc(t.id)+'" title="'+esc(t.name+': '+w.word+' · '+w.load)+'">'+ovImg(t.payload>=HEAVY?'spr-truck12':'spr-truck2','gm-truck-img')+'<span class="gm-truck-t"><b>'+esc(t.name)+'</b><small>'+esc(w.word)+'</small></span><i class="gm-fill" aria-label="'+esc(w.load)+'"><b data-style="width:'+Math.round(w.fill*100)+'%"></b></i></button>';}).join('');}
// ---------------------------------------------------------------- hints: one at a time, game-tutorial style, each dismissable for good
function hintOf(s){const stuck=(s.trucks??[]).find(t=>t.game?.problem);if(stuck)return {id:'',text:stuck.name+' is waiting'+(stuck.status==='AT_SITE'?' at '+siteName(s,stuck.at):'')+': '+stuck.game.problem,warn:true};
 // the crew cannot finish a lift for a truck on a trip: say why, and where to sort it out
 const blocked=(s.tasks??[]).find(x=>x.state==='BLOCKED'&&(s.trucks??[]).some(t=>t.game&&(x.to===t.id||x.from===t.id)));if(blocked)return {id:'',text:'The crew is stuck: '+(blocked.reason??'a lift cannot be finished')+' Open the Office, Control room, to sort it out.',warn:true};
 const yard=yardOf(s),stockHere=(s.stock?.[yard?.id]?.pieces??0)>0,sites=activeSites(s),delivered=(s.sites??[]).some(x=>x.lastDeliveryAt),moving=(s.trucks??[]).some(t=>t.game);
 const all=[];
 if(!products(s).length)all.push({id:'parts',text:'Your shelves are empty. Load your scaffold parts list to get started.',act:['Load my parts list','parts']});
 else if(!stockHere)all.push({id:'add',text:'Tap Add stock to fill your yard with scaffolding.',point:'add'});
 else if(!sites.length)all.push({id:'site',text:'Add your first client site: tap Send, then New site.',point:'send'});
 else if(moving&&!delivered)all.push({id:'watch',text:'Sit back and watch: the crew loads the truck, it drives there, and the site crane unloads it.'});
 else if(!delivered)all.push({id:'send',text:'Tap Send to send scaffolding to '+sites[0].name+'. The crew does the rest.',point:'send'});
 else all.push({id:'tapsite',text:'Tap a site on the map to see what is there. Bring back brings it home.',point:'back'});
 return all.find(h=>!G.hintOff.has(h.id))??null;}
function hintHTML(s){const h=hintOf(s);if(!h)return '';return '<div class="gm-bubble'+(h.warn?' warn':'')+(h.point?' point-'+h.point:'')+'" data-hint="'+esc(h.id)+'">'+ovImg('spr-worker','gm-boss')+'<p>'+esc(h.text)+'</p>'+(h.act?'<button type="button" class="gm-go" data-gm-hint-act="'+h.act[1]+'">'+esc(h.act[0])+'</button>':'')+(h.id?'<button type="button" class="gm-x" data-gm-hint-x aria-label="Hide this tip">&times;</button>':'')+'</div>';}
// ---------------------------------------------------------------- pops: a truck sets off, a delivery lands, a collection is home
const POPS={'Delivered':'tick','Back at the yard':'tick','Truck departed':'go','Collection returned':null};
function pops(s){const list=s.notifications??[],ids=list.map(n=>n.id);if(G.seen===null){G.seen=new Set(ids);return;}for(const n of list){if(G.seen.has(n.id))continue;G.seen.add(n.id);const kind=POPS[n.title];if(!kind)continue;
  let text=n.body;if(n.title==='Delivered')text=n.body.split('!')[0]+'!';else if(n.title==='Back at the yard')text=n.body.replace(/ and everything is unloaded\.?$/,'')+'!';else if(n.title==='Truck departed'){const m=n.body.match(/^(.*) is travelling to (.*)\.$/);if(m&&(s.yards??[]).some(y=>y.name===m[2]))continue;text=m?m[1]+' is on its way to '+m[2]:n.body;}
  pop(text,kind);}}
export function pop(text,kind='tick'){const box=document.querySelector('[data-gm-pops]');if(!box)return;const el=document.createElement('div');el.className='gm-pop '+kind;el.innerHTML=(kind==='tick'?'<span class="gm-tick" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>':kind==='go'?'<span class="gm-go-dot" aria-hidden="true"></span>':'')+'<span>'+esc(text)+'</span>';
 box.append(el);while(box.children.length>3)box.firstElementChild.remove();setTimeout(()=>{el.classList.add('out');setTimeout(()=>el.remove(),600);},kind==='tick'?4200:3000);}
// ---------------------------------------------------------------- update (every poll) and patching
const setHTML=(el,html)=>{if(!el)return false;if(el.__h===html)return false;el.__h=html;el.innerHTML=html;return true;};
function measureCols(){const phone=typeof matchMedia==='function'&&matchMedia('(max-width:760px)').matches;if(!phone)return 10;const w=(typeof innerWidth==='number'?innerWidth:375)-28;return Math.max(5,Math.min(9,Math.floor((w+4)/48)));}
export function gmUpdate(ctx){G.ctx=ctx;resetFor(ctx);const root=document.querySelector('[data-gm]');if(!root)return;const s=ctx.state;if(root.dataset.gm==='start'){bindOnce(root);return;}
 ctx.wm?.();G.cols=measureCols();
 // keep the picks honest: what is no longer there cannot stay picked
 if(G.site&&!activeSites(s).some(x=>x.id===G.site)){G.site=null;if(['site','back'].includes(G.mode))G.mode='yard';}
 if(G.mode==='truck'&&!(s.trucks??[]).some(t=>t.id===G.truck&&!t.retired))G.mode='yard';
 const list=gridItems(s),counts=new Map(list.map(x=>[x.p.id,x.count]));if(G.mode==='yard'||G.mode==='add'){for(const [id,n] of counts){const was=G.counts.get(id);if(was!=null&&n>was)bumpSoon(id);}G.counts=counts;}
 const win=root.querySelector('[data-gm-win]');if(win)win.className='gm-win mode-'+G.mode;
 setHTML(root.querySelector('[data-gm-head]'),headHTML(s));setHTML(root.querySelector('[data-gm-tabs]'),tabsHTML(s,list));
 const grid=root.querySelector('[data-gm-grid]');const top=grid?.scrollTop??0;if(setHTML(grid,gridHTML(s,list))&&grid)grid.scrollTop=top;
 const amt=root.querySelector('[data-gm-amt]');if(!amt?.contains(document.activeElement)||!document.activeElement?.matches('input'))setHTML(amt,amountHTML(s));
 setHTML(root.querySelector('[data-gm-acts]'),actsHTML(s));setHTML(root.querySelector('[data-gm-fleet]'),fleetHTML(s));const hint=hintHTML(s);setHTML(root.querySelector('[data-gm-hint]'),hint);setHTML(root.querySelector('[data-gm-hint2]'),hint);const hp=G.mode==='yard'?hintOf(s)?.point:null;
 root.querySelector('.gm-body')?.classList.toggle('dock-open',G.mode!=='yard');
 for(const b of root.querySelectorAll('.gm-bar [data-gm-go]')){b.classList.toggle('hinted',b.dataset.gmGo===hp);b.classList.toggle('on',b.dataset.gmGo===G.mode||(b.dataset.gmGo==='stock'&&G.mode==='yard'&&root.querySelector('.gm-body')?.classList.contains('sheet')));}
 pops(s);bindOnce(root);syncCard();}
function bumpSoon(id){G.bumps.add(id);setTimeout(()=>{G.bumps.delete(id);document.querySelector('[data-gm-slot="'+CSS.escape(id)+'"]')?.classList.remove('bump');},900);}
// The site the map lights up.
export const gmGlow=()=>['send','back','site'].includes(G.mode)?G.site:null;
// A click on the map (world.js ctx.onPick): a site opens its inventory (or becomes the Send / Bring back target), a truck its own.
export function gmPick(kind,id){const ctx=G.ctx;if(!ctx)return false;if(kind==='site'){if(G.mode==='send'||G.mode==='back'){G.site=id;G.picks=new Map();G.sel=null;}else{G.mode='site';G.site=id;G.picks=new Map();G.sel=null;}openSheet();refreshNow();return true;}
 if(kind==='truck'){G.mode='truck';G.truck=id;G.sel=null;openSheet();refreshNow();wmFocus('truck',id);return true;}return false;}
const refreshNow=()=>{if(G.ctx)gmUpdate(G.ctx);};
const openSheet=()=>document.querySelector('.gm-body')?.classList.add('sheet');
function setMode(mode,site){hideCard();G.mode=mode;G.picks=new Map();G.sel=null;G.newSite=false;G.busy=false;const s=G.ctx.state,sites=activeSites(s);
 if(site)G.site=site;else if(mode==='send'){if(!sites.some(x=>x.id===G.site))G.site=sites.length===1?sites[0].id:(sites[0]?.id??null);if(!sites.length)G.newSite=true;}
 else if(mode==='back'){const withStock=sites.filter(x=>(s.stock?.[x.id]?.pieces??0)>0);if(!withStock.some(x=>x.id===G.site))G.site=withStock[0]?.id??sites[0]?.id??null;}
 if(mode==='yard')document.querySelector('.gm-body')?.classList.remove('sheet');else openSheet();
 G.tab=null;refreshNow();if(G.site&&(mode==='send'||mode==='back'))wmFocus('site',G.site);}
// ---------------------------------------------------------------- events (one delegated set per board)
function bindOnce(root){if(root.__gmBound)return;root.__gmBound=true;
 root.addEventListener('click',onClick);root.addEventListener('input',onInput);root.addEventListener('change',onChange);root.addEventListener('submit',onSubmit);
 root.addEventListener('pointerover',onOver);root.addEventListener('pointerout',onOut);root.addEventListener('pointerdown',onDown);root.addEventListener('pointerup',()=>clearTimeout(G.pressT));root.addEventListener('pointercancel',()=>clearTimeout(G.pressT));
 root.addEventListener('focusin',e=>{const b=e.target.closest?.('[data-gm-slot]');if(b&&b.matches(':focus-visible'))showCard(b);});root.addEventListener('focusout',()=>hideCard());
 if(!G.keys){G.keys=true;document.addEventListener('keydown',e=>{if(e.key!=='Escape'||!document.querySelector('[data-gm]'))return;if(G.office){gmOfficeToggle(false);return;}if(!document.querySelector('[data-gm-card]')?.hidden){hideCard();return;}if(G.mode!=='yard')setMode('yard');});
  addEventListener('resize',()=>{if(document.querySelector('[data-gm="board"]')&&measureCols()!==G.cols)refreshNow();});}}
async function run(action,data,ok){const ctx=G.ctx;if(G.busy)return null;G.busy=true;refreshNow();try{const r=await ctx.cmd(action,data);if(ok)ok(r);await ctx.refresh();return r;}catch(e){ctx.notify(e.message);return null;}finally{G.busy=false;refreshNow();}}
function onClick(e){const ctx=G.ctx,s=ctx?.state;if(!ctx)return;const t=e.target;const b=t.closest('button');if(!b)return;
 if(b.dataset.view){e.preventDefault();gmOfficeToggle(false);ctx.go(b.dataset.view);return;}
 if(b.id==='settings'){gmOfficeToggle(false);ctx.settings?.();return;}
 if(b.hasAttribute('data-gm-office')){gmOfficeToggle();return;}if(b.hasAttribute('data-gm-office-x')){gmOfficeToggle(false);return;}
 if(b.dataset.gmSize){run('gameStart',{size:b.dataset.gmSize},r=>setTimeout(()=>pop(r.message,'tick'),900));return;}
 if(b.hasAttribute('data-gm-draw')){ctx.go('YARD');return;}
 if(b.dataset.gmGo){const k=b.dataset.gmGo;if(k==='stock'){if(G.mode==='yard'&&document.querySelector('.gm-body')?.classList.contains('sheet'))document.querySelector('.gm-body').classList.remove('sheet');else setMode('yard'),openSheet();refreshNow();return;}if(G.mode===k&&!b.dataset.gmFor){setMode('yard');return;}setMode(k,b.dataset.gmFor);return;}
 if(b.hasAttribute('data-gm-close')){setMode('yard');return;}
 if(b.dataset.gmCam){if(b.dataset.gmCam==='truck')wmFocus('truck',b.dataset.gmFor);else wmFocus('fit');return;}
 if(b.hasAttribute('data-gm-all')){G.showAll=!G.showAll;refreshNow();return;}
 if(b.dataset.gmTab){G.tab=b.dataset.gmTab;refreshNow();const g=document.querySelector('[data-gm-grid]');if(g)g.scrollTop=0;return;}
 if(b.dataset.gmSite){G.site=b.dataset.gmSite;G.picks=new Map();G.sel=null;G.newSite=false;refreshNow();wmFocus('site',G.site);return;}
 if(b.hasAttribute('data-gm-newsite')){G.newSite=!G.newSite;refreshNow();if(G.newSite)document.querySelector('[data-gm-newsite-form] input')?.focus();return;}
 if(b.dataset.gmTruck){if(G.mode==='truck'&&G.truck===b.dataset.gmTruck){setMode('yard');return;}gmPick('truck',b.dataset.gmTruck);return;}
 if(b.dataset.gmSlot){hideCard();const id=b.dataset.gmSlot;if(!['send','back','add'].includes(G.mode)){showCard(b,true);return;}
  if(G.sel===id){refreshNow();return;}G.sel=id;if(!G.picks.get(id)){const p=products(s).find(x=>x.id===id),first=stopsFor(s,p)[0];if(first)G.picks.set(id,first.qty);}refreshNow();return;}
 if(b.hasAttribute('data-gm-unpick')){G.picks.delete(G.sel);G.sel=null;refreshNow();return;}
 if(b.dataset.gmStep){const p=products(s).find(x=>x.id===G.sel);if(!p)return;const stops=stopsFor(s,p),q=G.picks.get(p.id)??0,i=stops.findIndex(x=>x.qty===q);let k=(i<0?stops.filter(x=>x.qty<q).length-1:i)+Number(b.dataset.gmStep);k=Math.max(-1,Math.min(stops.length-1,k));if(k<0)G.picks.delete(p.id);else G.picks.set(p.id,stops[k].qty);refreshNow();return;}
 if(b.dataset.gmHintAct==='parts'||b.hasAttribute('data-gm-parts')){run('gameCatalogue',{},r=>{pop(r.message,'tick');});return;}
 if(b.hasAttribute('data-gm-hint-x')){const id=b.closest('[data-hint]')?.dataset.hint;if(id){G.hintOff.add(id);store.set(hintKey(),[...G.hintOff].join(','));}refreshNow();return;}
 if(b.dataset.gmDo){const lines=[...G.picks].filter(([,q])=>q>0).map(([product,quantity])=>({product,quantity}));const site=G.site,name=siteName(s,site);
  if(b.dataset.gmDo==='send')run('gameSend',{site,lines},r=>{pop(r.trucks.map(t=>t.name).join(' and ')+' is loading for '+name,'go');if(r.left?.length)ctx.notify(r.message);setMode('yard');wmFocus('director');});
  else if(b.dataset.gmDo==='back')run('gameCollect',{site,lines},r=>{pop(r.truck.name+' is on its way to '+name,'go');setMode('yard');wmFocus('director');});
  else if(b.dataset.gmDo==='backall')run('gameCollect',{site,all:true},r=>{pop(r.truck.name+' is on its way to '+name,'go');setMode('yard');wmFocus('director');});
  else if(b.dataset.gmDo==='add')run('gameAddStock',{lines},r=>{pop('Added to the yard!','tick');G.picks=new Map();G.sel=null;G.mode='yard';document.querySelector('.gm-body')?.classList.remove('sheet');});
  return;}}
function setPickFromIndex(k){const s=G.ctx.state,p=products(s).find(x=>x.id===G.sel);if(!p)return;const stops=stopsFor(s,p);if(k<=0)G.picks.delete(p.id);else G.picks.set(p.id,stops[Math.min(k,stops.length)-1].qty);const q=G.picks.get(p.id)??0;
 const box=document.querySelector('[data-gm-num]');if(box&&document.activeElement!==box)box.value=String(q);const w=document.querySelector('[data-gm-words]');if(w)w.textContent=q?Math.min(k,stops.length)+' '+unitWord(p,k):'None yet';
 const slot=document.querySelector('[data-gm-slot="'+CSS.escape(p.id)+'"]');if(slot){slot.classList.toggle('picked',q>0);let em=slot.querySelector('.gm-pick');if(q){if(!em){em=document.createElement('em');em.className='gm-pick';slot.append(em);}em.textContent=gpCount(q);}else em?.remove();}}
function onInput(e){if(e.target.matches('[data-gm-range]'))setPickFromIndex(Number(e.target.value));}
function onChange(e){const t=e.target;if(t.matches('[data-gm-range]')){setPickFromIndex(Number(t.value));t.blur();refreshNow();return;}
 if(t.matches('[data-gm-num]')){const s=G.ctx.state,p=products(s).find(x=>x.id===G.sel);if(!p)return;const want=Math.max(0,Math.floor(Number(t.value)||0));let q=want;
  if(G.mode==='add'){const step=p.packQuantity>0?p.packQuantity:null;if(step&&want)q=Math.ceil(want/step)*step;}else q=gpSnap(stopsFor(s,p),want);
  if(q)G.picks.set(p.id,q);else G.picks.delete(p.id);t.blur();refreshNow();}}
function onSubmit(e){const f=e.target.closest('[data-gm-newsite-form]');if(!f)return;e.preventDefault();const d=Object.fromEntries(new FormData(f));if(!String(d.name??'').trim())return;
 run('gameSite',{name:d.name,address:d.address},r=>{G.site=r.site.id;G.newSite=false;pop(r.site.name+' is on the map!','tick');setTimeout(()=>wmFocus('site',r.site.id),600);});}
// ---------------------------------------------------------------- the hover card (mouse hover, keyboard focus, or a long press / a tap outside the picking modes)
function onOver(e){if(e.pointerType==='touch')return;const b=e.target.closest?.('[data-gm-slot]');if(!b)return;clearTimeout(G.hoverT);G.hoverT=setTimeout(()=>showCard(b),['send','back','add'].includes(G.mode)?650:220);}
function onOut(e){const b=e.target.closest?.('[data-gm-slot]');if(!b)return;if(e.relatedTarget&&b.contains(e.relatedTarget))return;clearTimeout(G.hoverT);hideCard();}
function onDown(e){if(e.pointerType!=='touch')return;const b=e.target.closest?.('[data-gm-slot]');if(!b)return;clearTimeout(G.pressT);G.pressT=setTimeout(()=>showCard(b,true),480);}
function showCard(b,sticky=false){const card=document.querySelector('[data-gm-card]'),s=G.ctx?.state;if(!card||!s)return;const id=b.dataset.gmSlot,p=products(s).find(x=>x.id===id);if(!p)return;G.hoverId=id;
 card.innerHTML=cardHTML(s,p);card.hidden=false;card.classList.toggle('sticky',sticky);const r=b.getBoundingClientRect(),w=card.offsetWidth,h=card.offsetHeight;let x=r.left-w-10,y=r.top-8;if(x<8)x=Math.min(innerWidth-w-8,r.right+10);if(y+h>innerHeight-8)y=innerHeight-h-8;if(y<8)y=8;card.style.left=Math.round(x)+'px';card.style.top=Math.round(y)+'px';}
function hideCard(){const card=document.querySelector('[data-gm-card]');if(card&&!card.hidden){card.hidden=true;G.hoverId=null;}}
function syncCard(){if(!G.hoverId)return;const b=document.querySelector('[data-gm-slot="'+CSS.escape(G.hoverId)+'"]');if(!b||!b.getClientRects().length||getComputedStyle(b.closest('.gm-dock')??b).visibility==='hidden'){hideCard();return;}const card=document.querySelector('[data-gm-card]');const s=G.ctx.state,p=products(s).find(x=>x.id===G.hoverId);if(card&&p){const html=cardHTML(s,p);if(card.__h!==html){card.__h=html;card.innerHTML=html;}}}
export function cardHTML(s,p){const yard=yardOf(s),yr=rowsAt(s,yard?.id).get(p.id),sites=activeSites(s).map(x=>({name:x.name,q:rowsAt(s,x.id).get(p.id)?.quantity??0})).filter(x=>x.q>0),trucks=(s.trucks??[]).map(t=>({name:t.name,q:rowsAt(s,t.id).get(p.id)?.quantity??0})).filter(x=>x.q>0);
 const line=(k,v,cls='')=>'<li class="'+cls+'"><span>'+esc(k)+'</span><b>'+num(v)+'</b></li>';
 return '<div class="gm-card-head">'+gaItem(p,'gm-card-pic')+'<div><b>'+esc(p.name)+'</b><small>'+esc([SYS_NAME[p.system]??p.system,p.category].filter(Boolean).join(' · '))+'</small></div></div><ul>'
  +line('In the yard',yr?.quantity??0,'yard')+(yr&&yr.free!==yr.quantity?line('free to send',yr.free??0,'sub'):'')+sites.map(x=>line(x.name,x.q)).join('')+trucks.map(x=>line('On '+x.name,x.q)).join('')+'</ul>'
  +(p.packQuantity>0?'<p>1 pack = '+num(p.packQuantity)+' pieces</p>':p.unitWeight>0?'<p>'+(Math.round(p.unitWeight/100)/10)+' kg each</p>':'')+'</div>';}
export const __gm={state:()=>G,setMode:(m,site)=>{G.mode=m;if(site)G.site=site;},gridItems:s=>gridItems(s),hint:s=>hintOf(s),truckWords:(s,t)=>truckWords(s,t),loadWords:(s,p)=>loadWords(s,p),grid:(s)=>{const l=gridItems(s);tabsHTML(s,l);return gridHTML(s,l);},start:ctx=>startHTML(ctx),office:ctx=>officeHTML(ctx),shell:ctx=>gmShell(ctx),reset:()=>{G.who=null;}};
