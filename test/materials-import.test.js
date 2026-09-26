import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/database.js';
import { Service } from '../src/service.js';
import { Simulation } from '../src/simulation.js';
import { computeEffectiveProducts } from '../src/domain/catalogue.js';
import { createApp } from '../src/server.js';
import { miParseRows, miSniff, miDecode, miNumber, miWeight, miPack, miVerification, miSystemOf, miHeaderField, miHeadUnit, miNoRef, miFindHeader, miGuessMap, miGuessByContent, miPlan, miProduct, miUpdate, miBatches, miTemplateCSV, MI_TEMPLATE_HEAD, miFixValues, miImportPanel, miFixPanel, miGapsCallout, miReset, miState, materialsView, __test } from '../public/operations.js';
// The Materials import (paste / CSV) and the missing-figures fixer: the pure parsing, mapping and checking helpers, the batches under the 16 KB request limit, the cards they draw, and the override source note on the server.
const BOM=String.fromCharCode(0xFEFF),NBSP=String.fromCharCode(0xA0);
const SYS=[{id:'quickstage',name:'Quickstage',enabled:true},{id:'at-pac',name:'AT-PAC',enabled:true},{id:'tube-clip',name:'Tube & Clip',enabled:true}];

test('miParseRows reads quotes, commas and line breaks inside quoted cells, doubled quotes, CRLF and a BOM; a stray inch mark stays',()=>{
  const csv=BOM+'Name,System,Weight\r\n"Base plate, 2"" heavy",Quickstage,"3,5"\r\nCaster 8" HD,AT-PAC,4.2\r\n"Two\nlines",QS,\r\n';
  assert.deepEqual(miParseRows(csv,','),[['Name','System','Weight'],['Base plate, 2" heavy','Quickstage','3,5'],['Caster 8" HD','AT-PAC','4.2'],['Two\nlines','QS','']]);
  assert.deepEqual(miParseRows('a\tb\n\tc',String.fromCharCode(9)),[['a','b'],['','c']]);
  assert.deepEqual(miParseRows('x;"";y',';'),[['x','','y']],'an empty quoted cell');
  assert.deepEqual(miParseRows('',','),[]);
});

test('miSniff picks the separator that splits the lines evenly: tabs (even with commas in names), commas with quoted commas, semicolons, pipes',()=>{
  const T=String.fromCharCode(9);
  assert.equal(miSniff('Name'+T+'System'+T+'Weight\nLedger, 2 m'+T+'QS'+T+'5\nBrace, bay'+T+'QS'+T+'4'),T);
  assert.equal(miSniff('Name,System,Weight\n"Ledger; 2 m",QS,5\n"Brace, bay",QS,4'),',');
  assert.equal(miSniff('Name;System;Weight\nLedger 2,0 m;QS;5,5\nBrace;QS;4'),';');
  assert.equal(miSniff('Name|System|Weight\nLedger|QS|5'),'|');
  assert.equal(miSniff('just one column\nsecond'),',','a single column falls back to commas');
});

test('miDecode reads UTF-8 (with or without a BOM), UTF-16 from Excel and falls back to Windows-1252',()=>{
  assert.equal(miDecode(new TextEncoder().encode(BOM+'Näme,Système')),'Näme,Système');
  const s='Name'+String.fromCharCode(9)+'Ledger 2 m',u16=new Uint8Array(2+s.length*2);u16[0]=0xFF;u16[1]=0xFE;for(let i=0;i<s.length;i++){u16[2+i*2]=s.charCodeAt(i);u16[3+i*2]=0;}
  assert.equal(miDecode(u16),s);
  assert.equal(miDecode(new Uint8Array([0x43,0x61,0x66,0xE9])),'Caf'+String.fromCharCode(0xE9),'0xE9 alone is not UTF-8: read as Windows-1252');
});

test('miNumber reads decimals, decimal commas, thousands and spaces; blank is null, words are NaN',()=>{
  for(const [v,n] of [['12.5',12.5],['12,5',12.5],['0,25',0.25],['1,250',1250],['1 250',1250],['1'+NBSP+'250',1250],['1.250,5',1250.5],['.5',0.5],['-3',-3],['7',7]])assert.equal(miNumber(v),n,v);
  assert.equal(miNumber(''),null);assert.equal(miNumber('   '),null);for(const v of ['abc','12.5.1','1,2345','12kg'])assert.ok(Number.isNaN(miNumber(v)),v);
});

test('miWeight turns kg or g into whole grams, a unit after the number wins, pounds and nonsense are refused and odd sizes are flagged',()=>{
  assert.deepEqual(miWeight('12.5','kg'),{g:12500});assert.deepEqual(miWeight('850','g'),{g:850});assert.deepEqual(miWeight('850 g','kg'),{g:850});assert.deepEqual(miWeight('1,5 kg','g'),{g:1500});assert.deepEqual(miWeight('0.06','kg'),{g:60});
  assert.deepEqual(miWeight('',"kg"),{g:null});assert.match(miWeight('heavy','kg').error,/not a number/);assert.match(miWeight('0','kg').error,/more than 0/);assert.match(miWeight('-2','kg').error,/more than 0/);
  assert.match(miWeight('5 lb','kg').error,/pounds/);assert.match(miWeight('20000','kg').error,/over 10 tonnes/);assert.match(miWeight('0.0001','kg').error,/rounds to 0 g/);
  assert.equal(miWeight('1500','kg').warning,'Over 1 tonne each: is the weight in grams?');assert.equal(miWeight('4.5','g').warning,'Under 10 g each: is the weight in kg?');
});

