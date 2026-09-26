process.env.TZ='Australia/Sydney';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './simulation.test.js';
// Wave E review, on the page: the Schedule counts loads and collections apart and keeps Return cards short; Today says when loads have no date,
// greys out 'Allocate all idle' when nobody is idle and shows a truck waiting to load a collection; collection alerts carry the return picture;
// the hire statement is addressed to the client first; the Today menu icon is no longer the Schedule calendar.
const load=async()=>{const m=await import('../public/operations.js');return {T:m.__test,H:m.__hr,td:m.tdTest,al:m.alTest,prSheetHTML:m.prSheetHTML};};
const acct=(f,perms=['company.manage','users.manage','operations.manage','sites.assigned','requests.create','finance.view','stock.adjust'])=>({permissions:perms,systems:[{id:'quickstage',name:'Quickstage',enabled:true}],users:[],company:{id:'c',name:'Demo'},user:{id:f.user.id,name:'Owner'}});
const WED=Date.parse('2026-09-23T00:00:00Z');// Wednesday 23 Sep 2026, 10:00 in Sydney
const settle=(f,n=150)=>{f.tick(n);for(const task of f.sim.tasks().filter(t=>t.state==='BLOCKED'))f.cmd('retry',{id:task.id});f.tick(n);};
const setup=t=>{t.mock.timers.enable({apis:['Date'],now:WED});const f=fixture(t);
 f.cmd('loadTruck',{truck:f.truck.id,containers:[f.a.id,f.b.id]});settle(f);f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});f.tick(5);f.cmd('unload',{id:f.truck.id});settle(f);return f;};

test('Schedule: collections are counted apart from loads, and a Return card says what it collects in one short line',async t=>{const f=setup(t),{T}=await load();
 const c=f.cmd('requestCollection',{site:f.site.id,neededOn:'2026-09-23',truck:f.truck.id});
 f.cmd('createLoadList',{site:f.site.id,name:'Level 2',neededOn:'2026-09-23',lines:[{product:f.products[0].id,quantity:5}]});
 T.setState(f.sim.snapshot(),acct(f));T.setView('SCHEDULE');const html=T.scheduleView();
 assert.ok(html.includes('Loads and collections by day and truck'),'the hero says both');
 assert.ok(html.includes('1 load &middot; 1 collection'),'Due today and This week split them');
 assert.match(html,/1 load &middot; 5 pcs out &middot; 1 collection/,'the week strip too');
 assert.match(html,new RegExp('data-sch-card="'+c.id+'"[\\s\\S]*?<span class="sch-l2 rt-l2"><span class="sch-kind rt-kind"[^>]*>[\\s\\S]*?Return</span><span>All on site</span></span>'),'short: All on site');
 assert.ok(!/ style="/.test(html));});

test('Today: undated loads are named when nothing is due; a busy crew greys out Allocate; a truck at the site waits to load its collection',async t=>{const f=setup(t),{T,td}=await load();
 f.cmd('requestCollection',{site:f.site.id,neededOn:'2026-09-24',truck:f.truck.id});
 f.cmd('createLoadList',{site:f.site.id,name:'No date yet',lines:[{product:f.products[0].id,quantity:5}]});
 T.setState(f.sim.snapshot(),acct(f));T.setView('TODAY');const d=td.day(f.sim.snapshot());assert.equal(d.undated,1);
 const html=td.view();assert.ok(!html.includes('No loads are booked ahead'),'never says nothing is booked while a load waits for a date');
 assert.ok(/1 with no date yet|1 load has no date yet/.test(html));
 assert.ok(html.includes('>Waiting to load<'),'T01 is parked at Site A with a collection booked there');
 const idle=d.idle;if(!idle)assert.match(html,/data-td-crew="next" disabled>[\s\S]*?Everyone busy/);else assert.ok(html.includes('Allocate all idle'));});

test('alerts: an overdue collection shows the return picture; the Today icon is a sunrise, not the Schedule calendar',async t=>{const f=setup(t),{T,al}=await load();
 f.cmd('requestCollection',{site:f.site.id,neededOn:'2026-09-24'});t.mock.timers.setTime(WED+3*86400000);
 const s=f.sim.snapshot();const item=s.alerts.items.find(i=>i.collection);assert.ok(item,'the overdue collection is flagged as one');
 T.setState(s,acct(f));const html=al.drawer(s);assert.match(html,/rt-img/);
 const art=await import('../public/art.js');assert.notEqual(art.tdIcon(),art.scheduleIcon());assert.ok(!art.tdIcon().includes('M4 5h16v16H4z'));});

test('the hire statement is addressed to the client, then the site and the contact',async t=>{const f=setup(t),{prSheetHTML}=await load();
 f.cmd('siteDetails',{id:f.site.id,client:'Harbourside Builders',contact:'Sam Lee'});f.cmd('hireRate',{product:f.products[0].id,week:700});t.mock.timers.setTime(WED+2*86400000);
 const s=f.sim.hire({site:f.site.id,from:'2026-09-01',to:'2026-09-25'}).statement;
 const html=prSheetHTML({...s,kind:'hire',company:'Demo',user:'Owner',printedAt:'2026-09-25T01:00:00Z',gstPercent:10,no:'HS-1'});
 assert.match(html,/<dt>Hire to<\/dt><dd><b>Harbourside Builders<\/b><span>Site: Site A<\/span>[\s\S]*?<span>Contact: Sam Lee<\/span>/);
 assert.ok(html.includes('Rate in force each day'));});
