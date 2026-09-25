import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from './simulation.test.js';
import { readdirSync } from 'node:fs';
import { materialFacts, materialCardHTML, tileLabels, tileCount } from '../public/operations.js';
// The stockpile tiles' hover card: its content builders are pure (client state + product id -> facts -> HTML), so every case runs in node without a DOM.
const css=readFileSync(new URL('../public/design.css',import.meta.url),'utf8');
const P={id:'P',name:'Standard 3.0 m',system:'quickstage',category:'Standards / verticals',manufacturer:'Synthetic demonstration',reference:'QS-STD-3000',region:'DEMO',unitWeight:12700,packQuantity:10,verification:'DEMO ONLY'};
const row=(product,quantity,extra={})=>({product,name:'Standard 3.0 m',quantity,reserved:0,unserviceable:0,free:quantity,containers:1,...extra});
const site=(id,name,status='ACTIVE')=>({id,name,status});
function world({sites=[site('A','George Street'),site('B','Queen Street tower'),site('C','Harbour Bridge Rd')],stock}={}){
  return {products:[P],yards:[{id:'Y',name:'Main yard'}],sites,
    trucks:[{id:'T1',name:'T-01',status:'AT_YARD',at:'Y'},{id:'T2',name:'L-01',status:'IN_TRANSIT',at:'Y',destination:'A'},{id:'T3',name:'T-02',status:'AT_SITE',at:'B'}],
    register:[{product:'P',name:'Standard 3.0 m',system:'quickstage',category:'Standards / verticals',unitWeight:12700,quantity:215,reserved:30,yard:80,site:90,truck:45,containers:6}],
    stock:stock??{Y:{rows:[row('P',80,{reserved:30,free:50,containers:2})]},A:{rows:[row('P',60)]},B:{rows:[row('P',30)]},T1:{rows:[row('P',40)]},T2:{rows:[row('P',5)]},T3:{rows:[]}}};
}

test('the card lists the yard (free / reserved / containers), every site and every truck carrying the component, with the total owned',()=>{
  const f=materialFacts(world(),'P');
  assert.equal(f.product.name,'Standard 3.0 m');assert.equal(f.product.systemName,'Quickstage');assert.equal(f.known,true);
  assert.deepEqual(f.yard,{quantity:80,reserved:30,unserviceable:0,free:50,containers:2});
  assert.deepEqual(f.sites.map(s=>[s.name,s.quantity]),[['George Street',60],['Queen Street tower',30],['Harbour Bridge Rd',0]],'few sites: all listed, stocked first, zeros too');
  assert.equal(f.zeroSites,0);assert.equal(f.onSites,90);
  assert.deepEqual(f.trucks.map(t=>[t.name,t.quantity,t.where]),[['T-01',40,'at the yard'],['L-01',5,'on the road to George Street']],'only trucks carrying it, most first');
  assert.equal(f.onTrucks,45);assert.equal(f.total,215);
  const html=materialCardHTML(f,{hint:'Click adds 5 to the yard'});
  for(const s of ['Standard 3.0 m','Quickstage &middot; Standards / verticals','Synthetic demonstration','QS-STD-3000','12.7 kg','10 <small>per stillage','DEMO ONLY','<em>50 free</em>','30 reserved','in 2 stillages / cages','George Street','<b>60</b>','Harbour Bridge Rd','on the road to George Street','Total owned','<b>215</b>','Click adds 5 to the yard'])assert.ok(html.includes(s),'card shows '+s);
  assert.ok(!/\sstyle=/.test(html),'no inline style attributes (the CSP drops them): bars use data-style');
  assert.match(html,/class="mc-seg yard" data-style="flex-grow:80"/);assert.match(html,/class="mc-seg site" data-style="flex-grow:90"/);assert.match(html,/class="mc-seg truck" data-style="flex-grow:45"/);
  assert.ok(html.indexOf('In yard')<html.indexOf('On sites')&&html.indexOf('On sites')<html.indexOf('On trucks')&&html.indexOf('On trucks')<html.indexOf('Total owned'));
});