test('miPack wants whole pieces of 1 or more',()=>{
  assert.deepEqual(miPack('50'),{n:50});assert.deepEqual(miPack('1,000'),{n:1000});assert.deepEqual(miPack('25 pcs'),{n:25});assert.deepEqual(miPack(''),{n:null});
  for(const v of ['0','2.5','-1','lots'])assert.match(miPack(v).error,/whole number of 1 or more/,v);
});

test('miVerification and miSystemOf match what people write',()=>{
  assert.equal(miVerification('SOURCE VERIFIED'),'SOURCE VERIFIED');assert.equal(miVerification('verified'),'SOURCE VERIFIED');assert.equal(miVerification('Company set'),'COMPANY CONFIGURED');assert.equal(miVerification('demo only'),'DEMO ONLY');
  assert.equal(miVerification('needs_regional_check'),'NEEDS REGIONAL CHECK');assert.equal(miVerification('unverified'),null);assert.equal(miVerification('maybe'),null);assert.equal(miVerification(''),null);
  assert.equal(miSystemOf('Quickstage',SYS),'quickstage');assert.equal(miSystemOf(' QUICK STAGE ',SYS),'quickstage');assert.equal(miSystemOf('qs',SYS),'quickstage');assert.equal(miSystemOf('AT-PAC',SYS),'at-pac');assert.equal(miSystemOf('atpac',SYS),'at-pac');
  assert.equal(miSystemOf('Tube and Clip',SYS),'tube-clip');assert.equal(miSystemOf('tube & clip',SYS),'tube-clip');assert.equal(miSystemOf('Layher',SYS),null);assert.equal(miSystemOf('',SYS),null);
});

test('header cells map to fields in the right order, the header row is found under title lines, and the template maps every field',()=>{
  const pairs={'Unit weight (kg)':'weight','Weight unit':'unit','Weight each (g)':'weight','Source page':'page','Manufacturer name':'manufacturer','System name':'system','Item code':'reference','Part no':'reference','Product name':'name','Description':'name','Pack quantity per stillage':'pack','Qty per pack':'pack','Verification / source':'verification','Source document':'source','Notes':'source','Category':'category','Type':'category','Region':'region','Colour':null};
  for(const [h,k] of Object.entries(pairs))assert.equal(miHeaderField(h),k,h);
  const g=miGuessMap(MI_TEMPLATE_HEAD);for(const [k,i] of Object.entries(g.map))if(k!=='unit')assert.ok(i>=0,'template maps '+k);assert.equal(g.unit,'kg');assert.equal(g.map.unit,-1);
  assert.equal(miGuessMap(['Name','System','Weight (g)']).unit,'g');assert.equal(miGuessMap(['Name','System','Weight']).unit,null);
  const rows=[['Harbour Scaffold price list'],['Exported 2026'],['Code','Description','System','Weight kg','Per stillage'],['35.02','Pig tail pin','AT-PAC','0.06','5000']];
  assert.equal(miFindHeader(rows),2);const m=miGuessMap(rows[2]).map;assert.equal(m.reference,0);assert.equal(m.name,1);assert.equal(m.system,2);assert.equal(m.weight,3);assert.equal(m.pack,4);
  assert.equal(miFindHeader([['Ledger 2 m','Quickstage','5'],['Base plate - System 2"','AT-PAC','3']]),-1,'data rows are not a header');
  const bare=miGuessByContent([['Ledger 2 m','Quickstage','5'],['Brace','QS','4'],['Tube 6 m','Tube & Clip','25']],SYS).map;assert.equal(bare.name,0);assert.equal(bare.system,1);assert.equal(bare.weight,-1);
  const template=miTemplateCSV();assert.equal(template.charCodeAt(0),0xFEFF,'a BOM so Excel reads UTF-8');assert.deepEqual(miParseRows(template,',')[0],MI_TEMPLATE_HEAD);
});

const CAT=[{id:'p1',name:'Ledger 2 m',system:'quickstage',reference:'QS-L2000',unitWeight:null,packQuantity:50},{id:'p2',name:'Brace bay',system:'quickstage',reference:'QS-B1',unitWeight:4000,packQuantity:null},{id:'p3',name:'Old transom',system:'quickstage',reference:'QS-T9',retired:true,unitWeight:1000,packQuantity:10}];
const HEAD=['Name','System','Category','Reference','Weight (kg)','Pack','Verification','Source','Page'];
const plan=(rows,cfg={})=>{const map=miGuessMap(HEAD).map;return miPlan([HEAD,...rows],{header:0,map,unit:'kg',verDefault:'COMPANY CONFIGURED',...cfg},CAT,SYS);};

