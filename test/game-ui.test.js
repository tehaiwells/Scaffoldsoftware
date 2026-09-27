import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openDatabase,atomic } from '../src/database.js';
import { Service } from '../src/service.js';
import { Simulation } from '../src/simulation.js';
import { __gm,officeHTML,OFFICE_TILES,cardHTML,cardTight } from '../public/game.js';
import { gaKind,gaLook,gaLength,gaLenTag,GA_TABS,gaTab,gaFamily } from '../public/game-art.js';

// The game board's builders are plain strings from a snapshot (no DOM), so the main screen's content is checked in node.
function board(t,{systems=['quickstage']}={}){
  const db=openDatabase(':memory:');t.after(()=>db.close());const auth=new Service(db);
  const user=auth.authenticate(auth.register({name:'Owner',companyName:'Harbour',email:randomUUID()+'@example.com',password:'demonstration-password',systems}));
  const sim=new Simulation(db,user);const cmd=(a,i={})=>sim.execute(a,i,randomUUID());
  const account={company:{id:user.company_id,name:'Harbour'},user:{id:user.id,name:'Owner'},permissions:auth.permissions(user)};
  const tick=n=>{for(let i=0;i<n;i++)atomic(db,()=>sim.tick(1000));};
  return {db,sim,cmd,account,tick,snap:()=>sim.snapshot(0,{lean:true})};
}
const ctxOf=(f,s)=>({state:s,account:f.account,hire:true});
const fast=f=>{const c=f.sim.repo.all('config')[0];Object.assign(c,{stepMs:100,speed:100000,jobs:false,routineJobs:false});f.sim.repo.save(c);};

test('first run: the board asks for a yard size (three pictures and a way to draw your own), then shows the map, three big buttons and the inventory',t=>{
  const f=board(t);__gm.reset();let html=__gm.shell(ctxOf(f,f.snap()));
  assert.match(html,/How big is your yard\?/);for(const k of ['S','M','L'])assert.ok(html.includes('data-gm-size="'+k+'"'));assert.ok(html.includes('data-gm-draw'),'Draw my own shape instead');
  assert.ok(!/\d+ × \d+ m/.test(html),'no measurements on the size cards');
  const r=f.cmd('gameStart',{size:'M'});assert.ok(!/\d/.test(r.message),'the welcome has no numbers in it');html=__gm.shell(ctxOf(f,f.snap()));
  assert.ok(html.includes('data-wm-host'),'the live world map');assert.ok(html.includes('aria-label="What do you want to do?"'));
  for(const k of ['send','back','add'])assert.ok(html.includes('data-gm-go="'+k+'"'),k);assert.ok(html.includes('data-gm-dock'),'the inventory window');assert.ok(html.includes('data-gm-office'),'the Office door');
  assert.ok(!/hud-stat|al-strip|sg-guide|simulation-banner/.test(html),'no counters, alert strips, set-up checklist or banners on the main screen');
});

test('the parts list: no parts yet, the inventory asks which scaffold with three pictures; nothing loads until one is picked',t=>{
  const f=board(t,{systems:['quickstage','at-pac','tube-clip']});f.cmd('gameStart',{size:'S'});const s=f.snap();__gm.reset();__gm.shell(ctxOf(f,s));__gm.setMode('yard');
  const grid=__gm.grid(s);for(const id of ['quickstage','at-pac','tube-clip'])assert.ok(grid.includes('data-gm-system="'+id+'"'),id);
  assert.match(__gm.acts(s),/data-gm-do="parts" disabled/,'Load my parts list waits for a pick');
  assert.equal(__gm.hint(s),null,'on a desktop the inventory window itself asks: no second message in a hint');
  __gm.state().systems.add('quickstage');assert.ok(!/data-gm-do="parts" disabled/.test(__gm.acts(s)));
  f.cmd('gameCatalogue',{systems:['quickstage']});assert.ok(f.sim.repo.all('product').every(p=>p.system==='quickstage'),'only the picked system loads');
  const on=f.db.prepare('SELECT system_id FROM company_systems WHERE company_id=? AND enabled=1').all(f.sim.user.company_id).map(r=>r.system_id);assert.deepEqual(on,['quickstage'],'the pick becomes the company\'s systems');
});

