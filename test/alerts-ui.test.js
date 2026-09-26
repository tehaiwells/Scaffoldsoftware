import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from './simulation.test.js';
import { __test, alTest, materialFacts, materialCardHTML, materialsView } from '../public/operations.js';
// The alerts UI in node (no DOM): the bell, the Needs attention strip, the drawer, the minimum chips, the stockpile mark and the hover-card line, from live snapshots.
const css=readFileSync(new URL('../public/design.css',import.meta.url),'utf8');
const ops=f=>({permissions:['operations.manage','stock.adjust','requests.create'],systems:[{id:'quickstage',name:'Quickstage',enabled:true}],users:[],company:{id:'c',name:'Demo'},user:{id:f.user.id}});
const sup={permissions:['requests.create','sites.assigned'],systems:[{id:'quickstage',name:'Quickstage',enabled:true}],users:[],company:{id:'c',name:'Demo'},user:{id:'s'}};
// A world with every kind of alert the fixture can make: a material under its minimum, a damaged stillage with stock and a blocked move.
function world(t){const f=fixture(t),p=f.products[0];f.cmd('override',{product:p.id,minYard:500});f.cmd('condition',{id:f.b.id,condition:'DAMAGED',reason:'Bent'});
  f.cmd('resources',{location:f.yard.id,workers:0,machines:0});f.cmd('queue',{container:f.a.id,destination:f.truck.id});f.tick();return {f,p,s:f.sim.snapshot()};}

test('the bell shows the count in the colour of the most urgent alert, and says so for screen readers',t=>{
  const {f,s}=world(t);__test.setState(s,ops(f));const bell=alTest.bell(s);
  assert.equal(s.alerts.count,3);assert.match(bell,/id="al-bell" class="al-bell has sev-high"/);assert.match(bell,/<b class="al-count">3<\/b>/);assert.match(bell,/aria-label="Alerts: 3 need attention"/);assert.match(bell,/data-al-open/);
  const none=alTest.bell({alerts:{count:0,counts:{high:0,medium:0,low:0},items:[],below:{}}});assert.ok(!none.includes('al-count'));assert.match(none,/nothing needs attention/);
  assert.match(alTest.bell({alerts:{count:120,counts:{high:0,medium:1,low:119},items:[],below:{}}}),/sev-medium[\s\S]*99\+/);
});

test('Needs attention strip: most urgent first, each a link to its alert; an empty hidden section when all is well; on Home above everything else and on Overview',t=>{
  const {f,p,s}=world(t);__test.setState(s,ops(f));const strip=alTest.strip(s);
  const ids=[...strip.matchAll(/data-al-go="([^"]+)"/g)].map(m=>m[1]);assert.deepEqual(ids,s.alerts.items.slice(0,4).map(a=>a.id));assert.equal(ids[0].split(':')[0],'BLOCKED','blocked moves lead');
  assert.ok(ids.includes('LOW_STOCK:'+p.id)&&ids.includes('DAMAGED:'+f.b.id));assert.match(strip,/3 things to sort out/);assert.match(strip,/<b>2<\/b> urgent/);assert.match(strip,/Open alerts/);
  assert.equal(alTest.strip({alerts:undefined}),'<section class="al-strip" hidden></section>');
  __test.setView('HOME');const home=__test.homeView();assert.ok(home.indexOf('class="al-strip')>=0);assert.ok(home.indexOf('class="al-strip')<home.indexOf('home-grid'),'under the hero, before the plan');assert.ok(home.indexOf('class="al-strip')<home.indexOf('stockpile'),'never below the material lists');
  assert.ok(__test.overviewView().includes('class="al-strip'),'Overview has it too');
});

