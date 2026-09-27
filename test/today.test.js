process.env.TZ='Australia/Sydney';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fixture } from './simulation.test.js';
import { openDatabase } from '../src/database.js';
import { createApp } from '../src/server.js';
import { tdAppIcon } from '../public/art.js';
import { ICONS } from '../scripts/make-icons.js';
// The Today page (td*) rendered in node from live snapshots, its pure helpers, and the installable app: manifest, icons and the index.html links.
const load=async()=>(await import('../public/operations.js'));
const acct=(f,perms=['operations.manage','stock.adjust','requests.create'])=>({permissions:perms,systems:[],users:[],company:{id:'c',name:'Demo'},user:{id:f.user.id}});
const WED=Date.parse('2026-09-23T00:00:00Z');
const setup=t=>{const f=fixture(t);t.mock.timers.enable({apis:['Date'],now:WED});return f;};
const list=(f,extra={})=>f.cmd('createLoadList',{site:f.site.id,lines:[{product:f.products[0].id,quantity:10}],...extra});
const css=readFileSync(new URL('../public/design.css',import.meta.url),'utf8');

test('a link picks the page to open: ?view=TODAY (any case) or any other page, nothing for unknown pages',async()=>{const {tdTest}=await load();
 assert.equal(tdTest.viewFrom('?view=TODAY'),'TODAY');assert.equal(tdTest.viewFrom('?view=today'),'TODAY');assert.equal(tdTest.viewFrom('?view=SCHEDULE&x=1'),'SCHEDULE');
 for(const v of ['','?','?view=','?view=ADMIN','?other=TODAY',null,undefined])assert.equal(tdTest.viewFrom(v),null,String(v));});

test('date words come from the server day string, never the browser clock',async()=>{const {tdTest}=await load();
 assert.deepEqual(tdTest.date('2026-09-26'),{weekday:'Saturday',short:'Sat',day:26,month:'September',mon:'Sep',year:2026,long:'Saturday 26 September 2026'});
 assert.equal(tdTest.date('2026-10-05').weekday,'Monday');assert.equal(tdTest.date('2027-01-01').long,'Friday 1 January 2027');
 for(const v of [null,'','26/09/2026','2026-9-6'])assert.equal(tdTest.date(v),null);});

test('returns due today are read only when the snapshot carries them, open ones first',async()=>{const {tdTest}=await load();
 assert.equal(tdTest.returns({},'2026-09-23'),null,'no returns in the snapshot: null (the page shows overdue loads instead)');
 const s={sites:[{id:'s1',name:'George Street'}],returns:[{id:'a',site:'s1',neededOn:'2026-09-23',quantity:12,status:'RETURNED'},{id:'b',site:'s1',neededOn:'2026-09-23',pieces:30,status:'OPEN',slot:'AM'},{id:'c',neededOn:'2026-09-24'},{id:'d',neededOn:'2026-09-23',cancelled:true},{id:'e',urgency:'TODAY',siteName:'Kent St'}]};
 const r=tdTest.returns(s,'2026-09-23');assert.deepEqual(r.map(x=>x.id),['b','e','a']);assert.equal(r[0].siteName,'George Street');assert.equal(r[0].pieces,30);assert.equal(r[2].done,true);assert.equal(r[2].pieces,12);
 assert.deepEqual(tdTest.returns({collections:[{id:'x',date:'2026-09-23'}]},'2026-09-23').map(x=>x.id),['x'],'collections work the same way');});