test('miPlan checks every row: names, systems, numbers, verification and cells past the header',()=>{
  const p=plan([
    ['Standard 1 m','Quickstage','standards / verticals','QS-S1','3.1','40','','',''],
    ['','Quickstage','','X1','1','1','','',''],
    ['Coupler','Layher','','L-1','1.2','100','','',''],
    ['Board 3 m','QS','Decking / planks','QS-D3','heavy','0','','',''],
    ['Tube 6 m','Tube & Clip','Tube','','25.2','','verified','',''],
    ['Clamp','TC','','TC-9','0.9','','Verified','Catalogue 2020','32','extra'],
    ['','','','','','','','',''],
    ['Pin','AT-PAC','','AP-1','1500','','whatever','','']]);
  const [a,b,c,d,e,f,g]=p.rows;
  assert.equal(a.action,'add');assert.equal(a.category,'Standards / verticals','known categories keep their spelling');assert.equal(a.g,3100);assert.equal(a.pack,40);assert.equal(a.verification,'COMPANY CONFIGURED');
  assert.equal(b.action,'error');assert.deepEqual(b.errors,['No name']);
  assert.equal(c.action,'error');assert.match(c.errors[0],/Unknown system "Layher"/);assert.deepEqual(p.unknown.map(u=>[u.raw,u.count]),[['Layher',1]]);
  assert.equal(d.action,'error');assert.equal(d.errors.length,2,'a bad weight and a bad pack');
  assert.equal(e.action,'add');assert.equal(e.reference,'NOREF-TUBE-CLIP-TUBE-6-M');assert.equal(e.verification,'COMPANY CONFIGURED','verified without a document and page is not saved as verified');assert.equal(e.warnings.length,2);
  assert.equal(f.verification,'SOURCE VERIFIED');assert.match(f.warnings.join(),/More cells than the header row/);
  assert.equal(g.line,9,'row numbers count the blank row');assert.match(g.warnings.join(),/not recognised/);assert.match(g.warnings.join(),/Over 1 tonne/);
  assert.equal(p.counts.blank,1);assert.equal(p.counts.total,7);assert.equal(p.counts.error,3);assert.equal(p.counts.add,4);
  const chosen=plan([['Coupler','Layher','','L-1','1.2','100','','','']],{sysMap:{layher:'at-pac'}});assert.equal(chosen.rows[0].action,'add');assert.equal(chosen.rows[0].system,'at-pac');assert.equal(chosen.unknown[0].pick,'at-pac');
  const skipped=plan([['Coupler','Layher','','L-1','1.2','100','','','']],{sysMap:{layher:'skip'}});assert.equal(skipped.rows[0].action,'skip');assert.match(skipped.rows[0].reason,/skipped/);
  const none=miPlan([['Name'],['Ledger']],{header:0,map:{...miGuessMap(['Name']).map}},CAT,SYS);assert.equal(none.rows[0].action,'error');assert.equal(none.unknown[0].key,'');
});

test('miPlan finds duplicates in the paste and in the catalogue (by reference or name + system) and follows skip / update',()=>{
  const rows=[['Ledger 2 m','Quickstage','','','12.5','','','',''],['Brace','Quickstage','','QS-B1','4','20','','',''],['Old transom','Quickstage','','','1','','','',''],['New ledger','Quickstage','','N-1','5','','','',''],['New ledger','QS','','','6','','','','']];
  const skip=plan(rows);assert.deepEqual(skip.rows.map(e=>e.action),['skip','skip','skip','add','skip']);
  assert.match(skip.rows[0].reason,/Already in your catalogue as "Ledger 2 m"/);assert.equal(skip.rows[1].dup.id,'p2','matched by reference despite another name');assert.match(skip.rows[2].reason,/retired/);assert.match(skip.rows[4].reason,/Same component as row 5/);
  assert.equal(skip.counts.dupCatalogue,3);assert.equal(skip.counts.dupPaste,1);
  const up=plan(rows,{dupDefault:'update',decisions:{6:'update'}});assert.deepEqual(up.rows.map(e=>e.action),['update','update','skip','skip','add']);
  assert.equal(up.rows[0].target,'p1');assert.match(up.rows[3].reason,/Replaced by row 6/);assert.equal(up.rows[4].g,6000);
  const same=plan([['Brace bay','Quickstage','','','4','','','','']],{dupDefault:'update'});assert.equal(same.rows[0].action,'skip');assert.match(same.rows[0].reason,/already has these figures/);
  const empty=plan([['Brace bay','Quickstage','','','','','','','']],{dupDefault:'update'});assert.match(empty.rows[0].reason,/Nothing to update/);
  const one=plan([['Brace bay','Quickstage','','','','20','','',''],['Brace bay','QS','','','','30','','','']],{dupDefault:'update'});assert.deepEqual(one.rows.map(e=>e.action),['skip','update'],'two updates of one component: the later row wins');
  const perRow=plan(rows,{dupDefault:'update',decisions:{2:'skip'}});assert.equal(perRow.rows[0].action,'skip');assert.equal(perRow.rows[1].action,'update');
});

