import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openDatabase,atomic } from '../src/database.js';
import { Service } from '../src/service.js';
import { Simulation } from '../src/simulation.js';
import { __gm,officeHTML,OFFICE_TILES,cardHTML } from '../public/game.js';
import { gaKind,gaLength,gaLenTag,GA_TABS,gaTab } from '../public/game-art.js';

// The game board's builders are plain strings from a snapshot (no DOM), so the main screen's content is checked in node.
function board(t){
  const db=openDatabase(':memory:');t.after(()=>db.close());const auth=new Service(db);
  const user=auth.authenticate(auth.register({name:'Owner',companyName:'Harbour',email:randomUUID()+'@example.com',password:'demonstration-password',systems:['quickstage']}));
  const sim=new Simulation(db,user);const cmd=(a,i={})=>sim.execute(a,i,randomUUID());
  const account={company:{id:user.company_id,name:'Harbour'},user:{id:user.id,name:'Owner'},permissions:auth.permissions(user)};
  const tick=n=>{for(let i=0;i<n;i++)atomic(db,()=>sim.tick(1000));};
  return {db,sim,cmd,account,tick,snap:()=>sim.snapshot(0,{lean:true})};
}
const ctxOf=(f,s)=>({state:s,account:f.account,hire:true});

test('first run: the board asks for a yard size (three pictures and a way to draw your own), then shows the map, three big buttons and the inventory',t=>{
  const f=board(t);__gm.reset();let html=__gm.shell(ctxOf(f,f.snap()));
  assert.match(html,/How big is your yard\?/);for(const k of ['S','M','L'])assert.ok(html.includes('data-gm-size="'+k+'"'));assert.ok(html.includes('data-gm-draw'),'Draw my own shape instead');
  f.cmd('gameStart',{size:'M'});html=__gm.shell(ctxOf(f,f.snap()));
  assert.ok(html.includes('data-wm-host'),'the live world map');assert.ok(html.includes('aria-label="What do you want to do?"'));
  for(const k of ['send','back','add'])assert.ok(html.includes('data-gm-go="'+k+'"'),k);assert.ok(html.includes('data-gm-dock'),'the inventory window');assert.ok(html.includes('data-gm-office'),'the Office door');
  assert.ok(!/hud-stat|al-strip|sg-guide|simulation-banner/.test(html),'no counters, alert strips, set-up checklist or banners on the main screen');
});

test('the Office holds every other page as a picture tile, marks the open one, and leaves Hire out for people who may not see it',t=>{
  const f=board(t);f.cmd('gameStart',{size:'S'});const s=f.snap();
  const html=officeHTML({state:s,account:f.account,hire:true,view:'STOCK'});assert.match(html,/<nav class="gm-tiles" aria-label="Main navigation">/);
  for(const [v] of OFFICE_TILES)assert.ok(html.includes('data-view="'+v+'"'),v);assert.ok(html.includes('id="settings"'),'Account');
  assert.match(html,/class="gm-tile current" data-view="STOCK" aria-current="page"/);assert.ok(!officeHTML({state:s,account:f.account,hire:false}).includes('data-view="HIRE"'));
  for(const v of ['TODAY','SCHEDULE','WORKERS','EQUIPMENT','TRUCK12','TRUCK2','STOCK','REPORTS','MATERIALS','SITES','HIRE','YARD','OVERVIEW','HOME'])assert.ok(OFFICE_TILES.some(x=>x[0]===v),'no page is lost: '+v);
});

