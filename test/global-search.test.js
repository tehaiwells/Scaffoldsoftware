import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gsFold, gsWords, gsEntries, gsSearch, gsMark } from '../public/operations.js';
// Global search: the matching and ranking are pure (client state in, grouped results out), so every case runs in node without a DOM.
const systems=[{id:'quickstage',name:'Quickstage'},{id:'at-pac',name:'AT-PAC'},{id:'tube-clip',name:'Tube & Clip'}];
const P=(id,name,reference,system='quickstage',category='Ledgers / horizontals',extra={})=>({id,name,reference,system,category,manufacturer:'Synthetic demonstration',unitWeight:1000,packQuantity:10,...extra});
function world(){
  const products=[P('std3','Standard 3.0 m','QS-STD-3000','quickstage','Standards / verticals'),P('std2','Standard 2.0 m','QS-STD-2000','quickstage','Standards / verticals'),P('led3','Ledger 3.0 m','QS-LED-3000'),P('led24','Ledger 2.4 m','QS-LED-2400'),
    P('beam','6.5" Aluminum Beam 1.82 m','AP-BM-182','at-pac','Beams'),P('lat','Aluminium lattice beam 450 x 3.0 m','TC-LB-3000','tube-clip','Beams'),P('coupler','Right-angle coupler','TC-RAC','tube-clip','Fittings'),P('old','Retired ledger','QS-OLD','quickstage','Ledgers / horizontals',{retired:true}),
    P('fr','Plinthe métallique 3 m','FR-PL-3','tube-clip','Boards')];
  return {products,yards:[{id:'Y',name:'Main yard'}],sites:[{id:'A',name:'George Street',status:'ACTIVE',client:'Harbour Build',supervisorName:'Sam Site'},{id:'B',name:'Queen Street tower',status:'ACTIVE'},{id:'C',name:'Old depot',status:'ARCHIVED'}],
    trucks:[{id:'T1',name:'T-01',payload:12500000,status:'AT_YARD',at:'Y'},{id:'T2',name:'T-02',payload:12500000,status:'IN_TRANSIT',at:'Y',destination:'A'},{id:'L1',name:'L-01',payload:2000000,status:'AT_SITE',at:'B'}],
    resources:[{id:'W1',name:'Worker 1',type:'WORKER',location:'Y',enabled:true,task:'x'},{id:'W2',name:'Worker 2',type:'WORKER',location:'Y',enabled:true},{id:'F1',name:'Forklift 1',type:'FORKLIFT',location:'Y',enabled:true},{id:'C1',name:'Crane 1',type:'CRANE',location:'A',enabled:true},{id:'W9',name:'Worker 9',type:'WORKER',location:'Y',enabled:false}],
    containers:[{id:'S12',name:'S-012',type:'STILLAGE',location:'Y',condition:'SERVICEABLE'},{id:'S13',name:'S-013',type:'STILLAGE',location:'T1',condition:'SERVICEABLE'},{id:'K1',name:'Cage 1',type:'CAGE',location:'A',condition:'DAMAGED'},{id:'S120',name:'S-120',type:'STILLAGE',location:'F1',condition:'SERVICEABLE'}],
    balances:[{container:'S12',product_id:'std3',quantity:60},{container:'K1',product_id:'coupler',quantity:40},{container:'K1',product_id:'led3',quantity:5}],
    register:[{product:'std3',yard:80},{product:'led3',yard:0}],
    loadLists:[{id:'LL1',name:'George St week 1',site:'A',siteName:'George Street',neededOn:'2026-09-28',slot:'AM',urgency:'LATER',lines:[{},{}]},{id:'LL2',name:'Tower pour',site:'B',siteName:'Queen Street tower',neededOn:null,urgency:'UNDATED',lines:[{}]},{id:'LL3',name:'Gone list',site:'B',siteName:'Queen Street tower',cancelled:true,lines:[]}]};
}
const find=(s,q,o)=>gsSearch(gsEntries(s,{systems}),q,o);
const names=(r,kind)=>r.groups.find(g=>g.kind===kind)?.items.map(e=>e.name)??[];

