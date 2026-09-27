process.env.TZ='Australia/Sydney';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './simulation.test.js';
// Wave E merge: the four features working together. A scheduled return (collection) ends hire for what it loads and shows on the Hire page;
// returns show on the Today page with their own buttons; the hire statement prints under the company's paperwork header (bdHead).
const load=async()=>{const m=await import('../public/operations.js');return {T:m.__test,H:m.__hr,td:m.tdTest,prSheetHTML:m.prSheetHTML,bdHead:m.bdHead};};
const acct=(f,perms=['company.manage','users.manage','operations.manage','sites.assigned','requests.create','finance.view','stock.adjust'])=>({permissions:perms,systems:[{id:'quickstage',name:'Quickstage',enabled:true}],users:[],company:{id:'c',name:'Demo'},user:{id:f.user.id,name:'Owner'}});
const WED=Date.parse('2026-09-23T00:00:00Z');// Wednesday 23 Sep 2026, 10:00 in Sydney
const clock=(t,iso)=>t.mock.timers.setTime(Date.parse(iso));
const settle=(f,n=150)=>{f.tick(n);for(const task of f.sim.tasks().filter(t=>t.state==='BLOCKED'))f.cmd('retry',{id:task.id});f.tick(n);};
// A and B (100 pieces each) go to Site A on T01 on Wed 23 Sep; the truck stays parked there.
const setup=t=>{t.mock.timers.enable({apis:['Date'],now:WED});const f=fixture(t);
 f.cmd('loadTruck',{truck:f.truck.id,containers:[f.a.id,f.b.id]});settle(f);f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});f.tick(5);f.cmd('unload',{id:f.truck.id});settle(f);
 assert.equal(f.sim.repo.get(f.a.id).location,f.site.id);assert.equal(f.sim.repo.get(f.truck.id).status,'AT_SITE');return f;};
