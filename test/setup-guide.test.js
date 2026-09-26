import test from 'node:test';
import assert from 'node:assert/strict';
import { sgSteps, SG_STILLAGES, __test } from '../public/operations.js';
import { fixture } from './simulation.test.js';
// The Home set-up guide: the pure step-status function (snapshot + account in, nine steps out) and who gets the card. Runs in node with no DOM.
const Y={id:'y1',name:'Main yard',points:[{x:0,y:0},{x:30000,y:0},{x:30000,y:20000},{x:0,y:20000}],shapeRev:1};
const ACCT={company:{id:'c1'},systems:[{id:'quickstage',enabled:true},{id:'at-pac',enabled:false}],permissions:['operations.manage','stock.adjust']};
const empty=(o={})=>({yards:[Y],resources:[],trucks:[],containers:[],balances:[],products:[],register:[],sites:[],loadLists:[],stockTotal:0,containerCount:0,...o});
const byId=g=>Object.fromEntries(g.steps.map(s=>[s.id,s]));
const stills=(n,prefix='S')=>Array.from({length:n},(_,i)=>({id:prefix+i,type:'STILLAGE',location:'y1'}));
const full=()=>empty({resources:[{id:'w',type:'WORKER',location:'y1'},{id:'f',type:'FORKLIFT',location:'y1'}],trucks:[{id:'t',yard:'y1',payload:12500000}],containers:stills(5),products:[{id:'p',system:'quickstage',verification:'SOURCE VERIFIED'}],register:[{product_id:'p',quantity:40}],sites:[{id:'s',status:'ACTIVE'}],loadLists:[{id:'l',neededOn:'2026-10-01'}]});

test('an emptied company (yard only, everything else removed) has only the yard step done, in the spec order',()=>{
  const g=sgSteps(empty(),ACCT);
  assert.deepEqual(g.steps.map(s=>s.id),['yard','crew','forklift','trucks','stillages','materials','stock','site','list']);
  assert.equal(g.total,9);assert.equal(g.done,1);assert.equal(g.complete,false);assert.equal(g.next,'crew');assert.equal(g.moving,false);
  const s=byId(g);assert.equal(s.yard.done,true);assert.equal(s.yard.detail,'30 × 20 m');
  for(const id of ['crew','forklift','trucks','stillages','materials','stock','site','list'])assert.equal(s[id].done,false,id);
  for(const x of g.steps)assert.ok(x.why.length>20,'every step says why in plain words: '+x.id);
});

test('the yard step needs a saved outline; no yard at all leaves every step open',()=>{
  assert.equal(byId(sgSteps(empty({yards:[{...Y,shapeRev:0}]}),ACCT)).yard.done,false,'never saved');
  assert.equal(byId(sgSteps(empty({yards:[{...Y,points:[{x:0,y:0}]}]}),ACCT)).yard.done,false,'no outline');
  const none=sgSteps(empty({yards:[]}),ACCT);assert.equal(none.done,0);assert.equal(byId(none).yard.detail,'No yard drawn yet');
  assert.equal(sgSteps(undefined,undefined).done,0,'no snapshot yet: nothing done, no throw');
});

test('crew, forklift and trucks count only what belongs to this yard',()=>{
  const g=byId(sgSteps(empty({resources:[{id:'w1',type:'WORKER',location:'site'},{id:'c',type:'CRANE',location:'site'},{id:'f',type:'FORKLIFT',location:'y1'}],trucks:[{id:'t',yard:'other',payload:12500000},{id:'r',yard:'y1',payload:2000000,retired:true}]}),ACCT));
  assert.equal(g.crew.done,false,'a site crew is not the yard crew');assert.equal(g.forklift.done,true);assert.equal(g.forklift.detail,'1 forklift');assert.equal(g.trucks.done,false,'another yard and retired trucks do not count');assert.equal(byId(sgSteps(empty({trucks:[{id:'l',yard:'y1',payload:2000000}]}),ACCT)).trucks.detail,'1 × 2 t','only the classes it has');
  const h=sgSteps(empty({resources:[{id:'w1',type:'WORKER',location:'y1'},{id:'w2',type:'WORKER',location:'y1'},{id:'f',type:'FORKLIFT',location:'y1'}],trucks:[{id:'a',yard:'y1',payload:12500000},{id:'b',yard:'y1',payload:2000000},{id:'c',yard:'y1',payload:2000000}]}),ACCT),s=byId(h);
  assert.equal(s.crew.detail,'2 workers on the yard');assert.equal(s.trucks.done,true);assert.equal(s.trucks.detail,'1 × 12.5 t · 2 × 2 t');assert.equal(h.moving,true);assert.equal(h.next,'stillages');
});

