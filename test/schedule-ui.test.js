process.env.TZ='Australia/Sydney';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './simulation.test.js';
// Client side of dated yard lists: the Schedule page, the create form defaults, the truck runs strip and the Home pill, rendered in node from a live snapshot.
const load=async()=>(await import('../public/operations.js')).__test;
const acct=(f,perms=['operations.manage','stock.adjust','requests.create'])=>({permissions:perms,systems:[],users:[],company:{id:'c',name:'Demo'},user:{id:f.user.id}});
const WED=Date.parse('2026-09-23T00:00:00Z');
const setup=t=>{const f=fixture(t);t.mock.timers.enable({apis:['Date'],now:WED});return f;};
const list=(f,extra={})=>f.cmd('createLoadList',{site:f.site.id,lines:[{product:f.products[0].id,quantity:10}],...extra});

test('the Schedule page puts each yard list on its day and truck, with the hero counters and strips',async t=>{const f=setup(t),T=await load();
 const a=list(f,{name:'Due today',neededOn:'2026-09-23'}),b=list(f,{name:'Tomorrow AM',neededOn:'2026-09-24',slot:'AM'}),c=list(f,{name:'No date'});f.cmd('bookTruck',{id:a.id,truck:f.truck.id});
 T.setState(f.sim.snapshot(),acct(f));T.setView('SCHEDULE');T.schedWeek(null);const html=T.scheduleView();
 assert.ok(html.includes('<h1>Load schedule</h1>'));assert.ok(html.includes('Mon 21 Sep – Sun 27 Sep 2026'));
 for(const l of [a,b,c])assert.ok(html.includes('data-sch-card="'+l.id+'"'),'card for '+l.name);
 assert.ok(html.includes('sch-dayhead today'),'today column is marked');assert.ok(html.includes('No date yet'),'undated strip');
 assert.ok(/Due today<\/span><b class="hud-num">1</.test(html),'one load due today');assert.ok(html.includes('<span class="sch-slot"'),'the AM slot tag shows');
 T.schedOpen().add(b.id);const open=T.scheduleView();T.schedOpen().clear();
 assert.ok(open.includes('data-sch-date="'+b.id+'"')&&open.includes('data-sch-book="'+b.id+'"'),'an open card offers the date and truck forms');
 assert.ok(open.includes('min="2026-09-23"')&&open.includes('max="2027-09-24"'),'the date input is bounded by the server calendar');
 T.schedWeek('2026-09-28');const next=T.scheduleView();T.schedWeek(null);assert.ok(!next.includes('data-sch-card="'+a.id+'"'),'next week does not show this week\'s loads');});

test('supervisors get the date form only, and the create form defaults to the next working day',async t=>{const f=setup(t),T=await load();const l=list(f,{neededOn:'2026-09-24'});const s=f.sim.snapshot();
 T.setState(s,acct(f,['requests.create']));T.setView('SCHEDULE');T.schedOpen().add(l.id);const html=T.scheduleView();T.schedOpen().clear();
 assert.ok(!html.includes('data-sch-book')&&!html.includes('data-sch-reserve'),'no booking or reserve controls without operations.manage');
 T.setState(s,acct(f));T.setView('SITES');const sites=T.requestView();assert.ok(sites.includes('name="neededOn" required min="2026-09-23" max="2027-09-24" value="2026-09-24"'),'next working day by default');assert.ok(sites.includes('data-set-date="2026-09-23">Today<'));assert.ok(sites.includes('Yard list 2026-09-23'));});

test('the truck garage lists its next runs and Home and Overview point at the day\'s loads',async t=>{const f=setup(t),T=await load();const l=list(f,{name:'Run one',neededOn:'2026-09-23'});f.cmd('bookTruck',{id:l.id,truck:f.truck.id});
 T.setState(f.sim.snapshot(),acct(f));T.setView('TRUCK12');const trucks=T.truckView(()=>true);assert.ok(trucks.includes('data-sch-goto="'+l.id+'"')&&trucks.includes('Next runs'));
 assert.ok(T.homeDue().includes('1 due today'));assert.ok(T.overviewView().includes('Today: 1 load due'));
 f.cmd('reschedule',{id:l.id,neededOn:'2026-09-30'});T.setState(f.sim.snapshot(),acct(f));assert.ok(T.homeDue().includes('hidden'),'the pill hides when nothing is due');});

