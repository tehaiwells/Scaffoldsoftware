process.env.TZ='Australia/Sydney';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from './simulation.test.js';
// Client side of the Hire page, rendered in node from a live /api/hire result: hero, sites, statement, rates, the A4 sheet, money parsing and the owner-only nav.
const load=async()=>{const m=await import('../public/operations.js');return {T:m.__test,H:m.__hr,cents:m.hrCents,aud:m.hrAUD,prSheetHTML:m.prSheetHTML};};
const acct=(f,perms=['company.manage','users.manage','operations.manage','sites.assigned','requests.create','finance.view','stock.adjust'])=>({permissions:perms,systems:[{id:'quickstage',name:'Quickstage',enabled:true}],users:[],company:{id:'c',name:'Demo'},user:{id:f.user.id,name:'Owner'}});
const settle=(f,n=150)=>{f.tick(n);for(const task of f.sim.tasks().filter(t=>t.state==='BLOCKED'))f.cmd('retry',{id:task.id});f.tick(n);};
const deliver=(f,c)=>{f.cmd('loadTruck',{truck:f.truck.id,containers:[c.id]});settle(f);f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});f.tick(5);f.cmd('unload',{id:f.truck.id});settle(f,60);f.cmd('dispatch',{id:f.truck.id,destination:f.yard.id});f.tick(5);};
const setup=t=>{t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-06T23:00:00Z')});const f=fixture(t);deliver(f,f.a);t.mock.timers.setTime(Date.parse('2026-09-13T23:00:00Z'));deliver(f,f.b);t.mock.timers.setTime(Date.parse('2026-09-20T23:00:00Z'));return f;};

test('money is typed in dollars and shown in dollars; whole cents in between',async()=>{const {cents,aud}=await load();
 assert.equal(cents('12.50'),1250);assert.equal(cents('$1,200'),120000);assert.equal(cents('0.3'),30);assert.equal(cents(' 7 '),700);assert.equal(cents(''),null);
 assert.ok(Number.isNaN(cents('12.505')));assert.ok(Number.isNaN(cents('-3')));assert.ok(Number.isNaN(cents('abc')));
 assert.equal(aud(123456),'$1,234.56');assert.equal(aud(5),'$0.05');assert.equal(aud(123456,true),'$1,235');assert.equal(aud(null),'&ndash;');});

test('the Hire page: hero counters, the no-rate alert, sites, a statement and the rate editor',async t=>{const f=setup(t),{T,H}=await load();
 T.setState(f.sim.snapshot(),acct(f));T.setView('HIRE');
 let d=f.sim.hire({site:f.site.id,from:'2026-09-01',to:'2026-09-21'});H.setData(d,{site:f.site.id,from:'2026-09-01',to:'2026-09-21'});let html=H.view();
 assert.ok(html.includes('class="hr-hero page-hero"')&&html.includes('<h1>Hire</h1>'),'page hero');
 assert.ok(html.includes('1 material out on hire has no hire rate'),'unpriced material flagged');
 assert.ok(html.includes('Matches the live count at your sites (200)'));
 assert.ok(html.includes('data-hr-row="'+f.site.id+'"')&&html.includes('Mon 7 Sep'),'the site row with its since date');
 assert.ok(html.includes('<b>2,300</b>'),'piece-days: 100 x 15 (7-21 Sep) + 100 x 8 (14-21 Sep)');assert.ok(html.includes('No rate')&&html.includes('Not complete:'),'no rate: flagged, not guessed');
 assert.ok(html.includes('href="/api/hire.csv?site='+f.site.id+'&amp;from=2026-09-01&amp;to=2026-09-21"'),'CSV link for the statement shown');
 f.cmd('hireRate',{product:f.products[0].id,week:700});d=f.sim.hire({site:f.site.id,from:'2026-09-01',to:'2026-09-21'});H.setData(d,{site:f.site.id,from:'2026-09-01',to:'2026-09-21'});html=H.view();
 assert.ok(!html.includes('Not complete:'));assert.ok(html.includes('$2,300.00')&&html.includes('$230.00')&&html.includes('$2,530.00'),'subtotal, GST 10%, total');
 assert.ok(/data-hr-f="week"[^>]*value="7\.00"/.test(html),'the saved week rate in the editor');
 H.setScope(f.site.id);const rows=H.rows();assert.ok(/data-hr-f="week"[^>]*value=""[^>]*placeholder="7\.00"/.test(rows),'a site shows the standard rate faintly');assert.ok(rows.includes('data-hr-f="note"'));H.setScope('STD');
 assert.ok(!/ style="/.test(html),'no inline style attributes (CSP)');});

test('the A4 hire statement: HIRE STATEMENT, lines, GST, total, and a DEMO watermark for demonstration products',async t=>{const f=setup(t),{T,H,prSheetHTML}=await load();
 f.cmd('hireRate',{product:f.products[0].id,day:100,minDays:7});T.setState(f.sim.snapshot(),acct(f));
 const s=f.sim.hire({site:f.site.id,from:'2026-09-01',to:'2026-09-21'}).statement;const m={...s,kind:'hire',company:'Demo',user:'Owner',printedAt:'2026-09-21T01:00:00Z',gstPercent:10,no:'HS-TEST'};
 const html=prSheetHTML(m);assert.equal(html,H.sheet(m));
 assert.ok(html.includes('<span class="pr-kind">Hire statement</span>'));assert.ok(html.includes('$2,300.00')&&html.includes('$230.00')&&html.includes('$2,530.00'));
 assert.equal(s.demo,f.products[0].verification==='DEMO ONLY');if(s.demo)assert.ok(html.includes('class="pr-watermark"')&&html.includes('not a real hire statement'));
 assert.ok(html.includes('statement only, not a tax invoice'));});

test('Hire is owner only: nav entry filtered by finance.view, next to Client sites',async t=>{const f=setup(t),{T,H}=await load();
 T.setState(f.sim.snapshot(),acct(f,['operations.manage','requests.create','stock.adjust']));assert.equal(H.ok(),false);assert.ok(H.view().includes('Hire is for the owner'));
 T.setState(f.sim.snapshot(),acct(f));assert.equal(H.ok(),true);
 const src=readFileSync(new URL('../public/operations.js',import.meta.url),'utf8');assert.ok(src.includes("['SITES','Client sites'],['HIRE','Hire'],['YARD'"));assert.ok(src.includes("NAV.filter(([v])=>v!=='HIRE'||hrOK())"));});