test('with many sites the card lists only those holding stock and sums up the rest; archived sites only show when they still hold some',()=>{
  const names=['George Street','Queen Street tower','Harbour Bridge Rd','Kent St depot','Riverside apartments','Northgate school','Eastlink bridge','Park Road'];
  const sites=[...names.map((n,i)=>site('S'+i,n)),site('OLD','Old job','ARCHIVED'),site('OLD2','Older job','ARCHIVED')];
  const f=materialFacts(world({sites,stock:{Y:{rows:[]},S2:{rows:[row('P',20)]},S5:{rows:[row('P',70)]},OLD2:{rows:[row('P',4)]}}}),'P');
  assert.deepEqual(f.sites.map(s=>[s.name,s.quantity,s.archived]),[['Northgate school',70,false],['Harbour Bridge Rd',20,false],['Older job',4,true]]);
  assert.equal(f.zeroSites,6,'the 6 active sites with none; the empty archived site is left out');assert.equal(f.onSites,94);
  const html=materialCardHTML(f);assert.ok(html.includes('0 at 6 other sites'));assert.ok(html.includes('<small>archived</small>'));assert.ok(!html.includes('Kent St depot'));
  assert.ok(html.includes('None in the yard'));assert.ok(!html.includes('On trucks'),'no trucks section when no truck carries it');
  // more stocked sites than fit: the first six by quantity, then one '+ N more sites' line with their total
  const many=Array.from({length:10},(_,i)=>site('M'+i,'Site '+(i+1)));const stock={};many.forEach((s,i)=>stock[s.id]={rows:[row('P',i+1)]});
  const g=materialFacts(world({sites:[...many,site('Z','Zed')],stock}),'P');
  assert.deepEqual(g.sites.map(s=>s.quantity),[10,9,8,7,6,5]);assert.deepEqual(g.moreSites,{count:4,quantity:1+2+3+4});assert.equal(g.zeroSites,1);assert.equal(g.onSites,55);
  const gh=materialCardHTML(g);assert.ok(gh.includes('+ 4 more sites'));assert.ok(gh.includes('0 at 1 other site<'));
  // nowhere at all
  const none=materialCardHTML(materialFacts(world({sites,stock:{}}),'P'));assert.ok(none.includes('Not held anywhere: none in the yard, at your 8 sites or on a truck.'),'one line instead of three empty sections');assert.ok(!none.includes('In yard')&&!none.includes('On sites'));assert.ok(none.includes('<b>0</b></div>'),'total 0');assert.ok(!none.includes('mc-split'),'no split bar with nothing owned');
  assert.ok(materialCardHTML(materialFacts({...world({sites:[site('A','George Street')],stock:{}}),yards:[]},'P')).includes('none at your one site or on a truck.'),'a supervisor: no yard in the sentence');
});

test('missing catalogue fields and unknown products still give a readable card',()=>{
  const bare={id:'Q',name:'Mystery clip <b>',system:'odd-system'};
  const s={...world(),products:[P,bare],stock:{Y:{rows:[row('Q',3,{name:'Mystery clip <b>',reserved:1,free:1,unserviceable:1})]}}};
  const f=materialFacts(s,'Q');assert.equal(f.product.systemName,'odd-system');assert.equal(f.product.unitWeight,null);assert.equal(f.product.packQuantity,null);
  const html=materialCardHTML(f);
  assert.equal((html.match(/Not set/g)??[]).length,2,'weight and pack say Not set');assert.ok(!html.includes('mc-verify'),'no verification line without a status');assert.ok(!html.includes('mc-ref'),'no manufacturer / reference line');
  assert.ok(html.includes('Mystery clip &lt;b&gt;')&&!html.includes('Mystery clip <b>'),'names are escaped');assert.ok(html.includes('1 damaged')&&html.includes('1 reserved')&&html.includes('in 1 stillage / cage'));
  assert.equal(materialFacts(s,'Q',[{id:'odd-system',name:'Odd System'}]).product.systemName,'Odd System','the account\'s system names win');
  // not in the (cached) catalogue: the register row names it; not anywhere: 'Unknown product'
  assert.equal(materialFacts({...world(),products:[]},'P').product.name,'Standard 3.0 m');assert.equal(materialFacts({...world(),products:[]},'P').known,false);
  const u=materialFacts({...world(),products:undefined},'nope');assert.equal(u.product.name,'Unknown product');assert.equal(u.total,0);
  assert.ok(materialCardHTML(u).includes('Unknown product'));
  const v=materialCardHTML(materialFacts({...world(),products:[{...P,verification:'SOURCE VERIFIED'}]},'P'));assert.ok(v.includes('mc-badge ok')&&v.includes('SOURCE VERIFIED'));
  const w=materialCardHTML(materialFacts({...world(),products:[{...P,verification:'SOMETHING NEW'}]},'P'));assert.ok(w.includes('mc-badge warn'),'unknown statuses still get a badge');
});

