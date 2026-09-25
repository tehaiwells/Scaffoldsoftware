import test from 'node:test';
import assert from 'node:assert/strict';
import { mlSummary, mlGroups, mlStepQty, materialsView, __test } from '../public/operations.js';
// The Materials list page (catalogue + intake): the pure helpers behind its counters, groups and stepper, and the controls the page binds to. Runs in node with no DOM.
const P=(id,o={})=>({id,name:'Part '+id,system:'quickstage',category:'Ledgers / horizontals',manufacturer:'Maker',reference:'R-'+id,unitWeight:1000,packQuantity:50,verification:'SOURCE VERIFIED',...o});

test('mlSummary counts live components, missing weights and pack sizes, verification and systems',()=>{
  const s=mlSummary([P('a'),P('b',{unitWeight:null}),P('c',{packQuantity:null,system:'at-pac'}),P('d',{unitWeight:null,packQuantity:null,verification:'DEMO ONLY'}),P('e',{retired:true,unitWeight:null})]);
  assert.equal(s.total,4);assert.equal(s.noWeight,2);assert.equal(s.noPack,2);assert.equal(s.gaps,3,'a component missing both counts once');
  assert.equal(s.verified,3);assert.equal(s.demo,1);assert.deepEqual([...s.bySystem],[['quickstage',3],['at-pac',1]]);assert.deepEqual([...s.categories],['Ledgers / horizontals']);
});

test('mlGroups puts the usual scaffold categories first, others A-Z after, and keeps the order inside a group',()=>{
  const g=mlGroups([P('1',{category:'Tools'}),P('2',{category:'Zeta'}),P('3',{category:'Standards / verticals'}),P('4',{category:'Alpha'}),P('5',{category:'Tools'}),P('6',{category:''})]);
  assert.deepEqual(g.map(([c])=>c),['Standards / verticals','Tools','Other','Alpha','Zeta']);assert.deepEqual(g[1][1].map(p=>p.id),['1','5']);
});

test('mlStepQty steps to whole stillages and never below 1',()=>{
  assert.equal(mlStepQty(50,1,50),100);assert.equal(mlStepQty(50,-1,50),1);assert.equal(mlStepQty(1,1,50),50);assert.equal(mlStepQty(70,-1,50),50);assert.equal(mlStepQty(70,1,50),100);
  assert.equal(mlStepQty('',1,10),10);assert.equal(mlStepQty('abc',-1,10),1);assert.equal(mlStepQty(5,1,0),6,'no pack size steps by 1');
});

test('the Materials page keeps every control the page binds to, flags missing figures and has one h1',()=>{
  const account={permissions:['operations.manage','stock.adjust'],systems:[{id:'quickstage',name:'Quickstage',enabled:true},{id:'at-pac',name:'AT-PAC',enabled:true}],users:[],company:{id:'c',name:'Demo'},user:{id:'u'}};
  const state={config:{paused:false},yards:[{id:'y',name:'Main yard'}],sites:[],trucks:[],containers:[],balances:[],tasks:[],resources:[],notifications:[],register:[{product:'a',yard:30,site:5,truck:0,quantity:35}],products:[P('a'),P('b',{unitWeight:null,name:'Odd <fitting>'}),P('c',{system:'at-pac',packQuantity:null,verification:'DEMO ONLY'})]};
  __test.setState(state,account);__test.setView('MATERIALS');const html=materialsView();
  assert.equal((html.match(/<h1[ >]/g)??[]).length,1);assert.match(html,/<h1>Materials catalogue<\/h1>/);
  for(const id of ['ALL','quickstage','at-pac'])assert.ok(html.includes('data-component-tab="'+id+'"'),id);
  for(const id of ['quickstage','at-pac'])assert.ok(html.includes('data-intake-tab="'+id+'"'),id);
  for(const sel of ['id="intake"','id="intake-search"','id="intake-kind"','value="PURCHASE"','value="ORIGINAL"','data-intake-qty="a"','data-intake="a"','data-intake-row','id="ml-search"','data-ml-gaps','data-live-search'])assert.ok(html.includes(sel),sel);
  assert.ok(!html.includes('<fitting>'),'names are escaped');assert.match(html,/Weight unknown/);assert.match(html,/No pack size/);assert.match(html,/Demo only/);assert.match(html,/Source verified/);
  assert.match(html,/class="hud-stat ml-warn"/,'missing figures are flagged in the hero');
  assert.ok(!/ style="/.test(html),'no inline style attributes (the CSP blocks them)');
  state.products=[];const empty=materialsView();assert.match(empty,/Your catalogue is empty/);assert.match(empty,/No materials in this system yet/);
});

test('the Materials page uses no <details> (an open one pauses polling), pluralises its badges, keeps plain spaces in names and adapts to the role',()=>{
  const account={permissions:['operations.manage','stock.adjust'],systems:[{id:'quickstage',name:'Quickstage',enabled:true},{id:'tube-clip',name:'Tube & Clip',enabled:true}],users:[],company:{id:'c2',name:'Demo'},user:{id:'u'}};
  const state={config:{paused:false},yards:[{id:'y',name:'Main yard'}],sites:[],trucks:[],containers:[],balances:[],tasks:[],resources:[],notifications:[],register:[{product:'a',yard:30,site:5,truck:0,quantity:35}],
    products:[P('a',{name:'Ledger 0.7 m'}),P('b',{unitWeight:null}),P('t1',{system:'tube-clip',category:'Tube',packQuantity:null}),P('t2',{system:'tube-clip',category:'Tube',packQuantity:null})]};
  __test.setState(state,account);__test.setView('MATERIALS');const html=materialsView();
  assert.ok(!/<details|<summary/.test(html),'no details/summary');
  assert.match(html,/<button type="button" class="ml-group-head" data-ml-fold aria-expanded="(true|false)"/);
  assert.match(html,/<b>1<\/b><span class="ml-gap-word"> missing figure<\/span>/,'one gap reads "1 missing figure"');
  assert.ok(!html.includes('&nbsp;'),'no non-breaking spaces in names');assert.match(html,/<span class="ml-nw">0\.7 m<\/span>/);
  assert.match(html,/None of these 2 components has a pack size yet\./,'a figure missing on the whole group is said once');
  assert.match(html,/data-ml-row="t1"/);assert.ok(!/class="ml-item ml-g gap" data-ml-row="t1"/.test(html),'no amber outline when the whole group lacks it');assert.match(html,/class="ml-item ml-g gap" data-ml-row="b"/);
  assert.match(html,/href="#intake"/,'shortcut to intake');assert.match(html,/Pieces in yard/);
  account.permissions=['sites.view'];account.user={id:'sup'};const sup=materialsView();
  assert.match(sup,/At your sites/);assert.ok(!sup.includes('Pieces in yard'));assert.ok(!sup.includes('href="#intake"'),'no intake shortcut without stock.adjust');
});