test('an open grid card edits in a row under its truck row, never floating over other cards; overdue dates start on today',async t=>{const f=setup(t),T=await load();
 const a=list(f,{name:'Alpha',neededOn:'2026-09-24'}),b=list(f,{name:'Bravo',neededOn:'2026-09-24'});f.cmd('bookTruck',{id:a.id,truck:f.truck.id});f.cmd('bookTruck',{id:b.id,truck:f.truck.id});
 T.setState(f.sim.snapshot(),acct(f));T.setView('SCHEDULE');T.schedWeek(null);T.schedOpen().clear();T.schedOpen().add(a.id);const html=T.scheduleView();T.schedOpen().clear();
 const grid=html.slice(html.indexOf('class="sch-grid"'),html.indexOf('class="sch-days"'));
 assert.equal((grid.match(/class="sch-detail /g)??[]).length,1,'one detail row in the grid');assert.ok(grid.includes('class="sch-detail at-3"'),'the notch points at Thursday');
 const card=grid.slice(grid.indexOf('data-sch-card="'+a.id+'"'));assert.ok(card.indexOf('class="sch-edit"')>card.indexOf('class="sch-detail '),'the grid card itself carries no editor');
 assert.ok(grid.indexOf('data-sch-card="'+b.id+'"')<grid.indexOf('class="sch-detail '),'the other card in the cell stays above the editor row');
 t.mock.timers.setTime(Date.parse('2026-09-25T00:00:00Z'));T.setState(f.sim.snapshot(),acct(f));T.setView('SITES');const sites=T.requestView();
 assert.ok(sites.includes('Was needed <b>Thu 24 Sep</b>'),'overdue hint');assert.ok(/min="2026-09-25" max="[^"]+" value="2026-09-25"/.test(sites),'overdue form starts on today, so it is valid as shown');});

test('Sites: an unbooked list offers a blank reserve truck; a planned truck is preselected; single requests can be booked',async t=>{const f=setup(t),T=await load();
 const a=list(f,{name:'Unbooked',neededOn:'2026-09-24'}),b=list(f,{name:'Planned',neededOn:'2026-09-24'});f.cmd('bookTruck',{id:b.id,truck:f.truck.id});
 const r=f.cmd('request',{site:f.site.id,product:f.products[0].id,quantity:4,neededOn:'2026-09-24'});
 T.setState(f.sim.snapshot(),acct(f));T.setView('SITES');const html=T.requestView();
 const card=id=>html.slice(html.indexOf('data-load-list="'+id+'"'),html.indexOf('</section>',html.indexOf('data-load-list="'+id+'"')));
 assert.ok(card(a.id).includes('<option value="" selected>Choose a truck</option>'),'no silent default truck');assert.ok(card(a.id).includes('Planned truck'));
 assert.ok(!card(b.id).includes('Choose a truck'),'the planned truck is the default');
 const req=html.slice(html.indexOf('data-request="'+r.id+'"'));assert.ok(req.includes('data-sch-book="'+r.id+'"'),'single requests get the booking form');assert.ok(html.includes('1 needs a truck</span>'),'the Sites pill counts like the Schedule');});
test('late-only pill reads "N late"; the Overview counts undated loads; an undated Sites card offers a blank "Set a date"',async t=>{const f=setup(t),T=await load();
 const a=list(f,{name:'Due Wed',neededOn:'2026-09-23'});T.setState(f.sim.snapshot(),acct(f));assert.ok(T.homeDue().includes('>1 due today<'),'due today alone');
 t.mock.timers.setTime(Date.parse('2026-09-24T00:00:00Z'));T.setState(f.sim.snapshot(),acct(f));const pill=T.homeDue();
 assert.ok(pill.includes('>1 late<'),'late only: '+pill);assert.ok(!pill.includes('0 due today')&&!pill.includes('&middot;'),'no "0 due today"');
 f.cmd('bookTruck',{id:a.id,truck:f.truck.id});f.cmd('reschedule',{id:a.id,neededOn:'2026-09-25'});T.setState(f.sim.snapshot(),acct(f));T.setView('OVERVIEW');
 assert.ok(T.overviewView().includes('Every load is dated and booked'),'dated and booked');
 const r=f.cmd('request',{site:f.site.id,product:f.products[0].id,quantity:3});T.setState(f.sim.snapshot(),acct(f));const ov=T.overviewView();
 assert.ok(ov.includes('1 with no date'),'undated load counted');assert.ok(!ov.includes('Every load is dated and booked'),'not claimed when a load has no date');
 T.setView('SITES');const html=T.requestView(),req=html.slice(html.indexOf('data-request="'+r.id+'"'),html.indexOf('</section>',html.indexOf('data-request="'+r.id+'"')));
 assert.ok(req.includes('<button>Set a date</button>')&&!req.includes('Change date'),'undated: Set a date');assert.ok(/name="neededOn" required min="2026-09-24" max="[^"]+" value=""/.test(req),'undated: the date input starts empty');
 const lc=html.slice(html.indexOf('data-load-list="'+a.id+'"'),html.indexOf('</section>',html.indexOf('data-load-list="'+a.id+'"')));assert.ok(lc.includes('<button>Change date</button>')&&lc.includes('value="2026-09-25"'),'dated: Change date, prefilled');});