test('without the per-location stock (or the yard, for a supervisor) the card falls back to what the state has',()=>{
  const s=world();delete s.stock;const f=materialFacts(s,'P');
  assert.equal(f.yard.quantity,80);assert.equal(f.yard.reserved,null);assert.equal(f.onSites,90);assert.equal(f.onTrucks,45);assert.equal(f.total,215);assert.deepEqual(f.sites,[]);
  const html=materialCardHTML(f);assert.ok(html.includes('Per-site split not loaded'));assert.ok(!html.includes('free'),'no free / reserved split to show');
  const sup=materialFacts({...world(),yards:[]},'P');assert.equal(sup.yard,null);assert.ok(!materialCardHTML(sup).includes('In yard'),'a supervisor sees no yard line');assert.equal(sup.total,135);
});

test('stockpile tiles carry an accessible name instead of a native title, and the tiles and card are styled compact',async t=>{
  const f=fixture(t),T=(await import('../public/operations.js')).__test;const s=f.sim.snapshot();
  T.setState(s,{permissions:['operations.manage','stock.adjust'],systems:[{id:'quickstage',name:'Quickstage',enabled:true}],users:[],company:{id:'c',name:'Demo'},user:{id:f.user.id}});T.setStep(1);T.setGridSearch({});
  const html=T.stockpile(),tiles=[...html.matchAll(/<button type="button" class="tile[^>]*>/g)].map(m=>m[0]);
  assert.ok(tiles.length>0);for(const b of tiles){assert.ok(!/ title=/.test(b),'no native tooltip: '+b);assert.match(b,/aria-label="[^"]+, [\d,]+ in yard"/);}
  const tileOf=name=>html.slice(html.indexOf('aria-label="'+name+', '),html.indexOf('</button>',html.indexOf('aria-label="'+name+', ')));
  const ledger=tileOf('DEMO ledger — 2 m'),fitting=tileOf('DEMO fitting — unknown weight');
  assert.ok(ledger.includes(' data-size="2 m"')&&ledger.includes('<span class="tile-name">DEMO ledger</span>'),'a name ending in a size keeps the size whole (data-size, drawn by CSS) and drops the dash: '+ledger);
  assert.ok(!fitting.includes('data-size')&&fitting.includes('<span class="tile-name">DEMO fitting — unknown weight</span>'),'no size, whole name: '+fitting);
  assert.match(css,/\.stockpile \.tile\[data-size\]::after\{content:attr\(data-size\)/);assert.match(css,/\.stockpile \.tile\[data-variant\]::before\{content:attr\(data-variant\)/);
  assert.match(css,/\.stockpile \.tile\{height:86px;/);assert.match(css,/\.stockpile \.tile:nth-child\(n\+26\)\{content-visibility:auto;contain-intrinsic-size:auto 86px\}/,'the off-screen estimate equals the fixed tile height, so a restored grid scroll lands on the same tile');
  const reg=s.register.find(r=>r.yard>0);assert.ok(html.includes('aria-label="'+reg.name+', '+reg.yard+' in yard"'));
  assert.match(css,/\.stockpile \.tile-grid\{grid-template-columns:repeat\(auto-fill,minmax\(66px,1fr\)\)/);assert.match(css,/\.stockpile \.tile-icon\{width:32px;height:32px/);
  assert.match(css,/\.mat-card\{position:fixed;[^}]*pointer-events:none/);assert.match(css,/\.mat-card\[hidden\]\{display:none\}/);
});

test('building the card for one product of a ~580-product catalogue is cheap (it is built on hover, not per tile)',()=>{
  const products=Array.from({length:580},(_,i)=>({...P,id:'p'+i,name:'Part '+i}));const s={...world(),products};s.register=products.map(p=>({product:p.id,quantity:5,yard:5,site:0,truck:0}));
  for(const p of products.slice(0,50))s.stock.Y.rows.push(row(p.id,5));
  const t0=performance.now();for(let i=0;i<200;i++)materialCardHTML(materialFacts(s,'p'+(i*7%580)));const ms=(performance.now()-t0)/200;
  assert.ok(ms<2,'one card in '+ms.toFixed(3)+' ms');
});

test('tile labels: the size that differs on its own line, the words that differ on a variant line',()=>{
  const L=tileLabels([
    {id:'a',category:'Standards',name:'Ringlock standard with bolted spigot 0.5 m (1 ring)'},{id:'b',category:'Standards',name:'Ringlock standard with hanging spigot 0.5 m (1 ring)'},
    {id:'c',category:'Planks',name:'Timber plank 230 x 38 mm 1.2 m'},{id:'d',category:'Planks',name:'Timber plank 230 x 38 mm 1.5 m'},
    {id:'e',category:'Beams',name:'Aluminium beam 450 mm x 4.0 m'},{id:'f',category:'Beams',name:'Aluminium beam 450 mm x 6.0 m'},{id:'g',category:'Beams',name:'Aluminium lattice beam 750 x 2.25 m'},
    {id:'h',category:'Braces',name:"Swivel clamp brace 10' (3.04 m)"},{id:'i',category:'Ledgers',name:"Ledger O-Type 0.91 m (3')"},{id:'j',category:'Girders',name:'Lattice girder no spigot 4.26 m (0.5 m deep)'},{id:'k',category:'Girders',name:'Lattice girder with spigot 4.26 m (0.5 m deep)'},
    {id:'l',category:'Acc',name:'Kwikstage hopup bracket 1 board'},{id:'m',category:'Acc',name:'Kwikstage hopup bracket 2 board'},{id:'n',category:'Tools',name:'Podger hammer'},{id:'o',category:'Tools',name:'Ratchet 21/24'},
    {id:'p',category:'Dup',name:'Same thing',reference:'R-1'},{id:'q',category:'Dup',name:'Same thing',reference:'R-2'}]);
  const t=id=>{const x=L.get(id);return [x.name,x.variant,x.size];};
  assert.deepEqual(t('a'),['Ringlock standard','bolted','0.5 m'],'words every member shares (with, spigot) are dropped from a long variant');assert.deepEqual(t('b'),['Ringlock standard','hanging','0.5 m']);
  assert.deepEqual(t('c'),['Timber plank','','1.2 m'],'the constant 230 x 38 mm section is dropped');assert.deepEqual(t('e'),['Aluminium beam','','4.0 m']);assert.deepEqual(t('g'),['Aluminium lattice beam','','750×2.25 m']);
  assert.deepEqual(t('h'),['Swivel clamp brace','','3.04 m'],'imperial duplicate dropped');assert.deepEqual(t('i'),['Ledger O-Type','','0.91 m']);
  assert.deepEqual(t('j'),['Lattice girder','no spigot','4.26 m']);assert.deepEqual(t('k'),['Lattice girder','with spigot','4.26 m']);
  assert.deepEqual(t('l'),['Kwikstage hopup bracket','','1 board']);assert.deepEqual(t('n'),['Podger hammer','','']);assert.deepEqual(t('o'),['Ratchet 21/24','','']);
  assert.deepEqual([t('p')[1],t('q')[1]],['R-1','R-2'],'identical names fall back to the reference');
});

test('tile labels tell every product of the shipped catalogues apart within its category (short enough for a 66 px tile)',()=>{
  const dir=new URL('../catalogues/',import.meta.url),files=['quickstage-materials.json','at-pac-materials.json','tube-clip-materials.json',...readdirSync(new URL('verified/',dir)).map(f=>'verified/'+f)];
  let all=[],i=0;for(const f of files)for(const p of JSON.parse(readFileSync(new URL(f,dir),'utf8')).products)all.push({...p,id:'p'+i++});
  assert.ok(all.length>500);const MISC=new Set(['Accessories','Tools','Other']),groups=new Map();
  for(const p of all){const k=(MISC.has(p.category)?'MISC':p.system)+'|'+p.category;(groups.get(k)??groups.set(k,[]).get(k)).push(p);}
  // What a tile can show: about 11 characters a line; the name gets 3 lines, 2 next to a size or variant line, 1 next to both.
  const shown=l=>{const lines=l.size&&l.variant?1:l.size||l.variant?2:3;return [l.name.slice(0,11*lines).toLowerCase(),l.variant.slice(0,11).toLowerCase(),l.size.slice(0,11)].join('|');};
  const clashes=[];for(const list of groups.values()){const L=tileLabels(list),seen=new Map();for(const p of list){const k=shown(L.get(p.id));if(seen.has(k))clashes.push(seen.get(k)+' / '+p.name);seen.set(k,p.name);assert.ok(L.get(p.id).size.length<=11,'size fits one line: '+L.get(p.id).size);}}
  assert.deepEqual(clashes,[]);
});

test('tile badge counts stay within four characters; the card keeps the exact figure',()=>{
  assert.deepEqual([0,7,999,1000,1560,9999,12500,999999,1250000].map(tileCount),['0','7','999','1k','1.5k','9.9k','12k','999k','1.2M']);
  assert.ok(materialCardHTML(materialFacts(world({stock:{Y:{rows:[row('P',12500)]}}}),'P')).includes('<b>12,500</b>'));
});

test('a card too tall for the screen can ask for fewer site and truck rows; head and total stay outside the part that gives way',()=>{
  const names=Array.from({length:9},(_,i)=>site('S'+i,'Site '+(i+1)));const stock={Y:{rows:[row('P',50)]}};names.forEach((s,i)=>stock[s.id]={rows:[row('P',10+i)]});
  const trucks=Array.from({length:5},(_,i)=>({id:'T'+i,name:'Truck '+(i+1),status:'AT_YARD',at:'Y'}));trucks.forEach((t,i)=>stock[t.id]={rows:[row('P',1+i)]});
  const s={...world({sites:names,stock}),trucks};
  const full=materialFacts(s,'P');assert.equal(full.sites.length,6);assert.equal(full.moreSites.count,3);assert.equal(full.trucks.length,5);assert.equal(full.moreTrucks,null);
  const small=materialFacts(s,'P',[],{sites:3,trucks:2});assert.deepEqual(small.sites.map(x=>x.quantity),[18,17,16]);assert.deepEqual(small.moreSites,{count:6,quantity:10+11+12+13+14+15});
  assert.deepEqual(small.trucks.map(t=>t.quantity),[5]);assert.deepEqual(small.moreTrucks,{count:4,quantity:1+2+3+4});assert.equal(small.onTrucks,15,'totals do not change');assert.equal(small.total,full.total);
  const html=materialCardHTML(small);assert.ok(html.includes('+ 4 more trucks')&&html.includes('+ 6 more sites'));
  assert.match(html,/^<div class="mc-head">.*<\/div><div class="mc-body">.*<\/div><div class="mc-total">/s,'head, body, total');
  assert.match(css,/\.mat-card\{[^}]*display:flex;flex-direction:column;[^}]*max-height:calc\(100vh - 16px\)/);assert.match(css,/\.mc-body\{flex:0 1 auto;min-height:0;overflow:hidden\}/);
});