test('folding drops case and accents one character for one, and words split letters from numbers and compare numbers by value',()=>{
  assert.equal(gsFold('Plinthe MÉTALLIQUE'),'plinthe metallique');assert.equal(gsFold('Été').length,3);assert.equal(gsFold('450 × 3'),'450 x 3');
  assert.deepEqual(gsWords('S-012'),['s','012','12']);assert.deepEqual(gsWords('Standard 3.0 m'),['standard','3.0','3','m']);assert.deepEqual(gsWords('3m'),['3','m']);assert.deepEqual(gsWords('QS-STD-3000'),['qs','std','3000']);assert.deepEqual(gsWords('1.820'),['1.820','1.82']);assert.deepEqual(gsWords('T-02 2'),['t','02','2']);
});

test('every word must match, in any order; case, accents and number spelling do not matter',()=>{
  const s=world();
  assert.deepEqual(names(find(s,'standard 3'),'MATERIAL')[0],'Standard 3.0 m');
  assert.deepEqual(names(find(s,'3.0 STANDARD'),'MATERIAL'),['Standard 3.0 m']);
  assert.deepEqual(names(find(s,'3m standard'),'MATERIAL'),['Standard 3.0 m']);
  assert.deepEqual(names(find(s,'standard 5'),'MATERIAL'),[],'a word that matches nothing drops the item');
  assert.deepEqual(names(find(s,'metallique'),'MATERIAL'),['Plinthe métallique 3 m'],'accents ignored');
  assert.equal(names(find(s,'s012'),'STILLAGE')[0],'S-012');assert.deepEqual(names(find(s,'S-12'),'STILLAGE'),['S-012','S-120'],'012 and 12 are the same number (and whole numbers beat the start of one)');
  assert.deepEqual(names(find(s,'s-01'),'STILLAGE'),['S-012','S-013'],'the start of a number');
});

test('references match whole, in parts or run together; system, category and maker count too',()=>{
  const s=world();
  assert.deepEqual(names(find(s,'QS-STD-3000'),'MATERIAL'),['Standard 3.0 m']);
  assert.deepEqual(names(find(s,'qsstd3000'),'MATERIAL'),['Standard 3.0 m']);
  assert.deepEqual(names(find(s,'std 2000'),'MATERIAL'),['Standard 2.0 m']);
  assert.deepEqual(names(find(s,'tube clip beam'),'MATERIAL'),['Aluminium lattice beam 450 x 3.0 m']);
  assert.deepEqual(names(find(s,'fittings'),'MATERIAL'),['Right-angle coupler']);
  assert.ok(!names(find(s,'ledger'),'MATERIAL').includes('Retired ledger'),'retired products are not offered');
});

test('fuzzy-ish: one typo from four letters, and a word inside another from three',()=>{
  const s=world();
  assert.deepEqual(names(find(s,'aluminum'),'MATERIAL').sort(),['6.5" Aluminum Beam 1.82 m','Aluminium lattice beam 450 x 3.0 m'],'aluminum finds aluminium too');
  assert.deepEqual(names(find(s,'ledegr'),'MATERIAL'),['Ledger 2.4 m','Ledger 3.0 m'],'two letters swapped');
  assert.deepEqual(names(find(s,'standrd'),'MATERIAL').length,2,'a letter dropped');
  assert.deepEqual(names(find(s,'lattice'),'MATERIAL'),['Aluminium lattice beam 450 x 3.0 m']);
  assert.deepEqual(names(find(s,'ttice'),'MATERIAL'),['Aluminium lattice beam 450 x 3.0 m'],'inside a word');
  assert.deepEqual(names(find(s,'ed'),'MATERIAL'),[],'two letters only match the start of a word');
  assert.deepEqual(find(s,'3001').total,0,'no typos on numbers');
});