test('the day: loads due today (live first, AM before PM), overdue oldest first, the next booked day, crew and alerts',async t=>{const f=setup(t),{tdTest}=await load();
 const a=list(f,{name:'Due PM',neededOn:'2026-09-23',slot:'PM'}),b=list(f,{name:'Due AM',neededOn:'2026-09-23',slot:'AM'}),late=list(f,{name:'Late one',neededOn:'2026-09-24'});list(f,{name:'Friday',neededOn:'2026-09-25'});list(f,{name:'Next week',neededOn:'2026-09-28'});
 f.cmd('bookTruck',{id:a.id,truck:f.truck.id});
 t.mock.timers.setTime(Date.parse('2026-09-24T22:00:00Z'));// Friday 25 Sep in Sydney: 'Late one' (Thu) is overdue
 f.cmd('reschedule',{id:a.id,neededOn:'2026-09-25',slot:'PM'});f.cmd('reschedule',{id:b.id,neededOn:'2026-09-25',slot:'AM'});
 const s=f.sim.snapshot(),d=tdTest.day(s);
 assert.equal(d.today,'2026-09-25');assert.deepEqual(d.due.map(x=>x.name),['Due AM','Friday','Due PM']);assert.equal(d.dueLive.length,3);assert.equal(d.noTruck,2);assert.equal(d.reserved,0);
 assert.deepEqual(d.late.map(x=>x.id),[late.id]);assert.equal(d.late[0].daysLate,1);
 assert.equal(d.next,'2026-09-28');assert.equal(d.nextCount,1);
 assert.equal(d.crew.length,s.resources.filter(r=>r.type==='WORKER'&&r.location===f.yard.id).length);assert.equal(d.busy+d.idle,d.crew.length);
 assert.equal(d.alerts,s.alerts);assert.equal(d.returns,null);
 const empty=tdTest.day({});assert.deepEqual([empty.due,empty.late,empty.crew,empty.trucks],[[],[],[],[]]);assert.equal(empty.alerts.count,0);});