test('the drawer groups alerts by how soon they need doing, links each one, and shows an all-clear state; minimum levels are pointed out to operations only',t=>{
  const {f,s}=world(t);__test.setState(s,ops(f));const body=alTest.drawer(s);
  const order=[...body.matchAll(/class="al-group sev-(\w+)"/g)].map(m=>m[1]);assert.deepEqual(order,['high','low']);
  assert.equal((body.match(/data-al-go=/g)||[]).length,3);assert.match(body,/Out of service/);assert.match(body,/Below minimum/);assert.match(body,/Blocked move/);assert.match(body,/data-al-materials/);
  const clear=alTest.drawer({alerts:{count:0,counts:{high:0,medium:0,low:0},items:[],below:{}}});assert.match(clear,/All clear/);assert.match(clear,/materials under their minimum/);
  __test.setState(s,sup);const sc=alTest.drawer({alerts:{count:0,counts:{high:0,medium:0,low:0},items:[],below:{}}});assert.ok(!sc.includes('data-al-materials'));assert.ok(!sc.includes('materials under their minimum'));
});

test('minimum chips: operations set or change it from the tile and the fixer row; a supervisor only sees one that is set; below minimum is flagged',t=>{
  const {f,p,s}=world(t);__test.setState(s,ops(f));
  const low=alTest.chip(s.products.find(x=>x.id===p.id));assert.match(low,/<button type="button" class="al-min-chip low" data-al-min="/);assert.match(low,/Below min &middot; 0\/500/);
  const unset=alTest.chip(s.products[1]);assert.match(unset,/al-min-chip unset/);assert.match(unset,/Set minimum/);
  f.cmd('opening',{container:f.empty.id,product:f.products[1].id,quantity:5,reason:'Demo'});f.cmd('override',{product:f.products[1].id,minYard:1});const s2=f.sim.snapshot();__test.setState(s2,ops(f));assert.match(alTest.chip(s2.products.find(x=>x.id===f.products[1].id),true),/class="al-min-chip set in-row"[^>]*>Min 1</);
  __test.setState(s2,sup);assert.equal(alTest.chip(s2.products[2]),'','nothing to show or do');assert.match(alTest.chip(s2.products.find(x=>x.id===p.id)),/^<span class="al-min-chip low"/);
  // the Materials page carries the chips on its tiles
  __test.setState(s2,ops(f));__test.setView('MATERIALS');const page=materialsView();assert.ok(page.includes('data-al-min="'+p.id+'"'));assert.ok(page.includes('data-al-min="'+f.products[2].id+'"'));
});

test('stockpile tiles and the hover card mark a component below its minimum (the card only displays it)',t=>{
  const {f,p,s}=world(t);__test.setState(s,ops(f));__test.setStep(1);__test.setGridSearch({});
  const html=__test.stockpile(),tile=html.slice(html.indexOf('data-tile="'+p.id+'"')-60,html.indexOf('data-tile="'+p.id+'"'));assert.match(tile,/class="tile stocked al-low"/);
  assert.ok(alTest.belowKey().startsWith(p.id+'='),'the tile memo follows the below-minimum list');
  const card=materialCardHTML(materialFacts(s,p.id,[]));assert.match(card,/class="mc-min low"/);assert.match(card,/Below minimum/);assert.match(card,/Keep at least <b>500<\/b> &middot; <b>500 short<\/b>/);assert.ok(!card.includes('data-al-min'),'display only');
  f.cmd('override',{product:p.id,minYard:50});f.cmd('condition',{id:f.b.id,condition:'SERVICEABLE',reason:'Fixed'});const s2=f.sim.snapshot();__test.setState(s2,ops(f));
  assert.match(materialCardHTML(materialFacts(s2,p.id,[])),/class="mc-min"><span class="mc-min-tag">Minimum<\/span><span>Keep at least <b>50<\/b> &middot; OK/);
  assert.equal(alTest.tileMark(p.id),'');
});

test('alerts CSS: one appended block, the drawer hides with [hidden], and the Home strip shows one row of alerts at each width',()=>{
  assert.equal((css.match(/===== Alerts and minimum stock levels/g)||[]).length,1);
  assert.ok(css.indexOf('===== Alerts and minimum stock levels')>css.lastIndexOf('.sg-done{grid-template-columns:minmax(0,1fr)}'),'appended at the end');
  assert.match(css,/\.al-drawer\[hidden\]\{display:none\}/);assert.match(css,/\.al-strip-list \.al-item:nth-child\(n\+4\)\{display:none\}/);
});