test('ranking: exact name first, then names starting with the query, then word matches; groups ordered by their best match',()=>{
  const s=world();
  const r=find(s,'ledger');assert.deepEqual(names(r,'MATERIAL'),['Ledger 2.4 m','Ledger 3.0 m'],'equal scores keep natural order');
  const t=find(s,'t-02');assert.equal(t.groups[0].kind,'TRUCK');assert.equal(t.groups[0].items[0].name,'T-02');
  const g=find(s,'george');assert.equal(g.groups[0].kind,'SITE');assert.deepEqual(names(g,'LIST'),['George St week 1']);
  const w=find(s,'worker 1');assert.equal(w.groups[0].kind,'CREW');assert.equal(w.groups[0].items[0].name,'Worker 1');
  const st=find(s,'standard');assert.equal(st.groups[0].kind,'MATERIAL');
  s.products.push(P('kw','Kwikstage standard 3.0 m','3.0MSTD','quickstage','Standards / verticals'),P('std3b','Standard 3.0 m','AP-STD-3000','at-pac','Standards / verticals'));
  assert.deepEqual(names(find(s,'standard 3.0 quickstage'),'MATERIAL'),['Standard 3.0 m','Kwikstage standard 3.0 m'],'equal scores: the shorter name first');
  assert.deepEqual(find(s,'standard 3.0',{cap:3}).groups[0].items.map(e=>e.key),['MATERIAL:std3','MATERIAL:std3b','MATERIAL:kw'],'equal scores: what is in the yard first');
});

test('stillages say where they are and what they hold; other pages come in as extra entries with their page',()=>{
  const s=world(),e=gsEntries(s,{systems,page:2,extra:[{container:{id:'S300',name:'S-300',type:'STILLAGE',location:'B'},page:3,contents:'empty'},{container:{id:'S12',name:'S-012',type:'STILLAGE',location:'Y'},page:0}]});
  const by=id=>e.find(x=>x.key==='STILLAGE:'+id);
  assert.equal(by('S12').pill,'Main yard');assert.equal(by('S12').tone,'yard');assert.equal(by('S12').sub,'Stillage · 60 × Standard 3.0 m');assert.equal(by('S12').page,2,'the live page wins over a stale copy');
  assert.equal(by('S13').pill,'On T-01');assert.equal(by('S13').tone,'truck');assert.equal(by('S120').pill,'On Forklift 1');
  assert.equal(by('K1').sub,'Cage · 2 components · 45 pcs');assert.equal(by('K1').pill,'George Street');assert.equal(by('K1').art,'spr-cage');
  assert.equal(by('S300').page,3);assert.equal(by('S300').pill,'Queen Street tower');
  assert.deepEqual(names(gsSearch(e,'queen street'),'STILLAGE'),['S-300'],'where a stillage is, is searchable');
  assert.deepEqual(names(gsSearch(e,'damaged'),'STILLAGE'),['Cage 1'],'so is a condition other than serviceable');
  assert.equal(e.filter(x=>x.kind==='STILLAGE').length,5,'no duplicates');
});