test('the Today page: hero with the date and four counters, a card per part of the day, one-tap actions, no inline styles',async t=>{const f=setup(t),{__test,tdTest}=await load();
 const booked=list(f,{name:'Level 3 handrails',neededOn:'2026-09-23',slot:'AM'}),open=list(f,{name:'Ground lift',neededOn:'2026-09-23'});f.cmd('bookTruck',{id:booked.id,truck:f.truck.id});
 const s=f.sim.snapshot();__test.setState(s,acct(f));__test.setView('TODAY');const html=tdTest.view();
 assert.ok(html.includes('<h1>Today</h1>'));assert.ok(html.includes('Wednesday 23 September 2026'),'the long date');assert.ok(html.includes('SCAFFOLD / Today'),'the eyebrow names the page');
 assert.match(html,/data-td-jump="loads"[\s\S]*?Due today<\/span><b class="hud-num">2</);
 for(const k of ['late','alerts','crew'])assert.ok(html.includes('data-td-jump="'+k+'"'),'counter '+k);
 for(const id of ['loads','alerts','trucks','crew','quick'])assert.ok(html.includes('id="td-'+id+'"'),'card '+id);
 assert.ok(!html.includes('id="td-late"'),'no overdue card when nothing is late');assert.ok(!html.includes('id="td-returns"'),'no returns card without returns in the snapshot');
 assert.ok(html.includes('data-sch-reserve="'+booked.id+'"'),'Reserve on the load booked on a truck at the yard');
 assert.match(html,new RegExp('class="td-btn td-primary" data-sch-goto="'+open.id+'"[^>]*>[\\s\\S]*?Book a truck'),'Book a truck for the one without');
 assert.ok(html.includes('data-pr-print="pick" data-pr-id="'+booked.id+'"')&&html.includes('data-pr-print="pick" data-pr-id="'+open.id+'"'),'Print pick list on each');
 assert.ok(html.includes('data-sch-goto="'+booked.id+'" data-day="2026-09-23"'),'Open goes to the card on the Schedule');
 for(const a of s.alerts.items.slice(0,5))assert.ok(html.includes('data-al-go="'+a.id+'"'),'alert '+a.id);
 assert.ok(html.includes('data-td-crew="next"')&&html.includes('data-td-crew="auto"'),'crew bulk orders');assert.ok(html.includes('data-td-go="stock"')&&html.includes('data-sch-create')&&html.includes('data-td-go="search"'),'quick actions');
 assert.ok(html.includes('data-view="TRUCK12"'),'a truck opens its garage');
 assert.ok(!/\sstyle="/.test(html),'no inline style attributes (the CSP drops them)');
 const ids=[...html.matchAll(/\sid="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length,'ids are unique');
 __test.setState(f.sim.snapshot(),acct(f,['requests.create','sites.assigned']));const sup=tdTest.view();
 assert.ok(!sup.includes('data-sch-reserve')&&!sup.includes('data-td-crew')&&!sup.includes('data-td-go="stock"'),'a supervisor sees the day without the yard controls');assert.ok(sup.includes('data-td-go="search"'));});

test('an overdue load gets its own card and counter; an empty day says what comes next',async t=>{const f=setup(t),{__test,tdTest}=await load();
 const late=list(f,{name:'Old gantry return',neededOn:'2026-09-24'});list(f,{name:'Next',neededOn:'2026-09-28'});t.mock.timers.setTime(Date.parse('2026-09-24T22:00:00Z'));
 __test.setState(f.sim.snapshot(),acct(f));__test.setView('TODAY');const html=tdTest.view();
 assert.ok(html.includes('id="td-late"')&&html.includes('data-td-load="'+late.id+'"'));assert.match(html,/Overdue<\/span><b class="hud-num">1<\/b><span class="hud-sub">Oldest 24 Sep/);
 assert.ok(html.includes('Nothing due out today.')&&html.includes('Next: 1 load on Mon 28 Sep'),'the empty loads card points at the next booked day');});

test('the design has one Today block in design.css, scoped to the page, with phone rules and 44 px targets',()=>{
 const at=css.indexOf('/* ===== TODAY PAGE (td-)');assert.ok(at>0);const next=css.indexOf('/* ===== ',at+10),block=css.slice(at,next<0?undefined:next);// the merge appends later features' blocks after it
 const flat=block.replace(/\/\*[\s\S]*?\*\//g,'').replace(/@keyframes td-flash\{(?:[^{}]*\{[^{}]*\})*\s*\}/g,'').replace(/@media[^{]*\{/g,'');
 const selectors=[...flat.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap(m=>m[1].split(',').map(x=>x.trim())).filter(Boolean);
 assert.ok(selectors.length>80);for(const sel of selectors)assert.ok(/^(\.content )?\.page-today\b/.test(sel),'scoped to the page: '+sel);
 assert.match(block,/@media\(max-width:650px\)/);assert.match(block,/\.td-btn\{[^}]*min-height:44px/);});

test('the installable app: manifest, icons and the page links, served with the right types',async t=>{
 const manifest=JSON.parse(readFileSync(new URL('../public/manifest.webmanifest',import.meta.url),'utf8'));
 assert.equal(manifest.name,'Scaffold Yard');assert.ok(manifest.short_name&&manifest.short_name.length<=14);assert.equal(manifest.start_url,'/?view=TODAY');assert.equal(manifest.display,'standalone');assert.equal(manifest.theme_color,'#16382c');
 assert.ok(manifest.icons.some(i=>i.sizes==='192x192')&&manifest.icons.some(i=>i.sizes==='512x512'&&i.purpose==='maskable'));
 const png=file=>{const b=readFileSync(new URL('../public'+file,import.meta.url));assert.equal(b.toString('latin1',1,4),'PNG',file);return [b.readUInt32BE(16),b.readUInt32BE(20)];};
 for(const i of manifest.icons){const [w,h]=png(i.src);assert.equal(w+'x'+h,i.sizes,i.src);}
 for(const i of ICONS){assert.ok(existsSync(new URL('../public/icons/'+i.file,import.meta.url)),i.file);assert.deepEqual(png('/icons/'+i.file),[i.size,i.size]);}
 const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 for(const s of ['<link rel="manifest" href="/manifest.webmanifest">','<meta name="theme-color" content="#16382c">','<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">'])assert.ok(html.includes(s),s);
 for(const art of [{},{rounded:true},{maskable:true},{small:true}]){const svg=tdAppIcon(art);assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'));assert.ok(!/<image|href="http|url\(http/.test(svg),'self-contained');}
 const db=openDatabase(':memory:'),server=createApp(db);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));db.close();});
 const base='http://127.0.0.1:'+server.address().port;
 const m=await fetch(base+'/manifest.webmanifest');assert.equal(m.status,200);assert.equal(m.headers.get('content-type'),'application/manifest+json');assert.equal((await m.json()).start_url,'/?view=TODAY');
 for(const u of ['/icons/icon-192.png','/icons/icon-512.png','/icons/icon-maskable-512.png','/icons/apple-touch-icon.png','/icons/icon-32.png']){const r=await fetch(base+u);assert.equal(r.status,200,u);assert.equal(r.headers.get('content-type'),'image/png');assert.equal(Buffer.from(await r.arrayBuffer()).toString('latin1',1,4),'PNG');}
 assert.equal((await fetch(base+'/icons/../server.js')).status,404,'only the listed files are served');assert.equal((await fetch(base+'/icons/other.png')).status,404);
 assert.equal((await fetch(base+'/?view=TODAY')).status,200,'the start page loads with its query');});
