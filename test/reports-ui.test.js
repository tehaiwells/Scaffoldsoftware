process.env.TZ='Australia/Sydney';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../src/simulation.js';
import { fixture } from './simulation.test.js';
// Client side of the Reports page, rendered in node from a live report: the page, the SVG charts at a few widths, tooltips and the table twins.
const load=async()=>{const m=await import('../public/operations.js');return {T:m.__test,H:m.__hc};};
const acct=(f,user=f.user,perms=['operations.manage','stock.adjust','requests.create'])=>({permissions:perms,systems:[{id:'quickstage',name:'Quickstage'}],users:[],company:{id:'c',name:'Demo'},user:{id:user.id}});
const settle=(f,n=150)=>{f.tick(n);for(const task of f.sim.tasks().filter(t=>t.state==='BLOCKED'))f.cmd('retry',{id:task.id});f.tick(n);};
const deliver=f=>{f.cmd('loadTruck',{truck:f.truck.id,containers:[f.a.id]});settle(f);f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});f.tick(5);f.cmd('unload',{id:f.truck.id});settle(f,60);f.cmd('dispatch',{id:f.truck.id,destination:f.yard.id});f.tick(5);};
const setup=t=>{t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-21T00:00:00Z')});const f=fixture(t);t.mock.timers.setTime(Date.parse('2026-09-23T00:00:00Z'));deliver(f);return f;};

test('the Reports page: hero counters, period switch, five cards with the ledger check, and a nav entry after Stock',async t=>{const f=setup(t),{T,H}=await load();
 T.setState(f.sim.snapshot(),acct(f));T.setView('REPORTS');H.setData(f.sim.reports(30),30);const html=H.view();
 assert.ok(html.includes('<h1>Reports</h1>'));assert.ok(html.includes('class="hc-hero page-hero"'),'the page hero style');
 for(const key of ['pieces','weeks','trucks','materials','systems'])assert.ok(html.includes('data-hc-card="'+key+'"'),'card '+key);
 assert.ok(html.includes('Matches today&rsquo;s live count (100)'),'the rebuilt yard equals the live yard');
 assert.ok(/data-hc-days="30" aria-pressed="true"/.test(html)&&/data-hc-days="90" aria-pressed="false"/.test(html));
 assert.ok(/1 delivery \(100 pieces\) and 0 returns/.test(html),'the weekly summary in words');
 const src=(await import('node:fs')).readFileSync(new URL('../public/operations.js',import.meta.url),'utf8');assert.ok(src.includes("['STOCK','Stock'],['REPORTS','Reports'],['MATERIALS'"),'nav: Reports right after Stock');});

test('charts are SVG drawn to the width, with clean ticks, labelled axes and a tooltip per value',async t=>{const f=setup(t),{T,H}=await load();
 T.setState(f.sim.snapshot(),acct(f));T.setView('REPORTS');H.setData(f.sim.reports(30),30);
 for(const w of [313,431,930,1450]){for(const key of ['pieces','weeks','trucks','materials','systems']){const svg=H.svg(key,w);assert.ok(svg.startsWith('<svg class="hc-svg-el" width="'+w+'"'),key+' at '+w);assert.ok(!/NaN|undefined|Infinity/.test(svg),key+' at '+w+' has no broken numbers');}}
 const line=H.svg('pieces',930);assert.ok(line.includes('class="hc-line"')&&line.includes('class="hc-area"')&&line.includes('class="hc-end"'),'line, wash and end label');assert.ok(/<text class="hc-tick"[^>]*>21 Sep<\/text>/.test(line),'Mondays on the x axis');
 assert.deepEqual(H.ticks(655,4),[0,200,400,600,800]);assert.deepEqual(H.ticks(3,4),[0,1,2,3]);assert.deepEqual(H.ticks(0,4),[0,1]);
 const tip=H.tip('pieces',29);assert.equal(tip.title,'Wed 23 Sep · today');assert.deepEqual(tip.lines[0].slice(1),['100','pieces in the yard']);
 const wk=H.tip('weeks',4);assert.match(wk.title,/^Week of Mon 21 Sep/);assert.equal(wk.lines[0][1],'1');
 const tr=H.tip('trucks',0);assert.equal(tr.title,'T01');assert.equal(tr.lines[0][1],'1');assert.equal(tr.lines[1][1],'100');});

test('table twins list every value; names are escaped everywhere',async t=>{const f=setup(t),{T,H}=await load();
 const p=f.sim.repo.get(f.products[0].id);p.name='<img src=x onerror=alert(1)> & Co';f.sim.repo.save(p);
 T.setState(f.sim.snapshot(),acct(f));T.setView('REPORTS');H.setData(f.sim.reports(30),30);
 const rows=H.table('pieces');assert.equal((rows.match(/<tr>/g)??[]).length,31,'a header and one row per day');assert.ok(rows.includes('Wed 23 Sep (today)'));
 for(const out of [H.view(),H.svg('materials',500),H.table('materials')]){assert.ok(!out.includes('<img src=x'),'no raw markup');}
 assert.ok(H.table('materials').includes('&lt;img src=x onerror=alert(1)&gt; &amp; Co'));
 H.tables.add('weeks');assert.ok(H.view().includes('<table class="hc-table">'),'a card switched to its table');H.tables.clear();});

test('supervisors get their sites only: no fleet card, site wording, and the empty states read well',async t=>{const f=setup(t),{T,H}=await load();
 f.auth.addUser(f.user,{name:'Sup',email:'sup-ui@example.com',password:'demonstration-password',roles:['SUPERVISOR']});const u=f.auth.authenticate(f.auth.login({email:'sup-ui@example.com',password:'demonstration-password'}));
 const sup=new Simulation(f.db,u);T.setState(sup.snapshot(),acct(f,u,['sites.assigned','requests.create']));T.setView('REPORTS');H.setData(sup.reports(30),30);let html=H.view();
 assert.ok(!html.includes('data-hc-card="trucks"'),'no fleet chart');assert.ok(html.includes('Pieces at your sites, day by day'));assert.ok(html.includes('Nothing on your sites during this period.'),'no sites assigned yet: empty state');assert.ok(html.includes('Your sites: none assigned yet'));
 f.cmd('siteDetails',{id:f.site.id,supervisor:u.id});H.setData(sup.reports(30),30);html=H.view();
 assert.ok(html.includes('Your sites: Site A'));assert.ok(html.includes('Matches today&rsquo;s live count (100)'));assert.ok(!html.includes('Pause simulation'),'no pause button for a supervisor');});

test('before the first report arrives the page shows a loading card, and an error offers a retry',async t=>{const f=setup(t),{T,H}=await load();
 T.setState(f.sim.snapshot(),acct(f));T.setView('REPORTS');H.setData(null);assert.ok(H.view().includes('Adding up the ledger'));
 H.setError('Something went wrong. Please try again.',30);const html=H.view();assert.ok(html.includes('data-hc-retry')&&html.includes('The report could not be loaded.'));H.setError(null);});