test('miProduct and miUpdate build the command inputs; miBatches keeps every request under 16 KB and 100 products',()=>{
  const p=plan([['Pig tail pin','AT-PAC','Accessories','35.02.000.00','0.06','5000','Source verified','AT-PAC catalogue','32']]).rows[0];
  assert.deepEqual(miProduct(p,'list.csv'),{name:'Pig tail pin',system:'at-pac',category:'Accessories',reference:'35.02.000.00',manufacturer:'Not specified',region:'Not specified',unitWeight:60,packQuantity:5000,verification:'SOURCE VERIFIED',document:'AT-PAC catalogue',page:32,limitations:'Entered by the company through the Materials import (list.csv).'});
  const q=plan([['Ledger','QS','','','','','','','']]).rows[0];assert.equal(miProduct(q,'x.csv').document,'Company import — x.csv');assert.equal(miProduct(q).unitWeight,null);
  assert.deepEqual(miUpdate({g:2000,pack:null,document:'Datasheet',page:'4'},{id:'p2',unitWeight:4000,packQuantity:25}),{product:'p2',unitWeight:2000,packQuantity:25,sourceNote:'Datasheet, page 4',reason:'Updated by the materials import'});
  assert.equal(miUpdate({g:null,pack:9,document:''},{id:'p1',unitWeight:null,packQuantity:50},'f.csv').sourceNote,'Materials import (f.csv)');
  const long=i=>({name:'Ledger with a long descriptive name — '+i+' '+'x'.repeat(180),system:'at-pac',category:'Ledgers / horizontals',reference:'REF-'+i,manufacturer:'AT-PAC (Atlantic Pacific Equipment)',region:'North America',unitWeight:12345,packQuantity:50,verification:'SOURCE VERIFIED',document:'AT-PAC Product Catalog — North America (1-NA_ProductCatalog.pdf)',page:32,limitations:'Entered by the company through the Materials import (live.csv).'});
  const list=[...Array(1050).keys()].map(long),name='Materials import — live.csv 2026-09-26 — part 999 of 999',batches=miBatches(list,{name});
  assert.deepEqual(batches.flat(),list,'every product once, in order');for(const b of batches){assert.ok(b.length<=100);assert.ok(new TextEncoder().encode(JSON.stringify({name,products:b})).length<16384);}
  const small=miBatches([...Array(250).keys()].map(i=>({name:'P'+i})),{name:'x'});assert.deepEqual(small.map(b=>b.length),[100,100,50]);assert.deepEqual(miBatches([]),[]);
});

test('miFixValues checks the fixer inputs and keeps the figure left blank',()=>{
  const p={id:'p1',unitWeight:null,packQuantity:50};
  assert.match(miFixValues(p,{}).error,/weight or a pack size/);assert.match(miFixValues(p,{w:'12.5'}).error,/Source \/ note/);assert.match(miFixValues(p,{w:'abc',s:'x'}).error,/not a number/);assert.match(miFixValues(p,{k:'2.5',s:'x'}).error,/whole number/);
  assert.deepEqual(miFixValues(p,{w:'12.5',s:' Datasheet p.4 '}).input,{product:'p1',unitWeight:12500,packQuantity:50,sourceNote:'Datasheet p.4',reason:'Missing figures entered on the Materials list. Source: Datasheet p.4'});
  assert.equal(miFixValues(p,{w:'850 g'},'Weighed in the yard').input.unitWeight,850);assert.equal(miFixValues(p,{w:'850 g'},'Weighed in the yard').input.sourceNote,'Weighed in the yard');
  assert.equal(miFixValues(p,{w:'1500',s:'x'}).warning,'Over 1 tonne each: is the weight in grams?');assert.match(miFixValues(p,{w:'1',s:'y'.repeat(201)}).error,/under 200/);
});

