import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './simulation.test.js';
import { kg, num } from '../public/visual.js';
import { stopOperations } from '../public/operations.js';
// Browser-side efficiency changes: shared formatters and collators, the per-key change check, the catalogue cache, the poll cadence and the memoised stockpile.
const load=async()=>(await import('../public/operations.js')).__test;
const account=(f,company='c')=>({permissions:['operations.manage','stock.adjust','requests.create'],systems:[{id:'quickstage',name:'Quickstage',enabled:true}],users:[],company:{id:company,name:'Demo'},user:{id:f.user.id}});

test('kg() and num() give exactly what toLocaleString gave',()=>{
  for(const v of [0,1,999,1000,1234,12345.678,1500000,2000000,12500000,-2500,0.4,7,99999999])assert.equal(kg(v),`${(v/1000).toLocaleString(undefined,{maximumFractionDigits:3})} kg`);
  assert.equal(kg(null),'Unknown');assert.equal(kg(undefined),'Unknown');
  for(const v of [0,5,999,1000,123456,9876543,-42])assert.equal(num(v),v.toLocaleString());});

test('a shared numeric collator orders names exactly like localeCompare (the stockpile keeps its tile order)',async t=>{const f=fixture(t),T=await load();const s=f.sim.snapshot();
  const names=s.products.map(p=>p.name).concat(['Tube 10ft','Tube 2ft','Tube 21ft','ledger 1.0m','Ledger 1.0m','Ledger 0.7m','Brace 13']);
  const coll=new Intl.Collator(undefined,{numeric:true});assert.deepEqual([...names].sort(coll.compare),[...names].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})));
  T.setState(s,account(f));T.setStep(1);T.setGridSearch({});const html=T.stockpile();
  const expected=s.products.filter(p=>!p.retired&&p.system==='quickstage'&&!['Accessories','Tools','Other'].includes(p.category)).sort((a,b)=>(a.category??'').localeCompare(b.category??'')||a.name.localeCompare(b.name,undefined,{numeric:true})).map(p=>p.id);
  const grid=html.slice(html.indexOf('data-grid="quickstage"'),html.indexOf('data-grid="tube-clip"'));const order=[...grid.matchAll(/data-tile="([^"]+)"/g)].map(m=>m[1]);
  assert.ok(order.length>0,'the Quickstage grid has tiles');assert.deepEqual(order,expected);});

test('the stockpile tiles are memoised but follow every count, step and search change',async t=>{const f=fixture(t),T=await load();const s=f.sim.snapshot(),a=account(f);T.setState(s,a);T.setStep(1);T.setGridSearch({});
  const first=T.stockpile();assert.equal(T.stockpile(),first,'same inputs, same HTML');
  const row=s.register.find(r=>r.yard>0);assert.ok(row,'the fixture has stock in the yard');
  T.setState({...s,register:s.register.map(r=>r===row?{...r,yard:r.yard+7}:r)},a);const moved=T.stockpile();assert.notEqual(moved,first);assert.ok(moved.includes('<b class="tile-count">'+(row.yard+7)+'</b>'),'the new count is shown');
  T.setState({...s,register:s.register.map(r=>({...r}))},a);assert.equal(T.stockpile(),first,'back to the same counts, same HTML');
  T.setStep(-5);const removing=T.stockpile();assert.ok(removing.includes('tile-grid removing'));assert.ok(removing.includes(' disabled>'),'empty tiles cannot be taken from');
  T.setStep(1);T.setGridSearch({quickstage:'ledger'});assert.ok(T.stockpile().includes('value="ledger"'));T.setGridSearch({});
  T.setState({...s,products:s.products.map(p=>({...p}))},a);assert.equal(T.stockpile(),first,'a fresh catalogue copy renders the same tiles');});