test('materials carry their yard count; trucks, crew, sites and yard lists carry their status words',()=>{
  const e=gsEntries(world(),{systems}),by=k=>e.find(x=>x.key===k);
  assert.equal(by('MATERIAL:std3').count,80);assert.equal(by('MATERIAL:led3').count,0);assert.equal(by('MATERIAL:std3').sub,'QS-STD-3000 · Quickstage · Standards / verticals');
  assert.deepEqual([by('TRUCK:T1').pill,by('TRUCK:T2').pill,by('TRUCK:L1').pill],['At the yard','On the road','At site']);assert.equal(by('TRUCK:T2').sub,'12.5 tonne truck · Heading to George Street');assert.equal(by('TRUCK:L1').heavy,false);
  assert.deepEqual([by('CREW:W1').pill,by('CREW:W2').pill,by('CREW:F1').pill],['Working','Standing by','Free']);assert.equal(by('CREW:C1').sub,'Crane · George Street');assert.equal(by('CREW:W9'),undefined,'removed crew are gone');
  assert.equal(by('SITE:A').sub,'Harbour Build · Supervisor Sam Site');assert.equal(by('SITE:C').pill,'Archived');
  assert.equal(by('LIST:LL1').pill,'Mon 28 Sep');assert.equal(by('LIST:LL1').sub,'George Street · Morning · 2 lines');assert.equal(by('LIST:LL2').pill,'No date');assert.equal(by('LIST:LL3'),undefined,'cancelled lists are gone');
  assert.deepEqual(names(gsSearch(e,'harbour'),'SITE'),['George Street'],'the client finds its site');
  assert.deepEqual(names(gsSearch(e,'mon 28 sep'),'LIST'),['George St week 1'],'a list by its date');
});

test('groups are capped with the full count; the opened group shows up to 50',()=>{
  const s=world();s.containers=Array.from({length:400},(_,i)=>({id:'c'+i,name:'S-'+String(i+1).padStart(3,'0'),type:'STILLAGE',location:'Y'}));
  const r=find(s,'s',{cap:5});const g=r.groups.find(g=>g.kind==='STILLAGE');assert.equal(g.total,400);assert.equal(g.items.length,5);
  assert.equal(find(s,'s',{cap:5,open:'STILLAGE'}).groups.find(g=>g.kind==='STILLAGE').items.length,50);
  assert.deepEqual(find(s,'   ').groups,[],'an empty query finds nothing');
});

test('a supervisor only finds what their own state holds',()=>{
  const s=world(),sup={...s,yards:[],sites:[s.sites[1]],trucks:[s.trucks[2]],containers:[],balances:[],resources:[],loadLists:[s.loadLists[1]]};
  const r=find(sup,'george');assert.equal(r.total,0);
  assert.deepEqual(names(find(sup,'queen'),'SITE'),['Queen Street tower']);assert.deepEqual(names(find(sup,'l-01'),'TRUCK'),['L-01']);assert.ok(!names(find(sup,'t-01'),'TRUCK').includes('T-01'));assert.equal(find(sup,'worker').total,0);
});

test('matches are marked at the start of words (anywhere from 3 letters), escaped, and never inside a typo',()=>{
  assert.equal(gsMark('Standard 3.0 m','stand 3'),'<mark>Stand</mark>ard <mark>3</mark>.0 m');
  assert.equal(gsMark('S-012','s-012'),'<mark>S-012</mark>','a label query is marked as one run');
  assert.equal(gsMark('S-012','s12'),'<mark>S</mark>-012','a number written differently is found but not marked');
  assert.equal(gsMark('Plinthe métallique','METAL'),'Plinthe <mark>métal</mark>lique','accents: the original letters are kept');
  assert.equal(gsMark('<b> & "x"','x'),'&lt;b&gt; &amp; &quot;<mark>x</mark>&quot;');
  assert.equal(gsMark('Aluminium','aluminum'),'Aluminium');
});

test('instant on a big yard: 580 products and 400 stillages index and search in a few milliseconds',()=>{
  const s=world();s.products=Array.from({length:580},(_,i)=>P('p'+i,['Standard','Ledger','Transom','Brace','Board','Coupler'][i%6]+' '+(0.5+(i%12)*0.5).toFixed(1)+' m '+i,'REF-'+i,['quickstage','at-pac','tube-clip'][i%3]));
  s.containers=Array.from({length:400},(_,i)=>({id:'c'+i,name:'S-'+String(i+1).padStart(3,'0'),type:i%5?'STILLAGE':'CAGE',location:['Y','A','T1'][i%3]}));
  let e=gsEntries(s,{systems});const t0=performance.now();for(let i=0;i<20;i++)e=gsEntries(s,{systems});const build=(performance.now()-t0)/20;
  const t1=performance.now();for(const q of ['s','st','sta','stan','stand','standard 2','standard 2.5','s-1','s-12','ledger 3 quick','aluminum','xyz'])for(let i=0;i<5;i++)gsSearch(e,q);const search=(performance.now()-t1)/60;
  assert.ok(build<25,'index build '+build.toFixed(2)+' ms');assert.ok(search<10,'search '+search.toFixed(2)+' ms');
});