const ids=html=>{const list=[...html.matchAll(/\sid="([^"]+)"/g)].map(m=>m[1]);return new Set(list).size===list.length;};

test('a collection ends hire on the day its stillages are loaded at the site, and the hire book still matches once it is back in the yard',t=>{const f=setup(t);
 let h=f.sim.hire();assert.equal(h.totals.pieces,200);assert.equal(h.sites[0].collection,null);
 clock(t,'2026-09-24T23:00:00Z');// Fri 25 Sep
 const c=f.cmd('requestCollection',{site:f.site.id,neededOn:'2026-09-25',slot:'AM',truck:f.truck.id});
 h=f.sim.hire();assert.deepEqual(h.sites[0].collection,{id:c.id,status:'BOOKED',neededOn:'2026-09-25',slot:'AM',late:false},'the Hire page knows hire is booked to end');
 f.cmd('loadCollection',{id:c.id});settle(f);assert.equal(f.sim.repo.get(c.id,'collection').status,'LOADING');
 h=f.sim.hire();assert.equal(h.totals.pieces,0,'loaded onto the truck at the site: off hire');assert.ok(h.check.ok);
 let s=f.sim.hire({site:f.site.id,from:'2026-09-01',to:'2026-09-25'}).statement;assert.equal(s.pieceDays,200*2,'Wed 23 and Thu 24: the load day (Fri 25) is not charged');assert.deepEqual(s.daily.slice(22),[200,200,0]);
 f.cmd('dispatch',{id:f.truck.id,destination:f.yard.id});f.tick(5);f.cmd('unload',{id:f.truck.id});settle(f);
 assert.equal(f.sim.repo.get(c.id,'collection').status,'RETURNED');assert.equal(f.sim.repo.get(f.a.id).location,f.yard.id);
 clock(t,'2026-09-27T23:00:00Z');// Mon 28 Sep
 h=f.sim.hire();assert.equal(h.totals.pieces,0);assert.equal(h.check.rebuilt,h.check.actual);assert.equal(h.sites[0].collection,null,'a returned collection is no longer pending');
 s=f.sim.hire({site:f.site.id,from:'2026-09-01',to:'2026-09-28'}).statement;assert.equal(s.pieceDays,400,'nothing more accrues after the return');});

test('the Hire page shows the booked collection on the site row',async t=>{const f=setup(t),{T,H}=await load();
 f.cmd('requestCollection',{site:f.site.id,neededOn:'2026-09-28',slot:'PM'});
 T.setState(f.sim.snapshot(),acct(f));T.setView('HIRE');H.setData(f.sim.hire());const html=H.view();
 assert.match(html,/<span class="hr-coll"[^>]*>.*?Collection booked Mon 28 Sep PM<\/span>/);assert.ok(!/ style="/.test(html));assert.ok(ids(html));
 clock(t,'2026-09-28T23:00:00Z');// Tue 29 Sep: the collection is late and nothing has left the site
 H.setData(f.sim.hire());assert.ok(H.view().includes('class="hr-coll late"'));});

test('the Today page: a collection due today brings the Returns counter and card with its own buttons; an overdue one turns it red',async t=>{const f=setup(t),{T,td}=await load();
 clock(t,'2026-09-24T23:00:00Z');// Fri 25 Sep
 const c=f.cmd('requestCollection',{site:f.site.id,neededOn:'2026-09-25',truck:f.truck.id});
 T.setState(f.sim.snapshot(),acct(f));T.setView('TODAY');let html=td.view();
 assert.match(html,/data-td-jump="returns"[\s\S]*?Returns today<\/span><b class="hud-num">1</,'the counter');assert.ok(!html.includes('data-td-jump="late"'),'no load is late: the returns counter takes the slot');
 assert.ok(html.includes('id="td-returns"')&&html.includes('data-rt="'+c.id+'"'),'the collection card');assert.match(html,/<div class="rt-row-title"><b>Site A<\/b>/,'headed by its site');
 assert.ok(html.includes('data-rt-load="'+c.id+'"')&&html.includes('Load collection onto T01'),'T01 is at the site: load it from Today');
 assert.ok(html.includes('data-sch-goto="'+c.id+'"'),'and open it on the Schedule');assert.ok(!/ style="/.test(html));assert.ok(ids(html),'ids are unique');
 T.setState(f.sim.snapshot(),acct(f,['requests.create','sites.assigned']));assert.ok(!td.view().includes('data-rt-load'),'a supervisor never loads a truck');
 // the next working day it has not been loaded: overdue at the site
 clock(t,'2026-09-27T23:00:00Z');// Mon 28 Sep
 const s=f.sim.snapshot();const d=td.day(s);assert.equal(d.returns.length,1);assert.equal(d.returns[0].late,true);
 T.setState(s,acct(f));html=td.view();assert.match(html,/td-stat alert" data-td-jump="returns"[\s\S]*?1 overdue at the site/);assert.ok(html.includes('td-returns is-late'));
 // loaded, sent home and unloaded: back in the yard, still listed today as done (needed today)
 f.cmd('reschedule',{id:c.id,neededOn:'2026-09-28'});f.cmd('loadCollection',{id:c.id});settle(f);
 assert.equal(td.day(f.sim.snapshot()).returns[0].moving,true,'loading: shown as in progress');
 f.cmd('dispatch',{id:f.truck.id,destination:f.yard.id});f.tick(5);f.cmd('unload',{id:f.truck.id});settle(f);
 const back=td.day(f.sim.snapshot()).returns;assert.equal(back[0].status,'RETURNED');assert.equal(back[0].done,true);
 T.setState(f.sim.snapshot(),acct(f));assert.ok(td.view().includes('Everything due back is in.'));});

test('no collections today: the overdue-loads counter stays, and a cancelled collection never shows',async t=>{const f=setup(t),{T,td}=await load();
 const c=f.cmd('requestCollection',{site:f.site.id,neededOn:'2026-09-25'});f.cmd('cancelCollection',{id:c.id});
 T.setState(f.sim.snapshot(),acct(f));T.setView('TODAY');const html=td.view();assert.equal(td.day(f.sim.snapshot()).returns,null);
 assert.ok(html.includes('data-td-jump="late"')&&!html.includes('id="td-returns"'));});

test('the hire statement prints under the paperwork header (bdHead): logo, name and ABN when set, the plain mark when not',async t=>{const f=setup(t),{prSheetHTML}=await load();
 clock(t,'2026-09-27T23:00:00Z');f.cmd('hireRate',{product:f.products[0].id,day:100});
 const s=f.sim.hire({site:f.site.id,from:'2026-09-01',to:'2026-09-28'}).statement;
 const m={...s,kind:'hire',company:'Demo',user:'Owner',printedAt:'2026-09-28T01:00:00Z',gstPercent:10,no:'HS-TEST-1'};
 const brand={company:'Demo',name:'Demo Scaffolding',tradingName:'Demo Scaffolding',abn:'00000000000',abnText:'00 000 000 000',address:['1 Example St'],phone:'',email:'',website:'',logo:{type:'image/png',version:'abc123def4567890',width:400,height:100,url:'/api/company-logo?v=abc123def4567890'},has:true};
 const branded=prSheetHTML({...m,brand});assert.ok(branded.includes('class="pr-top bd-top-row"')&&branded.includes('<img class="bd-logo" src="/api/company-logo?v=abc123def4567890"')&&branded.includes('ABN 00 000 000 000')&&branded.includes('Demo Scaffolding'));
 assert.ok(branded.includes('Hire statement')&&branded.includes('HS-TEST-1')&&branded.includes('not a tax invoice'));
 const plain=prSheetHTML(m);assert.ok(plain.includes('pr-mark')&&plain.includes('<b>Demo</b>')&&plain.includes('Scaffold hire &middot; Scaffold Yard')&&!plain.includes('ABN'),'nothing set: the mark, the company and the hire line, as before');
 assert.ok(!/ style="/.test(branded));});
