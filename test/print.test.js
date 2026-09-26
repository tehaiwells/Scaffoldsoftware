process.env.TZ='Australia/Sydney';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Simulation } from '../src/simulation.js';
import { fixture } from './simulation.test.js';
// Printable pick lists and delivery dockets: the pure sheet builders (prPickSheet, prDocketSheet, prSheetHTML) over real snapshots, and the page buttons.
const load=()=>import('../public/operations.js');
const acct=(f,perms=['operations.manage','stock.adjust','requests.create'])=>({permissions:perms,systems:[{id:'quickstage',name:'Quickstage',enabled:1}],users:[],company:{id:'c',name:'Demo'},user:{id:f.user.id,name:'Owner'}});
const opts={company:'Demo Scaffolding',user:'Owner',printedAt:'2026-09-25T23:00:00Z'};
const list=(f,lines,extra={})=>f.cmd('createLoadList',{site:f.site.id,name:'Level 3 deck',lines,...extra});

test('an open yard list picks from the fullest free stillages, with pack, weight and totals',async t=>{const f=fixture(t),{prPickSheet,prSheetHTML}=await load();const P=f.products[0];
 f.cmd('opening',{container:f.empty.id,product:P.id,quantity:40,reason:'Demo'});
 const day=f.sim.snapshot().calendar.nextWorkday,l=list(f,[{product:P.id,quantity:170}],{neededOn:day,slot:'AM',notes:'Crane on site from 7'});
 const m=prPickSheet(f.sim.snapshot(),l.id,opts);
 assert.equal(m.kind,'pick');assert.equal(m.name,'Level 3 deck');assert.equal(m.site.name,'Site A');assert.equal(m.neededOn,day);assert.equal(m.slot,'Morning (AM)');assert.equal(m.truck,null);assert.match(m.no,/^PL-[0-9A-F]{6}$/);
 const [line]=m.lines;assert.equal(line.quantity,170);assert.equal(line.word,'To pick');
 assert.deepEqual(line.sources.map(o=>[o.how,o.name,o.quantity]),[['suggest','A',100],['suggest','B',70]],'most full first, only as many as needed; the 40 on Empty is not needed');
 assert.equal(line.short,0);assert.equal(m.totals.pieces,170);assert.equal(m.totals.stillages,2);
 if(P.unitWeight!=null)assert.equal(m.totals.weight,P.unitWeight*170);
 if(P.packQuantity)assert.deepEqual(line.packs,{full:Math.floor(170/P.packQuantity),loose:170%P.packQuantity});
 const tooMuch=list(f,[{product:P.id,quantity:300}],{name:'Too much'}),big=prPickSheet(f.sim.snapshot(),tooMuch.id,opts);assert.equal(big.lines[0].short,60,'240 in the yard, 60 short');
 const html=prSheetHTML(m);for(const s of ['Pick list','Level 3 deck','Site A','Crane on site from 7','Picked by','Checked &amp; loaded by','pr-box','Suggested','Morning (AM)'])assert.ok(html.includes(s),s);
 assert.ok(!/style="/.test(html),'no style attributes (the CSP drops them)');});

test('a reserved list names the reserved stillages, a split into an empty one, and what is on the truck',async t=>{const f=fixture(t),{prPickSheet}=await load();const P=f.products[0];
 const l=list(f,[{product:P.id,quantity:120}]);f.cmd('allocateLoadList',{id:l.id,truck:f.truck.id});
 let m=prPickSheet(f.sim.snapshot(),l.id,opts);const src=m.lines[0].sources;
 assert.equal(m.truck.name,'T01');assert.equal(m.truck.loading,true);assert.equal(m.lines[0].word,'Reserved');
 assert.ok(src.some(o=>o.how==='whole'&&o.quantity===100),'one whole stillage of 100');
 const split=src.find(o=>o.how==='split');assert.ok(split,'a split');assert.equal(split.quantity,20);assert.equal(split.of,100);assert.equal(split.into,'Empty');
 assert.ok(!src.some(o=>o.how==='suggest'),'no suggestions once reserved');
 f.tick(100);for(const task of f.sim.tasks().filter(t=>t.state==='BLOCKED'))f.cmd('retry',{id:task.id});f.tick(100);
 m=prPickSheet(f.sim.snapshot(),l.id,opts);assert.equal(m.lines[0].word,'On truck');assert.equal(m.lines[0].sources.filter(o=>o.how==='loaded').reduce((n,o)=>n+o.quantity,0),120);});

test('the delivery docket lists what was sent to the site, with the truck, the stillages and the DEMO mark',async t=>{const f=fixture(t),{prDocketSheet,prSheetHTML}=await load();const P=f.products[0];
 f.cmd('siteDetails',{id:f.site.id,name:'Site A',address:'12 George St',client:'Acme Build',contact:'Sam',phone:'0400 000 000'});
 const l=list(f,[{product:P.id,quantity:100}]);
 let d=prDocketSheet(f.sim.snapshot(),{list:l.id},opts);assert.equal(d.status,'NOT_LOADED','nothing reserved or loaded: never "loading"');assert.match(prSheetHTML(d),/Draft delivery docket[\s\S]*Not loaded yet/);assert.ok(!prSheetHTML(d).includes('Loading at the yard'));
 f.cmd('allocateLoadList',{id:l.id,truck:f.truck.id});
 d=prDocketSheet(f.sim.snapshot(),{list:l.id},opts);assert.equal(d.sent,false);assert.equal(d.status,'RESERVED');assert.equal(d.groups[0].lines[0].ordered,100);assert.match(prSheetHTML(d),/Reserved · not loaded yet/);
 f.tick(100);d=prDocketSheet(f.sim.snapshot(),{list:l.id},opts);assert.equal(d.status,'LOADING','pieces on the truck');assert.equal(d.totals.sent,100);assert.match(prSheetHTML(d),/Loading at the yard/);assert.ok(!prSheetHTML(d).includes('Draft delivery docket'));
 f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});const s=f.sim.snapshot(),delivery=s.deliveries.find(x=>x.manifest?.length);assert.ok(delivery);
 d=prDocketSheet(s,{delivery:delivery.id},opts);const again=prDocketSheet(s,{list:l.id},opts);assert.equal(again.no,d.no,'the list resolves to its delivery');
 assert.equal(d.kind,'docket');assert.equal(d.sent,true);assert.equal(d.truck.name,'T01');assert.equal(d.site.address,'12 George St');assert.equal(d.site.client,'Acme Build');
 assert.equal(d.totals.sent,100);assert.equal(d.totals.ordered,100);assert.equal(d.stillageCount,1);assert.deepEqual(d.stillages,['A']);assert.match(d.no,/^DD-/);
 const html=prSheetHTML({...d,demo:true});for(const x of ['Delivery docket','12 George St','Acme Build','Sam','Driver','Received on site by','Time left yard','pr-watermark','DEMO ONLY'])assert.ok(html.includes(x),x);
 assert.ok(!prSheetHTML({...d,demo:false}).includes('pr-watermark'),'no watermark without demo data');});

test('single requests print too, and missing ids return null',async t=>{const f=fixture(t),{prPickSheet,prDocketSheet}=await load();const r=f.cmd('request',{site:f.site.id,product:f.products[0].id,quantity:5});
 const m=prPickSheet(f.sim.snapshot(),r.id,opts);assert.equal(m.listKind,'request');assert.equal(m.lines.length,1);assert.equal(m.lines[0].quantity,5);assert.equal(m.lines[0].sources[0].how,'suggest');
 assert.equal(prPickSheet(f.sim.snapshot(),'nope',opts),null);assert.equal(prDocketSheet(f.sim.snapshot(),{list:'nope'},opts),null);});

test('the print buttons sit on yard list cards, the docket panel, the Schedule card and the truck garage; supervisors keep working',async t=>{const f=fixture(t),{__test:T,prPickSheet,prSheetHTML}=await load();const P=f.products[0];
 const l=list(f,[{product:P.id,quantity:100}],{neededOn:f.sim.snapshot().calendar.today});f.cmd('allocateLoadList',{id:l.id,truck:f.truck.id});
 T.setState(f.sim.snapshot(),acct(f));T.setView('SITES');const sites=T.requestView();
 assert.ok(sites.includes('data-pr-print="pick" data-pr-id="'+l.id+'"')&&sites.includes('data-pr-print="docket" data-pr-id="'+l.id+'"'),'both buttons on the yard list card');
 T.setView('TRUCK12');const loading=T.truckView(()=>true);assert.ok(loading.includes('pr-papers'),'paperwork strip on the loading truck');assert.ok(loading.includes('data-pr-print="pick" data-pr-id="'+l.id+'"')&&!loading.includes('data-pr-print="docket"'),'the next-load strip offers the pick list only, so it never shows a second "Print docket"');
 T.setView('SCHEDULE');T.schedOpen().add(l.id);const sched=T.scheduleView();T.schedOpen().clear();assert.ok(sched.includes('data-pr-print="pick" data-pr-id="'+l.id+'"'),'pick list on the open Schedule card');assert.ok(sched.includes('data-pr-print="docket" data-pr-id="'+l.id+'"'),'and the docket');
 f.tick(100);f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});T.setState(f.sim.snapshot(),acct(f));T.setView('TRUCK12');const garage=T.truckView(()=>true);
 assert.ok(/data-pr-print="delivery"/.test(garage)&&garage.includes('pr-manifest-btn'),'Print docket on the docket panel');assert.ok(garage.includes('Print docket &middot; Site A'),'the on-board docket button names its site');
 assert.ok(!garage.includes('data-pr-print="pick" data-pr-id="'+l.id+'"'),'no pick list once it has left');
 f.auth.addUser(f.user,{name:'Supervisor',email:'sup@example.com',password:'demonstration-password',roles:['SUPERVISOR']});const sup=f.auth.authenticate(f.auth.login({email:'sup@example.com',password:'demonstration-password'}));f.cmd('siteDetails',{id:f.site.id,name:'Site A',supervisor:sup.id});
 const restricted=new Simulation(f.db,sup),l2=restricted.execute('createLoadList',{site:f.site.id,name:'Sup list',lines:[{product:P.id,quantity:10}]},randomUUID()),ss=restricted.snapshot();
 const m=prPickSheet(ss,l2.id,opts);assert.ok(m,'a supervisor can print their list');assert.equal(m.yard,null);assert.deepEqual(m.lines[0].sources,[],'no yard stillages in a supervisor snapshot');assert.equal(m.lines[0].short,0,'and not reported short: the yard is just not visible');const supHTML=prSheetHTML(m);assert.ok(supHTML.includes('Chosen by the yard')&&!supHTML.includes('pr-key'),'no stillage count or Reserved/Suggested legend on a supervisor sheet');
 T.setState(ss,acct(f,['requests.create']));T.setView('SITES');assert.ok(T.requestView().includes('data-pr-print="pick" data-pr-id="'+l2.id+'"'));});

