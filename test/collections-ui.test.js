process.env.TZ='Australia/Sydney';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from './simulation.test.js';
import { __test, rtTest } from '../public/operations.js';
// The collections UI in node (no DOM): the site card block and its form, the Schedule's return cards, the truck garage panel, from live snapshots.
const css=readFileSync(new URL('../public/design.css',import.meta.url),'utf8');
const ops=f=>({permissions:['operations.manage','stock.adjust','requests.create'],systems:[{id:'quickstage',name:'Quickstage',enabled:true}],users:[],company:{id:'c',name:'Demo'},user:{id:f.user.id}});
const sup={permissions:['requests.create','sites.assigned'],systems:[{id:'quickstage',name:'Quickstage',enabled:true}],users:[],company:{id:'c',name:'Demo'},user:{id:'s'}};
const settle=(f,n=150)=>{f.tick(n);for(const task of f.sim.tasks().filter(t=>t.state==='BLOCKED'))f.cmd('retry',{id:task.id});f.tick(n);};
// A and B delivered to Site A; T01 still parked there.
function world(t){const f=fixture(t);t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-23T00:00:00Z')});
  f.cmd('loadTruck',{truck:f.truck.id,containers:[f.a.id,f.b.id]});settle(f);f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});f.tick(5);f.cmd('unload',{id:f.truck.id});settle(f);return f;}
const boxes=(f,s)=>s.containers.filter(c=>c.location===f.site.id);

test('site card: an empty collections block offers the booking form; the office picks a truck, a supervisor cannot',t=>{
  const f=world(t);let s=f.sim.snapshot();__test.setState(s,ops(f));const site=s.sites[0];
  let html=rtTest.site(site,boxes(f,s));
  assert.match(html,/Collections back to the yard/);assert.match(html,/<details class="rt-new" data-rt-new="[^"]+"><summary>/);assert.match(html,/Book a collection/);
  assert.match(html,/name="scope" value="ALL" checked/);assert.match(html,/2 stillages &middot; 200 pcs/);assert.equal((html.match(/name="c" value=/g)??[]).length,2);
  assert.match(html,/<input type="date" name="neededOn" required min="2026-09-23"/);assert.match(html,/Collection window/);assert.match(html,/<select name="truck">/);assert.match(html,/T01 \(here now\)/);
  __test.setState(s,sup);html=rtTest.site(site,boxes(f,s));assert.ok(!html.includes('name="truck"'));assert.match(html,/The yard office books the truck/);
  assert.equal(rtTest.site({...site,status:'ARCHIVED'},[]),'','nothing for an archived site with no collections');
});

test('a booked collection: status steps, the truck in words, its stillages and the Load button (office only); overdue and clash shown',t=>{
  const f=world(t);const c=f.cmd('requestCollection',{site:f.site.id,neededOn:'2026-09-23',slot:'AM',truck:f.truck.id,notes:'Gate 3 <b>'});
  let s=f.sim.snapshot();__test.setState(s,ops(f));let html=rtTest.site(s.sites[0],boxes(f,s));
  assert.match(html,/class="rt-count">1</);assert.match(html,/<span class="rt-status">BOOKED<\/span>/);assert.match(html,/<li class="done"><i aria-hidden="true"><\/i><span>Requested<\/span><\/li><li class="now" aria-current="step">/);
  assert.match(html,/<b>T01<\/b> is here at Site A/);assert.match(html,/<b>A<\/b><small>100<\/small>/);assert.match(html,/Gate 3 &lt;b&gt;/,'notes are escaped');
  assert.match(html,new RegExp('data-rt-load="'+c.id+'"'));assert.match(html,/Load collection onto T01/);assert.match(html,/data-rt-cancel=/);assert.ok(!html.includes('<details class="rt-new"'),'no second everything-on-site collection');
  __test.setState(s,sup);html=rtTest.site(s.sites[0],boxes(f,s));assert.ok(!html.includes('data-rt-load'),'a supervisor never loads');
  // the truck page lists it
  __test.setState(s,ops(f));const truck=rtTest.truck(s.trucks[0]);assert.match(truck,/class="rt-truck"/);assert.match(truck,/Collections <span>1<\/span>/);
  const run=s.trucks[0].nextRuns.find(r=>r.id===c.id);assert.ok(run);
  // overdue two days later
  t.mock.timers.setTime(Date.parse('2026-09-25T00:00:00Z'));s=f.sim.snapshot();__test.setState(s,ops(f));html=rtTest.site(s.sites[0],boxes(f,s));assert.match(html,/class="rt-row s-booked late"/);assert.match(html,/Overdue &middot; 2 days/);
});

test('Schedule: a collection is a violet return card in its truck row with its own editor; the legend names it',t=>{
  const f=world(t);const c=f.cmd('requestCollection',{site:f.site.id,neededOn:'2026-09-24',truck:f.truck.id});const s=f.sim.snapshot();__test.setState(s,ops(f));__test.setView('SCHEDULE');__test.schedWeek(null);__test.schedOpen().clear();
  const items=rtTest.items();assert.equal(items.length,1);assert.equal(items[0].kind,'collection');assert.equal(items[0].runTruck,f.truck.id);assert.equal(items[0].pieces,200);
  let html=__test.scheduleView();assert.match(html,new RegExp('<article class="sch-card u-tomorrow rt-card[^"]*" data-sch-card="'+c.id+'" data-kind="collection"'));assert.match(html,/sch-kind rt-kind/);assert.match(html,/<li class="rt">/);
  __test.schedOpen().add(c.id);html=__test.scheduleView();assert.match(html,/sch-edit rt-edit/);assert.match(html,new RegExp('data-sch-date="'+c.id+'" data-kind="collection"'));assert.match(html,new RegExp('data-sch-book="'+c.id+'"'));assert.match(html,/data-rt-load=/);__test.schedOpen().clear();
});

test('loading, on the way and returned read right on the card; the CSS block is there',t=>{
  const f=world(t);const c=f.cmd('requestCollection',{site:f.site.id,neededOn:'2026-09-23',truck:f.truck.id});f.cmd('loadCollection',{id:c.id});
  let s=f.sim.snapshot();__test.setState(s,ops(f));let card=rtTest.card(s.collections[0],'site');assert.match(card,/rt-row s-loading/);assert.match(card,/0 of 2 stillages on T01 &middot; the crane is working/);
  settle(f);s=f.sim.snapshot();__test.setState(s,ops(f));card=rtTest.card(s.collections[0],'site');assert.match(card,/2 of 2 stillages on T01 &middot; ready to go/);assert.match(card,/Send T01 back to the yard/);
  f.cmd('dispatch',{id:f.truck.id,destination:f.yard.id});s=f.sim.snapshot();__test.setState(s,ops(f));card=rtTest.card(s.collections[0],'truck');assert.match(card,/<b>T01<\/b> is bringing it back/);assert.match(card,/rt-status">ON THE WAY/);
  f.tick(5);f.cmd('unload',{id:f.truck.id});settle(f);s=f.sim.snapshot();__test.setState(s,ops(f));card=rtTest.card(s.collections[0],'site');assert.match(card,/rt-row s-returned/);assert.match(card,/Back in the yard/);assert.ok(!card.includes('data-rt-cancel'));
  assert.match(css,/\/\* ===== Scheduled returns \(collections, rt-\)/);assert.match(css,/\.rt-steps\{/);assert.match(css,/\.page-schedule \.sch-card\.rt-card\{/);
});