test('the Materials page draws the import card and the fixer for owners only, the fixer entry under Missing figures only, company figures on tiles, no inline styles',()=>{
  const account={permissions:['operations.manage','stock.adjust'],systems:SYS,users:[],company:{id:'mi-co',name:'Demo'},user:{id:'u'}};
  const P=(id,o={})=>({id,name:'Part '+id,system:'quickstage',category:'Ledgers / horizontals',manufacturer:'Maker',reference:'R-'+id,unitWeight:1000,packQuantity:50,verification:'DEMO ONLY',...o});
  const state={config:{paused:false},yards:[{id:'y',name:'Main yard'}],sites:[],trucks:[],containers:[],balances:[],tasks:[],resources:[],notifications:[],register:[],products:[P('a',{figuresStatus:'COMPANY CONFIGURED',figuresSource:'Weighed <on site>'}),P('b',{unitWeight:null,name:'Odd <fitting>'}),P('c',{packQuantity:null})]};
  __test.setState(state,account);__test.setView('MATERIALS');miReset();let html=materialsView();
  for(const sel of ['id="mi-import"','id="mi-text"','id="mi-file"','id="mi-template"','download="materials-import-template.csv"','data-mi-act="read"','Import materials'])assert.ok(html.includes(sel),sel);
  assert.ok(!html.includes('id="mi-fix"'),'the fixer opens on demand');assert.ok(!html.includes('mi-callout'),'no fixer entry until Missing figures only is on');
  assert.match(html,/<span class="ml-ver co" title="Weight \/ pack entered by your company: Weighed &lt;on site&gt;">Company figures<\/span>/);
  assert.equal(miGapsCallout({gaps:2}),'','the callout follows the Missing figures only filter');
  const {mi,miFix}=miState();miFix.open=true;miFix.draft.set('b',{w:'2.5'});html=materialsView();
  assert.match(html,/id="mi-fix"/);assert.match(html,/data-mi-fix-row="b"/);assert.match(html,/data-mi-fix-row="c"/);assert.ok(!/data-mi-fix-row="a"/.test(html),'complete components are not listed');
  assert.match(html,/id="mi-w-b"[^>]*value="2.5"/,'drafts survive a rebuild');assert.match(html,/id="mi-k-c"/);assert.ok(!html.includes('id="mi-k-b"'),'only the missing figure gets a box');assert.ok(!html.includes('<fitting>'));
  assert.match(html,/Save all filled rows <b>1<\/b>/);
  mi.step='map';mi.text='Name,System,Weight (g)\nLedger,QS,850';mi.rows=miParseRows(mi.text,',');mi.header=0;const guess=miGuessMap(mi.rows[0]);mi.map=guess.map;mi.unit=guess.unit;html=miImportPanel();
  assert.match(html,/id="mi-map-name"/);assert.match(html,/id="mi-delim"/);assert.match(html,/id="mi-header"/);assert.match(html,/aria-current="step"/);
  mi.step='check';html=miImportPanel();assert.match(html,/Import 1 new/);assert.match(html,/class="mi-row add"/);assert.match(html,/<span class="ml-fig wt">0\.85 kg<\/span>/,'grams from the header');
  for(const h of [materialsView(),miImportPanel(),miFixPanel()])assert.ok(!/ style="/.test(h),'no inline style attributes');
  account.permissions=['stock.adjust'];account.user={id:'stock-only'};html=materialsView();assert.ok(!html.includes('id="mi-import"'),'no import without operations.manage');assert.ok(!html.includes('id="mi-fix"'));
  miReset();
});

const password='demonstration-password';
function world(t){const db=openDatabase(':memory:');t.after(()=>db.close());const auth=new Service(db);const email=randomUUID()+'@example.com';
  const user=auth.authenticate(auth.register({name:'Owner',companyName:'Import',email,password,systems:['quickstage','at-pac']}));const sim=new Simulation(db,user),cmd=(action,input={})=>sim.execute(action,input,randomUUID());return {db,auth,user,sim,cmd,email};}

test('override keeps a source note, and effective products say which figures the company entered (cache and fallback agree)',t=>{
  const f=world(t),products=f.cmd('seed'),id=products[0].id;
  assert.ok(!('figuresStatus' in f.sim.effectiveProducts()[0]),'no company settings: no figures fields');
  f.cmd('override',{product:id,unitWeight:12500,packQuantity:40,sourceNote:'Supplier datasheet, page 12',reason:'Missing figures entered'});
  const p=f.sim.effectiveProducts().find(x=>x.id===id);assert.equal(p.unitWeight,12500);assert.equal(p.packQuantity,40);assert.equal(p.figuresStatus,'COMPANY CONFIGURED');assert.equal(p.figuresSource,'Supplier datasheet, page 12');assert.equal(p.verification,'DEMO ONLY','the product itself stays demo');
  assert.deepEqual(f.sim.effectiveProducts(),computeEffectiveProducts(f.sim.repo));f.sim.catalogueBypass=true;assert.deepEqual(f.sim.effective(id),p);f.sim.catalogueBypass=false;
  f.cmd('override',{product:id,unitWeight:12000,reason:'Weighed again'});assert.equal(f.sim.effective(id).figuresSource,null,'a later override without a note clears it');
  f.cmd('override',{product:id,unitWeight:12000,sourceNote:'',reason:'Blank note'});assert.equal(f.sim.effective(id).figuresSource,null);
  assert.throws(()=>f.cmd('override',{product:id,unitWeight:1,sourceNote:'x'.repeat(251),reason:'Too long'}),/Source note/);
  assert.throws(()=>f.cmd('override',{product:id,unitWeight:1,sourceNote:42,reason:'Not text'}),/Source note/);
  const row=f.db.prepare("SELECT reason FROM ledger WHERE event='PRODUCT_OVERRIDE' ORDER BY rowid LIMIT 1").get();assert.equal(row.reason,'Missing figures entered');
});

test('a 1,000-row import planned in the browser goes through the real server in batches under the 16 KB limit, and a bad row is found one by one',async t=>{
  const f=world(t),server=createApp(f.db);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const token=f.auth.login({email:f.email,password});
  const post=async(action,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/commands/${action}`,{method:'POST',headers:{cookie:'session='+token,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const head=['Item code','Description','System','Category','Unit weight (kg)','Qty per stillage','Verification','Source document','Source page','Manufacturer','Region'];
  const rows=[head,...[...Array(1000).keys()].map(i=>['AP-'+String(i).padStart(4,'0'),'Ringlock ledger "heavy", '+(0.5+i/100).toFixed(2)+' m — batch '+i,i%2?'AT-PAC':'Quickstage','Ledgers / horizontals',(2+i/100).toFixed(2),i%3?'50':'','Source verified','AT-PAC Product Catalog — North America (1-NA_ProductCatalog.pdf)','32','AT-PAC (Atlantic Pacific Equipment)','North America'])];
  const text=rows.map(r=>r.map(c=>/[",\n]/.test(c)?'"'+c.replace(/"/g,'""')+'"':c).join(',')).join('\r\n'),parsed=miParseRows(text,miSniff(text));
  const h=miFindHeader(parsed),p=miPlan(parsed,{header:h,map:miGuessMap(parsed[h]).map,unit:'kg'},[],SYS.slice(0,2));assert.equal(p.counts.add,1000);assert.equal(p.rows[0].name,'Ringlock ledger "heavy", 0.50 m — batch 0');
  const products=p.rows.map(e=>miProduct(e,'big.csv')),name='Materials import — big.csv — part 999 of 999',batches=miBatches(products,{name});assert.ok(batches.length>=10,'about 30 products a batch');
  const tooBig=await post('importCatalogue',{name:'all at once',products:products.slice(0,100)});assert.equal(tooBig.status,413,'100 real rows in one request are over 16 KB');
  for(const b of batches){const r=await post('importCatalogue',{name,products:b});assert.equal(r.status,200,r.body.error);assert.equal(r.body.products.length,b.length);}
  const live=f.sim.effectiveProducts();assert.equal(live.length,1000);const one=live.find(x=>x.reference==='AP-0100');assert.equal(one.unitWeight,3000);assert.equal(one.packQuantity,50);assert.equal(one.verification,'SOURCE VERIFIED');
  // Imported again: every row is now a catalogue duplicate; the owner updates the figures of a few.
  const again=miPlan(parsed,{header:h,map:miGuessMap(parsed[h]).map,unit:'kg',dupDefault:'skip'},live,SYS.slice(0,2));assert.equal(again.counts.skip,1000);
  const bad=[miProduct(p.rows[0],'x.csv'),{...miProduct(p.rows[1],'x.csv'),reference:'NEW-1'}];const whole=await post('importCatalogue',{name:'mixed',products:bad});assert.equal(whole.status,409,'a batch is all or nothing');assert.match(whole.body.error,/already exists/);
  const single=await post('importCatalogue',{name:'row 3',products:[bad[1]]});assert.equal(single.status,200);
});

test('the weight header names its unit anywhere (g / kg as a word); pounds, ounces and tonnes are refused until the owner chooses',()=>{
  for(const h of ['Weight g','Weight [g]','Weight, g','Weight/g','Unit weight g','Weight (g)','Weight in grams','Gewicht (gr)'])assert.equal(miHeadUnit(h),'g',h);
  for(const h of ['Unit weight (kg)','Weight kg/pc','Kg per piece','Weight (kgs)','kilograms'])assert.equal(miHeadUnit(h),'kg',h);
  assert.equal(miHeadUnit('Weight (lb)'),'lb');assert.equal(miHeadUnit('Weight lbs'),'lb');assert.equal(miHeadUnit('Weight (oz)'),'oz');assert.equal(miHeadUnit('Weight (t)'),'t');assert.equal(miHeadUnit('Weight tonnes'),'t');
  assert.equal(miHeadUnit('Weight'),null);assert.equal(miHeadUnit('Weight kg or g'),null,'both: not sure');assert.equal(miHeadUnit('Gauge'),null);
  for(const h of ['Weight g','Weight/g','Kg per piece'])assert.equal(miHeaderField(h),'weight',h);
  assert.equal(miGuessMap(['Name','System','Weight g']).unit,'g','a gram header is not read as kg');assert.equal(miGuessMap(['Name','System','Weight (lb)']).unit,'lb');
  // With the unit not chosen ('') or foreign, a bare number is refused rather than read as kg; a unit written in the cell still wins.
  assert.match(miWeight('22','').error,/Choose whether the weights are in kg or g/);assert.match(miWeight('22','lb').error,/pounds/);assert.deepEqual(miWeight('850 g',''),{g:850});
  for(const [v,w] of [['3 oz','ounces'],['2 t','tonnes'],['1.5 tonnes','tonnes'],['4 lbs','pounds']])assert.match(miWeight(v,'kg').error,new RegExp(w),v);
  assert.equal(miWeight('850','kg').warning,'Over 150 kg for one piece: is the weight in grams?','grams read as kg are flagged');assert.equal(miWeight('103.03','kg').warning,undefined,'the heaviest real girder is not');
  const p=miPlan([['Name','System','Weight (lb)'],['Tube','QS','22']],{header:0,map:miGuessMap(['Name','System','Weight (lb)']).map,unit:''},[],SYS);assert.equal(p.rows[0].action,'error');
});

test('a whole-pack weight column is never taken as the unit weight; a header that says one piece wins',()=>{
  const g=miGuessMap(['Name','System','Pack weight (kg)','Unit weight (kg)','Pack qty']);assert.equal(g.map.weight,3);assert.equal(g.map.pack,4);assert.match(g.notes[0],/“Pack weight \(kg\)” looks like the weight of a whole pack/);
  assert.equal(miGuessMap(['Name','System','Gross weight','Weight each (kg)']).map.weight,3);
  const only=miGuessMap(['Name','System','Total weight (kg)','Qty']);assert.equal(only.map.weight,-1,'only a pack weight: the owner picks');assert.equal(only.notes.length,1);
  const two=miGuessMap(['Name','System','Weight (kg)','Weight per piece (kg)']);assert.equal(two.map.weight,3,'per piece wins');assert.match(two.notes[0],/another weight column/);
  assert.equal(miGuessMap(['Name','System','Kg per piece','Pieces per stillage']).map.weight,2);
  const heavy=miPlan([['Name','System','Weight (kg)','Pack'],['Ledger','QS','520','20'],['Girder','QS','93','20']],{header:0,map:miGuessMap(['Name','System','Weight (kg)','Pack']).map,unit:'kg'},[],SYS);
  assert.match(heavy.rows[0].warnings.join(),/A full stillage of 20 would weigh 10\.4 t: is the weight for one piece\?/);assert.ok(!heavy.rows[1].warnings.some(w=>/full stillage/.test(w)),'a real 1.9 t stillage of girders is fine');
});

test('duplicates follow the server key (reference + manufacturer + region); made-up references never collide',()=>{
  const head=['Name','System','Reference','Manufacturer','Weight (kg)'],cfg={header:0,map:miGuessMap(head).map,unit:'kg'};
  const makers=miPlan([head,['Ledger 1 m','QS','L-100','MakerA','5'],['Ledger 1 m','QS','L-100','MakerB','5.2']],cfg,[],SYS);assert.deepEqual(makers.rows.map(e=>e.action),['add','add'],'one maker’s L-100 is not another’s');
  const same=miPlan([head,['Ledger','QS','L-100','MakerA','5'],['Ledger again','QS','L-100','makera','5']],cfg,[],SYS);assert.equal(same.rows[1].action,'skip');assert.match(same.rows[1].reason,/Same component as row 2/);
  const cat=[{id:'p1',name:'Ledger 1 m',system:'quickstage',reference:'L-100',manufacturer:'MakerA',region:'Not specified',unitWeight:5000,packQuantity:null}];
  const other=miPlan([head,['Ledger 1 m','QS','L-100','MakerB','9']],{...cfg,dupDefault:'update'},cat,SYS);assert.equal(other.rows[0].action,'add','never updates another maker’s product');
  const mine=miPlan([head,['Ledger 1 m','QS','L-100','MakerA','9']],{...cfg,dupDefault:'update'},cat,SYS);assert.equal(mine.rows[0].action,'update');assert.equal(mine.rows[0].target,'p1');
  const noMaker=miPlan([['Name','System','Reference','Weight (kg)'],['Something','QS','L-100','9']],{header:0,map:miGuessMap(['Name','System','Reference','Weight (kg)']).map,unit:'kg',dupDefault:'skip'},cat,SYS);assert.equal(noMaker.rows[0].action,'skip','no maker given: the reference alone still matches');
  // Long names alike in their first 40 characters get different references; a made-up reference already taken gets a counter.
  const a='Quickstage ledger 2.4 m heavy duty galvanised with wedge type A',b=a.replace(/A$/,'B');assert.notEqual(miNoRef(a,'quickstage'),miNoRef(b,'quickstage'));assert.equal(miNoRef('Tube 6 m','tube-clip'),'NOREF-TUBE-CLIP-TUBE-6-M');assert.ok(miNoRef(a,'quickstage').length<=60);
  const long=miPlan([['Name','System'],[a,'QS'],[b,'QS']],{header:0,map:miGuessMap(['Name','System']).map,unit:'kg'},[],SYS);assert.deepEqual(long.rows.map(e=>e.action),['add','add']);assert.notEqual(long.rows[0].reference,long.rows[1].reference);
  const taken=[{id:'x',name:'Other name',system:'quickstage',reference:'NOREF-QUICKSTAGE-TUBE',manufacturer:'Not specified',region:'Not specified'}];
  const clash=miPlan([['Name','System'],['Tube','QS']],{header:0,map:miGuessMap(['Name','System']).map,unit:'kg'},taken,SYS);assert.equal(clash.rows[0].action,'add');assert.equal(clash.rows[0].reference,'NOREF-QUICKSTAGE-TUBE-2');assert.match(clash.rows[0].warnings.join(),/saved as NOREF-QUICKSTAGE-TUBE-2/);
});

test('a bad weight or pack cell can be corrected or left blank in the check step (noted against what the file says)',()=>{
  const head=['Name','System','Weight','Pack'],base={header:0,map:miGuessMap(head).map,unit:'kg'},rows=[head,['Clamp','QS','3.5 lb','2.5']];
  const bad=miPlan(rows,base,[],SYS).rows[0];assert.equal(bad.action,'error');assert.deepEqual(bad.bad,{weight:'3.5 lb',pack:'2.5'});
  const fixed=miPlan(rows,{...base,edits:{2:{weight:'1.6',pack:''}}},[],SYS).rows[0];assert.equal(fixed.action,'add');assert.equal(fixed.g,1600);assert.equal(fixed.pack,null);
  assert.match(fixed.warnings.join('|'),/Weight corrected here to "1\.6" \(your file says "3\.5 lb"\)/);assert.match(fixed.warnings.join('|'),/Pack quantity left blank \(your file says "2\.5"\)/);
  const account={permissions:['operations.manage'],systems:SYS,users:[],company:{id:'e'},user:{id:'u'}};__test.setState({products:[],yards:[],sites:[]},account);miReset();const {mi}=miState();Object.assign(mi,{step:'check',rows,header:0,map:base.map,unit:'kg'});const html=miImportPanel();miReset();
  assert.match(html,/data-mi-edit="weight" data-mi-line="2" value="3\.5 lb"/);assert.match(html,/data-mi-act="blank" data-mi-f="pack" data-mi-line="2"/);assert.match(html,/0 new &middot; 0 updates &middot; 0 skipped &middot; 1 to fix/);assert.match(html,/data-mi-v="error"[^>]*>To fix<small>1/);
});

test('the map step: a one-line summary when the columns are matched; the wrong separator and a foreign unit block the check',()=>{
  const account={permissions:['operations.manage'],systems:SYS,users:[],company:{id:'m'},user:{id:'u'}};__test.setState({products:[],yards:[],sites:[]},account);miReset();const {mi}=miState();
  const go=(text,delim='auto')=>{const d=delim==='auto'?miSniff(text):{comma:',',pipe:'|'}[delim],rows=miParseRows(text,d),header=miFindHeader(rows),g=header>=0?miGuessMap(rows[header]):{map:miGuessByContent(rows,SYS).map,unit:null,notes:[]};Object.assign(mi,{step:'map',text,delim,used:d,rows,header,map:g.map,unitAuto:g.unit,unit:g.unit==='kg'||g.unit==='g'?g.unit:g.unit?'':'kg',mapNotes:g.notes,mapOpen:false});return miImportPanel();};
  let html=go('Name,System,Unit weight (kg),Pack\nLedger,QS,5,50');assert.match(html,/We matched 4 columns from your header row/);assert.match(html,/<div id="mi-map-grid" hidden>/);assert.doesNotMatch(html,/id="mi-check"[^>]*disabled/);assert.match(html,/The grey text under each box is your first row/);
  html=go('Name,System,Weight\nLedger,QS,5');assert.match(html,/doesn&rsquo;t say kg or g/);
  html=go('Name,System,Weight (lb)\nLedger,QS,22');assert.match(html,/is in pounds/);assert.match(html,/id="mi-check"[^>]*disabled/);assert.match(html,/<option value="" selected>Choose kg or g…/);
  html=go('Name,System,Weight\nLedger,QS,5','pipe');assert.match(html,/Your rows look like they use <b>commas<\/b>/);assert.match(html,/data-mi-act="delim" data-mi-v="comma"/);assert.match(html,/id="mi-check"[^>]*disabled/);assert.match(html,/<div id="mi-map-grid">/,'not matched: the columns are shown');
  html=go('Name,System,Pack weight (kg),Unit weight (kg)\nLedger,QS,520,26');assert.match(html,/looks like the weight of a whole pack/);
  miReset();
});

test('override keeps a source per figure and the spanner size it is not given',t=>{
  const f=world(t),id=f.cmd('seed')[0].id,before=f.sim.effective(id);
  f.cmd('override',{product:id,unitWeight:12500,packQuantity:before.packQuantity,spannerSize:170,sourceNote:'Datasheet p.4',reason:'Weight'});
  let p=f.sim.effective(id);assert.equal(p.figuresSource,'Weight: Datasheet p.4','only the weight changed, so only it takes the note');
  f.cmd('override',{product:id,unitWeight:12500,packQuantity:40,sourceNote:'Delivery note 118',reason:'Pack'});p=f.sim.effective(id);
  assert.equal(p.figuresSource,'Weight: Datasheet p.4 · Pack: Delivery note 118','saving the pack later keeps the weight’s source');assert.equal(p.unitWeight,12500);assert.equal(p.packQuantity,40);
  assert.equal(f.sim.repo.all('productSettings').find(s=>s.product===id).spannerSize,170,'an override without spannerSize keeps it');
  f.cmd('override',{product:id,unitWeight:13000,packQuantity:40,sourceNote:'Weighed 2026-09-26',reason:'Both'});assert.equal(f.sim.effective(id).figuresSource,'Weight: Weighed 2026-09-26 · Pack: Delivery note 118');
  f.cmd('override',{product:id,unitWeight:9000,packQuantity:30,sourceNote:'New datasheet',reason:'Both'});assert.equal(f.sim.effective(id).figuresSource,'New datasheet','one note for both figures reads once');
  assert.deepEqual(f.sim.effectiveProducts(),computeEffectiveProducts(f.sim.repo),'cache and fallback agree');
});

test('the fixer rows: the same labelled columns on every row, no example numbers in the boxes, Save only once something is typed',()=>{
  const account={permissions:['operations.manage','stock.adjust'],systems:SYS,users:[],company:{id:'fx'},user:{id:'u'}};
  const P=(id,o={})=>({id,name:'Part '+id,system:'quickstage',category:'Ledgers / horizontals',manufacturer:'Maker',reference:'R-'+id,unitWeight:1000,packQuantity:50,verification:'DEMO ONLY',...o});
  __test.setState({config:{paused:false},yards:[{id:'y',name:'Main yard'}],sites:[],trucks:[],containers:[],balances:[],tasks:[],resources:[],notifications:[],register:[],products:[P('b',{unitWeight:null}),P('c',{packQuantity:null})]},account);__test.setView('MATERIALS');miReset();
  const {miFix}=miState();miFix.open=true;miFix.draft.set('c',{k:'40'});const html=miFixPanel();
  for(const id of ['b','c']){const row=html.match(new RegExp('<li class="mi-fix-row[^"]*" data-mi-fix-row="'+id+'"[\\s\\S]*?</li>'))[0];for(const l of ['Weight, kg','Pieces per stillage','Source / note'])assert.ok(row.includes('<span class="mi-fld-l">'+l+'</span>'),id+' '+l);}
  assert.doesNotMatch(html,/placeholder="e\.g\. \d/,'no example figure in any box');assert.doesNotMatch(html,/data-mi-fix="[wk]"[^>]*placeholder/);
  assert.match(html,/<li class="mi-fix-row" data-mi-fix-row="b"/,'nothing typed: no has-input');assert.match(html,/<li class="mi-fix-row has-input" data-mi-fix-row="c"/);
  assert.match(html,/<span class="mi-known">1 kg<\/span>/,'a known figure is text in its column');miReset();
});