test('the search box lives in the header, keeps polling alive and is hooked into render, bindPage, refresh and stopOperations',()=>{
  const ops=readFileSync(new URL('../public/operations.js',import.meta.url),'utf8'),css=readFileSync(new URL('../public/design.css',import.meta.url),'utf8');
  assert.match(ops,/function render\(\)\{mountSprites\(\);gsMount\(\);/);assert.match(ops,/hideCard\(\);gsStop\(\);\}/);assert.match(ops,/finally\{refreshing=false;gsAfterRefresh\(\);\}/);assert.match(ops,/placeSoon\(\);gsReflash\(\);/);
  assert.match(ops,/id="gs-input" type="search" data-live-search/,'data-live-search: typing does not pause the poll');
  assert.match(ops,/role="combobox"/);assert.match(ops,/role="listbox"/);
  const block=ops.slice(ops.indexOf('// ----- Global search (gs*)'));assert.ok(!/\sstyle="/.test(block),'no inline style attributes (the CSP drops them)');
  assert.match(css,/\/\* ={3,} Global search/);assert.match(css,/\.gs\.sheet/);
});

test('a label-like word (letters-dash-digits) is one term: s-0 finds stillages, not every material with an s and a 0',()=>{
  const s=world();s.products.push(P('base','Starter / base collar 0.30 m','QS-BC-030'),P('sj','Swiveljack 0.78 m','QS-SJ-078'));
  const r=find(s,'s-0');assert.deepEqual(names(r,'STILLAGE'),['S-012','S-013']);assert.deepEqual(names(r,'MATERIAL'),[],'no loose s + 0 matches');assert.equal(r.groups.length,1);
  assert.deepEqual(names(find(s,'S-12'),'STILLAGE'),['S-012','S-120'],'by value it still equals S-012; S-120 starts with it');
  assert.deepEqual(names(find(s,'s-01'),'STILLAGE'),['S-012','S-013']);
  assert.deepEqual(names(find(s,'QS-STD-3000'),'MATERIAL'),['Standard 3.0 m'],'a whole reference is a label too');
  assert.deepEqual(names(find(s,'qs-bc'),'MATERIAL'),['Starter / base collar 0.30 m'],'letters only: plain words as before');
  assert.deepEqual(names(find(s,'T-01'),'TRUCK'),['T-01']);assert.deepEqual(names(find(s,'t-0 truck'),'TRUCK'),['T-01','T-02'],'a label and a plain word together');
  assert.equal(gsMark('S-012','s-0'),'<mark>S-0</mark>12','the label is marked as one run');assert.equal(gsMark('S-012','S-12'),'<mark>S-012</mark>','by value: the whole label');
  assert.equal(gsMark('Starter / base collar 0.30 m','s-0'),'Starter / base collar 0.30 m','no scattered marks');
});

test('equal best scores: the smaller, more specific group comes first (t shows the trucks before hundreds of materials)',()=>{
  const s=world();for(let i=0;i<40;i++)s.products.push(P('tb'+i,'T-bolt '+i,'TB-'+i,'tube-clip','Fittings'));
  const r=find(s,'t');assert.equal(r.groups[0].kind,'TRUCK');assert.equal(r.groups[0].best,r.groups.find(g=>g.kind==='MATERIAL').best,'the scores tie');
});