test('stillages: N empty ones before stock; once stock is on the books N in all is enough',()=>{
  assert.equal(SG_STILLAGES,5);
  const four=byId(sgSteps(empty({containers:stills(4)}),ACCT)).stillages;assert.equal(four.done,false);assert.equal(four.detail,'4 stillages · 4 empty');
  assert.equal(byId(sgSteps(empty({containers:[...stills(5),{id:'cage',type:'CAGE',location:'y1'},{id:'away',type:'STILLAGE',location:'site'}]}),ACCT)).stillages.done,true);
  const filled=empty({containers:stills(5),balances:[{container:'S0',quantity:10},{container:'S1',quantity:0}]});
  assert.equal(byId(sgSteps(filled,ACCT)).stillages.done,false,'4 empty and no stock recorded yet');
  const counted=byId(sgSteps({...filled,register:[{product_id:'p',quantity:10}]},ACCT));assert.equal(counted.stillages.done,true,'filling them with the opening stock does not undo the step');assert.equal(counted.stillages.detail,'5 stillages · 4 empty');
  assert.equal(byId(sgSteps(empty({containers:stills(1),containerCount:250}),ACCT)).stillages.done,true,'more than one page of containers: set up');
});

test('materials: real components in an enabled system; a demo-only list is not the real catalogue; missing figures are counted; stock and yard lists wait for their prerequisites',()=>{
  const off=byId(sgSteps(empty({products:[{id:'a',system:'at-pac'},{id:'b',system:'quickstage',retired:true}]}),ACCT));
  assert.equal(off.materials.done,false,'disabled system and retired parts do not count');assert.deepEqual(off.stock.needs,['materials']);assert.deepEqual(off.list.needs,['site','materials']);
  const demo=byId(sgSteps(empty({products:[{id:'a',system:'quickstage',verification:'DEMO ONLY'},{id:'b',system:'quickstage',verification:'DEMO ONLY'}]}),ACCT));
  assert.equal(demo.materials.done,false,'a DEMO-only list is made-up data, not the company catalogue');assert.equal(demo.materials.demoOnly,true);assert.equal(demo.materials.detail,'2 components · DEMO list only');assert.match(demo.materials.why,/demo list is made-up data/);assert.deepEqual(demo.stock.needs,[]);assert.deepEqual(demo.list.needs,['site']);
  const mixed=byId(sgSteps(empty({products:[{id:'a',system:'quickstage',verification:'DEMO ONLY'},{id:'b',system:'quickstage',verification:'SOURCE VERIFIED'}]}),ACCT));assert.equal(mixed.materials.detail,'2 components · 1 demo');assert.equal(mixed.materials.done,true,'one real component is enough');assert.equal(mixed.materials.demoOnly,false);assert.equal(mixed.materials.gaps,2,'neither has a weight or pack size');
  assert.equal(byId(sgSteps(empty({products:[{id:'a',system:'quickstage',verification:'COMPANY CONFIGURED',unitWeight:1000,packQuantity:50},{id:'b',system:'quickstage',verification:'COMPANY CONFIGURED',unitWeight:1000,packQuantity:null}]}),ACCT)).materials.gaps,1);
});

test('opening stock, first site and first dated yard list',()=>{
  const g=byId(sgSteps(empty({stockTotal:12,sites:[{id:'a',status:'ARCHIVED'}],loadLists:[{id:'l1'},{id:'l2',neededOn:'2026-10-01',cancelled:true}]}),ACCT));
  assert.equal(g.stock.done,true);assert.equal(g.stock.detail,'12 pieces on the books');assert.equal(g.site.done,false,'an archived site does not count');
  assert.equal(g.list.done,false,'undated or cancelled lists do not count');assert.equal(g.list.detail,'1 yard list, none dated');
  const h=byId(sgSteps(empty({sites:[{id:'a',status:'ACTIVE'}],loadLists:[{id:'l1',neededOn:'2026-10-01'}]}),ACCT));assert.equal(h.site.done,true);assert.equal(h.list.done,true);assert.equal(h.list.detail,'1 dated yard list');
});

test('everything in place: complete, no next step',()=>{
  const g=sgSteps(full(),ACCT);assert.equal(g.done,9);assert.equal(g.complete,true);assert.equal(g.next,null);
});