test('the change check is per key: timers, progress and versions never count; positions only count on the plan views; the catalogue compares by revision',async()=>{const T=await load();
  const a={resources:[{id:'w',x:1,y:2,progress:10,version:3,board:{now:{progress:5}}}],jobs:[{id:'j',cooldownSeconds:4,remainingMs:9}],products:[{id:'p',name:'A'}],catalogueRev:'r1'};
  const b={resources:[{id:'w',x:5,y:2,progress:80,version:9,board:{now:{progress:60}}}],jobs:[{id:'j',cooldownSeconds:1,remainingMs:2}],products:[{id:'p',name:'B'}],catalogueRev:'r1'};
  assert.deepEqual([...T.changedKeys(T.projectionMap(a,false),T.projectionMap(b,false))],[],'off the plan a walk step is not a change');
  assert.deepEqual([...T.changedKeys(T.projectionMap(a,true),T.projectionMap(b,true))],['resources'],'on HOME / YARD it is');
  assert.deepEqual([...T.changedKeys(T.projectionMap(a,false),T.projectionMap({...b,catalogueRev:'r2'},false))].sort(),['catalogueRev','products']);
  const {products,...lean}=b;assert.deepEqual([...T.changedKeys(T.projectionMap({...lean,catalogueRev:undefined,products:[1]},false),T.projectionMap({...lean,catalogueRev:undefined,products:[2]},false))],['products'],'without a revision the catalogue is compared by content');
  assert.deepEqual([...T.changedKeys(T.projectionMap({x:1,a:1},true),T.projectionMap({a:1,b:2},true))].sort(),['b','x'],'added and removed keys count');});

test('the catalogue is fetched once per revision and dropped on a page, company or user change and on leaving Operations',async t=>{const f=fixture(t),T=await load();const s=f.sim.snapshot(),a=account(f);const calls=[];let rev='r1',many=false;
  const api=async path=>{calls.push(path);const q=new URLSearchParams(path.split('?')[1]);const out={...s,containerCount:many?250:s.containerCount,catalogueRev:rev,products:s.products.map(p=>({...p}))};if(q.get('catalogue')===rev)delete out.products;return out;};
  T.setState(s,a);T.wire({live:true,api});t.after(()=>{stopOperations();T.wire({live:false});T.containerPage(0);});
  await T.refresh(true);assert.equal(calls.at(-1),'state?page=0','no cached catalogue yet');const products=T.state().products;assert.equal(products.length,s.products.length);
  await T.refresh(false);assert.equal(calls.at(-1),'state?page=0&catalogue=r1');assert.equal(T.state().products,products,'an omitted catalogue keeps the cached array');
  rev='r2';await T.refresh(false);assert.equal(calls.at(-1),'state?page=0&catalogue=r1');assert.notEqual(T.state().products,products,'a new revision brings the new catalogue');assert.equal(T.catalogue().rev,'r2');
  await T.refresh(false);assert.equal(calls.at(-1),'state?page=0&catalogue=r2');
  many=true;T.containerPage(1);await T.refresh(true);assert.equal(calls.at(-1),'state?page=1','a page change starts from a full copy');assert.ok(Array.isArray(T.state().products));
  await T.refresh(false);assert.equal(calls.at(-1),'state?page=1&catalogue=r2');
  T.setAccount(account(f,'other'));await T.refresh(false);assert.equal(calls.at(-1),'state?page=1','another company never uses the cached catalogue');
  T.setAccount({...a,user:{id:'someone-else'}});await T.refresh(false);assert.equal(calls.at(-1),'state?page=1','nor another user');
  stopOperations();assert.equal(T.catalogue(),null,'leaving Operations (sign-out, Account page) drops the cache');});

test('a server without catalogue revisions keeps working: products come every time and nothing is cached',async t=>{const f=fixture(t),T=await load();const s=f.sim.snapshot(),calls=[];T.setState(s,account(f));T.wire({live:true,api:async p=>{calls.push(p);return f.sim.snapshot();}});t.after(()=>{stopOperations();T.wire({live:false});});
  await T.refresh(true);await T.refresh(false);assert.deepEqual(calls,['state?page=0','state?page=0']);assert.equal(T.catalogue(),null);assert.ok(T.state().products.length>0);});

test('polls every second on Home, Yard, Workers and Overview, every 3 s elsewhere and while the shape editor is open',async t=>{const T=await load();t.after(()=>{T.setShapeEditor(null);T.setView('HOME');});
  for(const v of ['HOME','YARD','WORKERS','OVERVIEW']){T.setView(v);assert.equal(T.pollDelay(),1000,v);}
  for(const v of ['EQUIPMENT','TRUCK12','TRUCK2','STOCK','MATERIALS','SITES']){T.setView(v);assert.equal(T.pollDelay(),3000,v);}
  T.setView('YARD');T.setShapeEditor({destroy(){}});assert.equal(T.pollDelay(),3000,'shape editor open');});