test('the inventory: the yard at a glance, the whole catalogue to add, free stock to send, a site\'s stock to bring back; one short count per slot',t=>{
  const f=board(t);f.cmd('gameStart',{size:'M'});f.cmd('gameCatalogue');const c=f.sim.repo.all('config')[0];Object.assign(c,{stepMs:100,speed:100000,jobs:false,routineJobs:false});f.sim.repo.save(c);
  const ps=f.sim.repo.all('product'),std=ps.find(p=>p.name==='Kwikstage standard 3.0 m'),led=ps.find(p=>p.name==='Kwikstage ledger 2.4 m');
  f.cmd('gameAddStock',{lines:[{product:std.id,quantity:1640},{product:led.id,quantity:290}]});const {site}=f.cmd('gameSite',{name:'George St'});
  let s=f.snap();__gm.reset();__gm.shell(ctxOf(f,s));
  __gm.setMode('yard');let items=__gm.gridItems(s);assert.deepEqual(items.map(x=>x.p.id).sort(),[std.id,led.id].sort(),'only what is in the yard');
  const grid=__gm.grid(s);assert.ok(grid.includes('<b class="gm-n">1.6k</b>'),'1640 shows as 1.6k');assert.ok(grid.includes('<i class="gm-len">3m</i>'),'the length in the corner');assert.ok(grid.includes('gm-void'),'empty slots fill the rows');
  assert.ok(!/\sstyle="/.test(grid),'no inline styles (the CSP drops them)');
  __gm.setMode('add');items=__gm.gridItems(s);assert.equal(items.length,ps.length,'Add stock offers every part');
  __gm.setMode('send',site.id);items=__gm.gridItems(s);assert.equal(items.find(x=>x.p.id===std.id).count,1640,'free to send');
  f.cmd('gameSend',{site:site.id,lines:[{product:std.id,quantity:1}]});for(let i=0;i<200&&f.sim.repo.all('truck').some(t=>t.game);i++)f.tick(1);s=f.snap();
  __gm.setMode('site',site.id);items=__gm.gridItems(s);assert.equal(items.length,1);assert.ok(items[0].count>0,'the site grid shows what is on site');
  const card=cardHTML(s,std);assert.match(card,/In the yard/);assert.match(card,/George St/);assert.match(card,/17.5 kg each/);
});

test('one hint at a time, in the order a new owner needs them',t=>{
  const f=board(t);f.cmd('gameStart',{size:'S'});__gm.reset();__gm.shell(ctxOf(f,f.snap()));__gm.setMode('yard');
  assert.equal(__gm.hint(f.snap()).id,'parts');f.cmd('gameCatalogue');assert.equal(__gm.hint(f.snap()).id,'add');
  const p=f.sim.repo.all('product')[0];f.cmd('gameAddStock',{lines:[{product:p.id,quantity:5}]});assert.equal(__gm.hint(f.snap()).id,'site');
  f.cmd('gameSite',{name:'Kent St'});const h=__gm.hint(f.snap());assert.equal(h.id,'send');assert.match(h.text,/Kent St/);assert.equal(h.point,'send');
});

test('trucks in words: ready, loading for a site, on the way, arriving soon, and how full',t=>{
  const f=board(t);f.cmd('gameStart',{size:'S'});const s=f.snap(),truck=s.trucks[0];
  assert.equal(__gm.truckWords(s,truck).word,'Ready at the yard');
  const site={id:'S1',name:'George St',status:'ACTIVE'};const st={...s,sites:[site]};
  assert.match(__gm.truckWords(st,{...truck,status:'IN_TRANSIT',destination:'S1',remainingMs:20000,loadedWeight:6250000}).word,/^On the way to George St · half full$/);
  assert.match(__gm.truckWords(st,{...truck,status:'IN_TRANSIT',destination:'S1',remainingMs:3000}).word,/arriving soon/);
  assert.match(__gm.truckWords({...st,tasks:[{to:truck.id}]},{...truck,destination:'S1'}).word,/^Loading for George St/);
  assert.equal(__gm.truckWords(st,{...truck,game:{problem:'No crane here.'}}).word,'Waiting: No crane here.');
});

test('item pictures know scaffold parts by name, and draw long parts longer',()=>{
  const k=name=>gaKind({name});
  assert.equal(k('Kwikstage standard 3.0 m'),'standard');assert.equal(k('Kwikstage ledger 2.4 m'),'ledger');assert.equal(k('Kwikstage transom 1.2 m'),'transom');assert.equal(k('Face brace 2.7 m'),'brace');
  assert.equal(k('Scaffold tube 6.3 m'),'tube');assert.equal(k('Double coupler'),'coupler');assert.equal(k('Kwikstage steel board / plank 0.7 m'),'plank');assert.equal(k('Timber scaffold board 3.9 m'),'board');
  assert.equal(k('Toe board 2.4 m'),'toeboard');assert.equal(k('Adjustable base jack'),'jack');assert.equal(k('Kwikstage sole board 0.5 m'),'plate');assert.equal(k('Aluminium ladder 6 m'),'ladder');assert.equal(k('Aluminium lattice beam 6.1 m'),'beam');
  assert.equal(gaLength({name:'Ledger 2400 mm'}),2.4);assert.equal(gaLength({name:'Tube',length:6300}),6.3);assert.equal(gaLenTag({name:'Kwikstage ledger 0.7 m'}),'0.7m');assert.equal(gaLenTag({name:'Double coupler'}),'');
  assert.deepEqual(GA_TABS.map(x=>x.id),['all','tubes','frame','boards','fittings','access']);assert.equal(gaTab({name:'Scaffold tube 3 m'}),'tubes');assert.equal(gaTab({name:'Kwikstage transom 1.2 m'}),'frame');
});

test('the main screen is the game board for the yard office, wired into render, the poll and the CSP',()=>{
  const ops=readFileSync(new URL('../public/operations.js',import.meta.url),'utf8'),game=readFileSync(new URL('../public/game.js',import.meta.url),'utf8'),css=readFileSync(new URL('../public/game.css',import.meta.url),'utf8'),html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  assert.ok(ops.includes("view=userState.permissions?.includes('operations.manage')?'GAME':'HOME'"),'operations people open on the game board');
  assert.ok(ops.includes("if(view==='GAME'&&!force&&app.querySelector(':scope>.game-mode')){state=next;projMap=null;gmUpdate(gameCtx());return;}"),'the poll patches the board');
  assert.ok(ops.includes(":not([data-gm-live])"),'dragging the amount slider does not stop the poll');
  assert.ok(html.includes('<link rel="stylesheet" href="/game.css">'));for(const f of ['game.js','game-art.js','game-pick.js','game.css'])assert.ok(server.includes("'/"+f+"'"),f+' is served');
  assert.ok(!/\sstyle="/.test(game),'no inline style attributes in the board');assert.match(css,/\.gm-board \.world-svg \.tg/,'no stillage and crew tags on the board');assert.match(css,/@media \(max-width:760px\)/);
});