test('Home shows the card to operations roles only, at the top, and leaves it out once complete',t=>{
  const f=fixture(t),snap=f.sim.snapshot(),acct={...ACCT,systems:[],users:[],company:{id:'c',name:'Demo'},user:{id:f.user.id}};__test.setView('HOME');
  // The owner's emptied company: the yard stays, everything in it is gone.
  __test.setState({...snap,resources:[],trucks:[],containers:[],balances:[],products:[],register:[],sites:[],loadLists:[],requests:[],tasks:[],stockTotal:0},acct);const home=__test.homeView();
  assert.ok(home.startsWith('<section class="panel sg-guide"'),'the guide is the first thing under the hero');
  assert.ok(home.indexOf('sg-guide')<home.indexOf('home-grid'),'above the plan, fleet and material lists');
  for(const a of ['add:WORKER','add:FORKLIFT','add:TRUCK12','add:TRUCK2','add5:STILLAGE','add:STILLAGE','go:MATERIALS','seed','shape','site','hide'])assert.ok(home.includes('data-sg="'+a+'"'),a);
  assert.ok(home.includes('>DEMO</span> Load demo materials'),'the demo catalogue is labelled DEMO');
  assert.ok(home.includes('1<small>/9</small>'),'progress ring');assert.ok(!/ style="/.test(home),'no inline style attributes (CSP)');
  assert.ok(home.includes('Do these first: Client site, Materials catalogue.'),'the yard list waits for a site and a catalogue');
  assert.ok(home.includes('>Add a 12.5 t truck<')&&home.includes('>Add a 2 t truck<'));
  // Steps still to do are cards with the next one first; the finished yard is a small tick chip that keeps its Change button.
  const cards=[...home.matchAll(/<li class="sg-step[^"]*" data-sg-step="(\w+)"/g)].map(m=>m[1]);assert.deepEqual(cards,['crew','forklift','trucks','stillages','materials','stock','site','list']);
  assert.match(home,/<li class="sg-step next" data-sg-step="crew">/);assert.match(home,/<li class="sg-chip" data-sg-step="yard">[\s\S]*?data-sg="shape"/);assert.ok(home.includes('data-sg="all"'),'the phone toggle for all steps');
  const demoDone={...snap,containerCount:250,loadLists:[{id:'l',neededOn:'2026-10-01'}]};const dg=sgSteps(demoDone,acct);assert.equal(dg.complete,false,'the demo company still has only the DEMO catalogue');assert.equal(dg.next,'materials');
  __test.setState(demoDone,acct);const demoHome=__test.homeView();assert.match(demoHome,/<span class="sg-pill demo">Demo list<\/span>/);assert.ok(demoHome.includes('data-sg="import"'),'Import materials is the way on');
  const done={...demoDone,products:snap.products.map(p=>({...p,verification:'COMPANY CONFIGURED'}))};assert.equal(sgSteps(done,acct).complete,true,'with a real catalogue, a dated list and a big yard: fully set up');__test.setState(done,acct);
  assert.ok(__test.homeView().startsWith('<div class="sg-guide sg-off" hidden></div>'),'complete: an empty placeholder');
  __test.setState(snap,{...acct,permissions:['requests.create']});assert.ok(!__test.homeView().includes('sg-guide'),'supervisors never see it');
});

test('an older yard (never saved through the shape editor) is confirmed in one click, not only by changing it',()=>{
  const old=byId(sgSteps(empty({yards:[{...Y,shapeRev:undefined}]}),ACCT)).yard;
  assert.equal(old.done,false);assert.equal(old.unconfirmed,true);assert.equal(old.detail,'30 × 20 m · not checked yet');assert.match(old.why,/never been checked/);
  const acct={...ACCT,users:[],user:{id:'u1'}};__test.setView('HOME');__test.setState(empty({yards:[{...Y,shapeRev:0}]}),acct);const html=__test.sgCard();
  assert.ok(html.includes('data-sg="confirm-shape"')&&html.includes('>This outline is right<'),'one click confirms the outline as it is');assert.ok(html.includes('>Check shape &amp; size<'));assert.ok(!html.includes('>Draw your yard<'));
  __test.setState(empty({yards:[{...Y,points:[]}]}),acct);assert.ok(__test.sgCard().includes('>Draw your yard<'),'no outline yet: draw it');
});

test('missing figures show on the materials step (card and done chip) with a way into the fixer',()=>{
  const acct={...ACCT,users:[],user:{id:'u1'}};__test.setView('HOME');
  const prods=[{id:'a',name:'A',system:'quickstage',verification:'COMPANY CONFIGURED',unitWeight:null,packQuantity:10},{id:'b',name:'B',system:'quickstage',verification:'COMPANY CONFIGURED',unitWeight:1000,packQuantity:null}];
  __test.setState(empty({products:prods}),acct);const html=__test.sgCard();
  assert.match(html,/<li class="sg-chip" data-sg-step="materials">[\s\S]*?data-sg="gaps"[^>]*>2 missing figures/,'the done chip says how many figures are missing');
  __test.setState(empty({products:prods.map(p=>({...p,verification:'DEMO ONLY'}))}),acct);const demo=__test.sgCard();
  assert.match(demo,/<p class="sg-gaps"><span><b>2<\/b> components are missing a weight or pack size\.<\/span><button[^>]*data-sg="gaps"/,'the open step carries the gaps line');
});

test('Hide this guide is kept per company and user; Home keeps a slim strip to bring it back',t=>{
  const store=new Map(),old=globalThis.localStorage;globalThis.localStorage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)};t.after(()=>{globalThis.localStorage=old;});
  __test.setView('HOME');__test.setState(empty(),{...ACCT,users:[],user:{id:'u1'}});store.set('sg-hidden:c1:u1','1');
  const html=__test.sgCard();assert.ok(html.startsWith('<div class="sg-guide sg-home-strip sg-reopen">'),'hidden: a strip, not the card');assert.ok(html.includes('1 of 9 steps done')&&html.includes('data-sg="show"'));
  __test.setState(empty(),{...ACCT,users:[],user:{id:'u2'}});assert.ok(__test.sgCard().startsWith('<section class="panel sg-guide"'),'another user of the same company still sees the guide');
});