test('print CSS: A4 portrait, only the sheet prints, and the sheet block is the last one in design.css',async()=>{const {readFileSync}=await import('node:fs');const css=readFileSync(new URL('../public/design.css',import.meta.url),'utf8');const i=css.indexOf('/* ===== Print sheets:');
 assert.ok(i>0,'the Print sheets block exists');const block=css.slice(i);assert.ok(block.includes('@page{size:A4 portrait'),'A4 portrait');assert.ok(block.includes('body.pr-open>*:not(.pr-host):not(svg){display:none!important}'),'everything but the sheet is hidden in print');
 assert.ok(block.includes('.pr-toolbar{display:none!important}'),'the preview toolbar does not print');assert.ok(!/@media print/.test(css.slice(0,i)),'no other print rules to fight with');});

test('a partly sent yard list keeps a pick list for the lines still to send; sheet dates use one fixed style',async t=>{const f=fixture(t),{__test:T,prPickSheet,prSheetHTML}=await load();const [P,Q]=f.products;
 const l=list(f,[{product:P.id,quantity:100},{product:Q.id,quantity:16}]),s=structuredClone(f.sim.snapshot()),x=s.loadLists.find(y=>y.id===l.id);
 // the state the existing list logic reports after one line went out: the list reads DELIVERED while a line is still REQUESTED with nothing sent
 Object.assign(x,{status:'DELIVERED',delivery:'D-gone'});Object.assign(x.lines[0],{status:'DELIVERED',delivered:100,sent:100});
 const m=prPickSheet(s,l.id,opts),[done,left]=m.lines;assert.equal(done.word,'Delivered');assert.deepEqual(done.sources,[]);assert.equal(left.status,'REQUESTED');
 assert.ok(left.sources.length||left.short,'the line still to send gets stillages to pick from (or a shortfall)');assert.equal(m.totals.pieces,16,'totals count only what is left to pick');assert.equal(m.totals.lines,1);
 T.setState(s,acct(f));T.setView('SITES');assert.ok(T.requestView().includes('data-pr-print="pick" data-pr-id="'+l.id+'"'),'Print pick list stays on the card');
 const html=prSheetHTML(m);assert.ok(html.includes('Printed Sat 26 Sep 2026, 9:00 am by Owner'),'fixed day-month style, not the browser locale');});