test('the Office holds every other page as a picture tile in three short groups, marks the open one, and leaves Hire out for people who may not see it',t=>{
  const f=board(t);f.cmd('gameStart',{size:'S'});const s=f.snap();
  const html=officeHTML({state:s,account:f.account,hire:true,view:'STOCK'});assert.match(html,/<nav class="gm-tiles" aria-label="Main navigation">/);
  for(const [v] of OFFICE_TILES)assert.ok(html.includes('data-view="'+v+'"'),v);assert.ok(html.includes('id="settings"'),'Account');
  for(const g of ['Every day','Yard and fleet','Business'])assert.ok(html.includes('>'+g+'</h3>'),g);
  assert.match(html,/class="gm-tile current" data-view="STOCK" aria-current="page"/);assert.ok(!officeHTML({state:s,account:f.account,hire:false}).includes('data-view="HIRE"'));
  for(const v of ['TODAY','SCHEDULE','WORKERS','EQUIPMENT','TRUCK12','TRUCK2','STOCK','REPORTS','MATERIALS','SITES','HIRE','YARD','OVERVIEW','CONTROL'])assert.ok(OFFICE_TILES.some(x=>x[0]===v),'no page is lost: '+v);
  assert.ok(!OFFICE_TILES.some(x=>x[0]==='HOME'),'Home is the game board itself, not a tile');
});

test('the inventory: the yard at a glance, the whole catalogue to add, free stock to send, a site\'s stock to bring back; one short number per slot',t=>{
  const f=board(t);f.cmd('gameStart',{size:'M'});f.cmd('gameCatalogue');fast(f);
  const ps=f.sim.repo.all('product'),std=ps.find(p=>p.name==='Kwikstage standard 3.0 m'),led=ps.find(p=>p.name==='Kwikstage ledger 2.4 m');
  f.cmd('gameAddStock',{lines:[{product:std.id,quantity:1640},{product:led.id,quantity:290}]});const {site}=f.cmd('gameSite',{name:'George St'});
  let s=f.snap();__gm.reset();__gm.shell(ctxOf(f,s));
  __gm.setMode('yard');let items=__gm.gridItems(s);assert.deepEqual(items.map(x=>x.p.id).sort(),[std.id,led.id].sort(),'only what is in the yard');
  let grid=__gm.grid(s);assert.ok(grid.includes('<b class="gm-n">1.6k</b>'),'1640 shows as 1.6k');assert.ok(!grid.includes('gm-len'),'no lengths on the yard at a glance (they are on the card)');assert.ok(grid.includes('gm-void'),'empty slots fill the rows');
  assert.ok(!/\sstyle="/.test(grid),'no inline styles (the CSP drops them)');
  __gm.setMode('add');items=__gm.gridItems(s);assert.equal(items.length,ps.length,'Add stock offers every part');grid=__gm.grid(s);assert.ok(grid.includes('<i class="gm-len">3m</i>'),'while picking, the length is in the corner');assert.ok(!grid.includes('class="gm-n"'),'the catalogue has no counts');
  __gm.pick(std.id,82);grid=__gm.grid(s);const slot=grid.slice(grid.indexOf('data-gm-slot="'+std.id+'"'));assert.match(slot.slice(0,slot.indexOf('</button>')),/<b class="gm-n gm-n-pick">82<\/b>/,'a picked slot shows how many, in the one corner');
  assert.equal((slot.slice(0,slot.indexOf('</button>')).match(/class="gm-n/g)??[]).length,1,'never two numbers on one slot');
  __gm.setMode('send',site.id);__gm.state().picks=new Map();items=__gm.gridItems(s);assert.equal(items.find(x=>x.p.id===std.id).count,1640,'free to send');
  f.cmd('gameSend',{site:site.id,lines:[{product:std.id,quantity:1}]});for(let i=0;i<200&&f.sim.repo.all('truck').some(t=>t.game);i++)f.tick(1);s=f.snap();
  __gm.setMode('site',site.id);items=__gm.gridItems(s);assert.equal(items.length,1);assert.ok(items[0].count>0,'the site grid shows what is on site');
  const card=cardHTML(s,std);assert.match(card,/In the yard/);assert.match(card,/George St/);assert.match(card,/17.5 kg each/);assert.match(card,/Length 3 m/);
});

test('Send shows what rides along on a mixed stillage before the button is pressed, and says how full the truck will be in words',t=>{
  const f=board(t);f.cmd('gameStart',{size:'S'});f.cmd('gameCatalogue');const ps=f.sim.repo.all('product'),a=ps.find(p=>p.name==='Kwikstage standard 3.0 m'),b=ps.find(p=>p.name==='Kwikstage ledger 2.4 m');
  const {site}=f.cmd('gameSite',{name:'Kent St'});const s=f.snap();__gm.reset();__gm.shell(ctxOf(f,s));__gm.setMode('send',site.id);
  __gm.setItems(s.yards[0].id,[{id:'C1',name:'S-001',support:null,lines:[[a.id,40],[b.id,12]],busy:false}]);__gm.pick(a.id,40);
  const acts=__gm.acts(s);assert.match(acts,/Also on those stillages/);assert.match(acts,/<b class="gm-n">12<\/b>/,'the ledgers riding along');assert.match(acts,/Fills a truck: a little/);assert.match(acts,/On the next free truck, today/);
  assert.match(__gm.amount(s),/1 stillage · all of it/);
});

test('one hint at a time, in the order a new owner needs them; they point at the button or the place they talk about',t=>{
  const f=board(t);f.cmd('gameStart',{size:'S'});__gm.reset();__gm.shell(ctxOf(f,f.snap()));__gm.setMode('yard');
  assert.equal(__gm.hint(f.snap()),null,'no parts: the inventory asks, not a hint');f.cmd('gameCatalogue');let h=__gm.hint(f.snap());assert.equal(h.id,'add');assert.equal(h.point,'add');assert.deepEqual(h.act,['Add stock','add']);
  const p=f.sim.repo.all('product')[0];f.cmd('gameAddStock',{lines:[{product:p.id,quantity:5}]});h=__gm.hint(f.snap());assert.equal(h.id,'site');assert.match(h.text,/tap an empty block on the map/);
  f.cmd('gameSite',{name:'Kent St'});h=__gm.hint(f.snap());assert.equal(h.id,'send');assert.match(h.text,/Kent St/);assert.equal(h.point,'send');
  const st=f.snap();const done={...st,sites:st.sites.map(x=>({...x,lastDeliveryAt:new Date().toISOString()}))};h=__gm.hint(done);assert.equal(h.id,'tapsite');assert.equal(h.target,st.sites[0].id,'it points at the site on the map');
  __gm.state().hintOff.add('tapsite');assert.equal(__gm.hint(done),null,'dismissed for good');
});

test('trucks in words, only while something is happening: loading, on the way, arriving soon, how full, and a Send waiting for a truck',t=>{
  const f=board(t);f.cmd('gameStart',{size:'S'});const s=f.snap(),truck=s.trucks[0];
  assert.equal(__gm.trips(s),'','nothing in the corner while every truck is parked');assert.equal(__gm.truckWords(s,truck).word,'Ready at the yard');
  const site={id:'S1',name:'George St',status:'ACTIVE'};const st={...s,sites:[site]};
  assert.match(__gm.truckWords(st,{...truck,status:'IN_TRANSIT',destination:'S1',remainingMs:20000,loadedWeight:6250000}).word,/^On the way to George St · half full$/);
  assert.match(__gm.truckWords(st,{...truck,status:'IN_TRANSIT',destination:'S1',remainingMs:3000}).word,/arriving soon/);
  assert.match(__gm.truckWords({...st,tasks:[{to:truck.id}]},{...truck,destination:'S1'}).word,/^Loading for George St/);
  assert.equal(__gm.truckWords(st,{...truck,game:{problem:'No crane here.'}}).word,'Waiting: No crane here.');
  const trips=__gm.trips({...st,trucks:[{...truck,status:'IN_TRANSIT',destination:'S1',remainingMs:20000}]});assert.match(trips,/On the way to George St/);assert.ok(!trips.includes('>'+truck.name+'<'),'the truck\'s code is only in its tooltip');
  const wait=__gm.trips({...st,gameOrders:[{id:'o1',type:'SEND',site:'S1'}]});assert.match(wait,/Waiting for a truck/);assert.match(wait,/To George St/);assert.match(wait,/data-gm-cancel="o1"/);
});

test('item pictures know scaffold parts by name first, then by category, with a look for each family',()=>{
  const k=name=>gaKind({name}),kc=(name,category)=>gaKind({name,category});
  assert.equal(k('Kwikstage standard 3.0 m'),'standard');assert.equal(k('Kwikstage ledger 2.4 m'),'ledger');assert.equal(k('Kwikstage transom 1.2 m'),'transom');assert.equal(k('Face brace 2.7 m'),'brace');
  assert.equal(k('Scaffold tube 6.3 m'),'tube');assert.equal(k('Double coupler'),'coupler');assert.equal(k('Kwikstage steel board / plank 0.7 m'),'plank');assert.equal(k('Timber plank 230 x 38 mm 2.4 m'),'board');
  assert.equal(k('Toe board 2.4 m'),'toeboard');assert.equal(k('Adjustable base jack'),'jack');assert.equal(k('Kwikstage sole board 0.5 m'),'plate');assert.equal(k('Aluminium ladder 6 m'),'ladder');assert.equal(k('Aluminium lattice beam 6.1 m'),'beam');
  assert.equal(kc('Aluminium ladder 3.0 m','Stairs & ladders'),'ladder','the name wins over the category');assert.equal(kc('Ledger to plank transom O-Type 0.7 m','Decking / planks'),'transom');assert.equal(kc("Swivel clamp brace 7' (2.13 m)",'Couplers & fittings'),'brace');
  assert.equal(kc('Caster 12" (0.30 m)','Accessories'),'wheel');assert.equal(kc('A-Frame Barricading','Accessories'),'box');assert.equal(kc('Mystery part','Transoms'),'transom','the category when the name says nothing');
  const look=name=>gaLook({name});assert.equal(look('Steel plank O-type 1.82 m x 240 mm'),'steel');assert.equal(look('Laminated veneer lumber (LVL) plank 1.82 m'),'lvl');assert.equal(look('Infill plank 1.82 m'),'infill');assert.equal(look('Boiler Infill Plank 1.82 m'),'boiler');assert.equal(look('Corner plank 1.82 m'),'corner');
  assert.equal(look('Kwikstage standard 2.0 m'),'cup');assert.equal(look('Ringlock standard 2.0 m'),'ring');assert.equal(look('Aluminum Tube 3.05 m'),'alu');assert.equal(look('Mid transom O-Type 1.065 m'),'mid');assert.equal(look('Swivel coupler 48 mm'),'swivel');
  assert.equal(gaFamily({name:'Steel plank O-type 2.43 m x 240 mm'}),gaFamily({name:'Steel plank O-type 0.65 m x 240 mm'}),'one family, short to long');
  assert.equal(gaLength({name:'Ledger 2400 mm'}),2.4);assert.equal(gaLength({name:'Tube',length:6300}),6.3);assert.equal(gaLenTag({name:'Kwikstage ledger 0.7 m'}),'0.7m');assert.equal(gaLenTag({name:'Double coupler'}),'');
  assert.deepEqual(GA_TABS.map(x=>x.id),['all','tubes','frame','boards','fittings','access','beams']);assert.equal(gaTab({name:'Scaffold tube 3 m'}),'tubes');assert.equal(gaTab({name:'Kwikstage transom 1.2 m'}),'frame');assert.equal(gaTab({name:'Lattice girder 6.39 m'}),'beams');
});

test('the main screen is the game board (view HOME, fed by the Home poll) for the yard office, wired into render, the poll and the CSP',()=>{
  const ops=readFileSync(new URL('../public/operations.js',import.meta.url),'utf8'),game=readFileSync(new URL('../public/game.js',import.meta.url),'utf8'),css=readFileSync(new URL('../public/game.css',import.meta.url),'utf8'),html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  assert.ok(ops.includes("view=userState.permissions?.includes('operations.manage')?'HOME':'CONTROL'"),'operations people open on the game board');
  assert.ok(ops.includes("if(view==='HOME'&&!force&&app.querySelector(':scope>.game-mode')){state=next;projMap=null;gmUpdate(gameCtx());return;}"),'the poll patches the board');
  assert.ok(ops.includes("const viewHTML=view==='CONTROL'?homeView():"),'the old Home page is the Office\'s Control room');assert.ok(!ops.includes("'GAME'"),'no separate GAME view: the Home poll feeds the board');
  assert.ok(ops.includes(":not([data-gm-live])"),'dragging the amount slider does not stop the poll');
  assert.ok(html.includes('<link rel="stylesheet" href="/game.css">'));for(const f of ['game.js','game-art.js','game-pick.js','game.css'])assert.ok(server.includes("'/"+f+"'"),f+' is served');assert.ok(server.includes("path==='/api/game-items'"),'the slider asks for its stillages itself');
  assert.ok(!/\sstyle="/.test(game),'no inline style attributes in the board');assert.match(css,/\.gm-board \.world-svg \.tg/,'no stillage and crew tags on the board');assert.match(css,/@media \(max-width:760px\)/);
});

test('no truck codes on the board: a truck is a Big truck or a Truck in its window, its card and on the map; the codes stay in the Office',t=>{
  const f=board(t);f.cmd('gameStart',{size:'S'});fast(f);f.cmd('gameCatalogue');const std=f.sim.repo.all('product').find(p=>p.name==='Kwikstage standard 3.0 m');f.cmd('gameAddStock',{lines:[{product:std.id,quantity:200}]});
  const {site}=f.cmd('gameSite',{name:'George St'});f.cmd('gameSend',{site:site.id,lines:[{product:std.id,quantity:40}]});
  let s=f.snap();for(let i=0;i<400&&!s.trucks.some(t=>t.status==='IN_TRANSIT');i++){f.tick(1);s=f.snap();}
  const truck=s.trucks.find(t=>t.status==='IN_TRANSIT');assert.ok(truck,'a truck is on the road');assert.match(truck.name,/^T-\d+/);
  __gm.reset();__gm.shell(ctxOf(f,s));__gm.setTruck(truck.id);const head=__gm.head(s);assert.match(head,/Big truck · /);assert.ok(!head.includes(truck.name),'no code in the truck window');
  assert.ok(!__gm.trips(s).includes(truck.name),'no code on the trip card, not even in its tooltip');
  const card=cardHTML(s,std);assert.match(card,/On a big truck/);assert.ok(!card.includes(truck.name),'no code in the hover card');
  assert.match(cardTight(s,std),/Kwikstage standard 3\.0 m<\/b><span>\d+ in the yard<\/span>/,'the one-line card for a short strip of map on a phone');
  const world=readFileSync(new URL('../public/world.js',import.meta.url),'utf8'),ops=readFileSync(new URL('../public/operations.js',import.meta.url),'utf8'),css=readFileSync(new URL('../public/game.css',import.meta.url),'utf8');
  assert.ok(ops.includes('onPick:gmPick,glow:gmGlow(),plain:true'),'the board asks the map for plain words');assert.match(world,/who=plain\(\)\?truckWord\(t\):t\.name/,'the map names trucks by kind on the board');
  assert.match(css,/\.gm-board \.wm-truck\.parked:not\(\.followed\) \.wm-ttag\{display:none\}/,'parked trucks carry no tag on the board');
  // the board is view HOME, so its poll is the one that carries the map block (?world=, grouped with revisions)
  assert.ok(ops.includes("wmParam=()=>view==='HOME'&&typeof document!=='undefined'"),'the poll of the board asks for the map block');
  assert.ok(ops.includes("wm:()=>wmAttach({...wmCtx(),"),'the board draws with the Home map context (the last map block stands in until the next poll)');
});
