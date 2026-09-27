import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase,atomic } from '../src/database.js';
import { Service } from '../src/service.js';
import { Simulation } from '../src/simulation.js';
import { flushWorldClocks } from '../src/domain/world.js';
import { WORLD,worldLayout,worldRoute,tripMs,routeGeom,poseAt,distanceAt,restPoses,lotOrder,kerbPose,bayPose,siteRot,placePoint } from '../public/world-layout.js';
import { wmLayout,wmTools,__wm } from '../public/world.js';

// Its own small world (importing the shared fixture from simulation.test.js would run those tests a second time): a 20 x 16 m yard, Site A,
// truck T01, two stillages with stock. The crews work at a fast demo speed, so trips are short unless a test sets the default speed.
function world(t){const db=openDatabase(':memory:');t.after(()=>db.close());const auth=new Service(db);const user=auth.authenticate(auth.register({name:'Owner',companyName:'Demo',email:randomUUID()+'@example.com',password:'demonstration-password',systems:['quickstage']}));const sim=new Simulation(db,user);const cmd=(action,input={},key=randomUUID())=>sim.execute(action,input,key);
  const yard=cmd('yard',{name:'Yard',segments:[{direction:'RIGHT',length:20000},{direction:'DOWN',length:16000},{direction:'LEFT',length:20000}],closed:true});const products=cmd('seed');cmd('resources',{location:yard.id,workers:5,machines:1,stepMs:100,speed:100000,jobs:false});
  const truck=cmd('truck',{name:'T01',yard:yard.id});const site=cmd('site',{name:'Site A'});cmd('resources',{location:site.id,workers:2,machines:1,stepMs:100,speed:100000,jobs:false});
  const container=(name,x=4000,y=4000)=>cmd('container',{name,location:yard.id,type:'STILLAGE',length:2000,width:1000,height:1000,tare:50000,x,y});const a=container('A'),b=container('B',7000);for(const c of [a,b])cmd('opening',{container:c.id,product:products[0].id,quantity:100,reason:'DEMO ONLY opening'});
  const tick=(n=1,ms=1000)=>{for(let i=0;i<n;i++)atomic(db,()=>sim.tick(ms));};
  return {db,auth,user,sim,cmd,yard,products,truck,site,a,b,tick};}
// The demo speed the owner's simulation runs at by default (config.speed 4000 mm/s): trips take their road length at 8 m/s.
const defaultSpeed=f=>{const c=f.sim.repo.all('config')[0];c.speed=4000;f.sim.repo.save(c);return c;};
const load=(f,ids)=>{f.cmd('loadTruck',{truck:f.truck.id,containers:ids});f.tick(40);for(const t of f.sim.tasks().filter(t=>t.state==='BLOCKED'))f.cmd('retry',{id:t.id});f.tick(40);};
const box=(w,h)=>[{x:0,y:0},{x:w,y:0},{x:w,y:h},{x:0,y:h}];

test('a trip gets its road and a travel time from the road length: out of the bay, along the streets keeping left, backed in at the site gate',t=>{
  const f=world(t),config=defaultSpeed(f);
  const truck=f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});
  const r=truck.route;assert.ok(r&&r.points.length>4,'a road with corners');assert.equal(r.from,f.yard.id);assert.equal(r.to,f.site.id);
  assert.equal(r.durationMs,tripMs(r.length,config));assert.equal(r.durationMs,Math.max(WORLD.minMs,Math.round(r.length/(WORLD.truckFactor*4000)*1000/50)*50));assert.ok(r.durationMs>=8000&&r.durationMs<=45000,'between 8 and 45 s: '+r.durationMs);assert.equal(truck.remainingMs,r.durationMs);
  let len=0;for(let i=1;i<r.points.length;i++)len+=Math.hypot(r.points[i][0]-r.points[i-1][0],r.points[i][1]-r.points[i-1][1]);assert.ok(Math.abs(len-r.length)<2,'length is the polyline');
  // the same world gives the same road in the browser (the shared layout module)
  const s=f.sim.snapshot(),l=wmLayout(s),again=worldRoute(l,s.trucks[0],f.yard.id,f.site.id,{start:bayPose(l,f.yard.id,s.trucks[0])});assert.deepEqual(again.points,r.points);
  assert.deepEqual(r.points[0],[bayPose(l,f.yard.id,s.trucks[0]).x,bayPose(l,f.yard.id,s.trucks[0]).y],'it leaves from the yard bay');
  // the site's gate is free: the truck ends backed in at the gate, cab to the street, where the crane reaches it
  assert.equal(r.end.bay,true);assert.ok(r.rev>0,'it reverses the last part');assert.deepEqual([r.end.x,r.end.y],[bayPose(l,f.site.id,s.trucks[0]).x,bayPose(l,f.site.id,s.trucks[0]).y]);
  const g=routeGeom(r),back=poseAt(g,g.L-50);assert.equal(back.rev,true);assert.ok(Math.abs(back.hy-1)<1e-9,'facing the street while it backs in');
  for(let i=2;i<=r.rev;i++){const a=r.points[i-2],b=r.points[i-1],c=r.points[i],d1=[b[0]-a[0],b[1]-a[1]],d2=[c[0]-b[0],c[1]-b[1]],dot=(d1[0]*d2[0]+d1[1]*d2[1])/(Math.hypot(...d1)*Math.hypot(...d2)||1);assert.ok(dot>-0.5,'no U-turn at point '+i);}
});

test('a site across the street is a short trip: no detour round the block, and the time follows the road length',()=>{
  const yard={id:'Y',kind:'yard',name:'Y',points:box(30000,20000)},near={id:'N',name:'Near',status:'ACTIVE',points:box(20000,16000),gate:{x:3500,y:15000},loading:{x:1000,y:14000},map:{col:0,row:1}},far={id:'F',name:'Far',status:'ACTIVE',points:box(20000,16000),gate:{x:3500,y:15000},loading:{x:1000,y:14000},map:{col:3,row:-2}};
  const l=worldLayout(yard,[near,far]),t={id:'T',length:8000,width:2400};
  const a=worldRoute(l,t,'Y','N'),b=worldRoute(l,t,'Y','F'),config={speed:4000};
  const s=a.points[0],e=a.points.at(-1),manhattan=Math.abs(e[0]-s[0])+Math.abs(e[1]-s[1]);assert.ok(a.length<manhattan+60000,'the road is close to the direct way: '+a.length+' vs '+manhattan);
  assert.ok(tripMs(a.length,config)<=15000,'across the street: '+tripMs(a.length,config)+' ms');assert.ok(tripMs(b.length,config)>tripMs(a.length,config),'further is longer');
  // a site reached heading either way along its street: the kerb side is the near lane when the truck keeps left, and it backs in from either side
  const l2=worldLayout(yard,[{...near,map:{col:-1,row:0}}]),w=worldRoute(l2,t,'Y','N');assert.equal(w.end.bay,true);const m2=Math.abs(w.points.at(-1)[0]-w.points[0][0])+Math.abs(w.points.at(-1)[1]-w.points[0][1]);assert.ok(w.length<m2+60000,'next block west, no loop: '+w.length+' vs '+m2);
  // the fast demo speed the tests use keeps trips short
  assert.ok(tripMs(b.length,{speed:100000})<2500);assert.equal(tripMs(0,{speed:100000}),300);
});

test('the countdown is written about every 5 s of engine time, the snapshot reads it exactly, a pause freezes it, arrival is unchanged and a stop flushes it',t=>{
  const f=world(t);load(f,[f.a.id]);defaultSpeed(f);
  const sent=f.cmd('dispatch',{id:f.truck.id,destination:f.site.id}),D=sent.route.durationMs,v0=f.sim.repo.get(f.truck.id).version;assert.ok(D>7000);
  f.tick(28,250);// 7 s
  const row=f.sim.repo.get(f.truck.id);assert.equal(row.status,'IN_TRANSIT');assert.ok(row.version-v0<=2,'at most one write per 5 s: '+(row.version-v0));assert.equal(row.remainingMs,D-5000,'the stored value is the last flush');
  assert.equal(f.sim.snapshot().trucks.find(t=>t.id===f.truck.id).remainingMs,D-7000,'the snapshot has the exact countdown');
  f.cmd('pause',{paused:true});f.tick(20,250);assert.equal(f.sim.snapshot().trucks[0].remainingMs,D-7000);f.cmd('pause',{paused:false});
  assert.equal(flushWorldClocks(f.db),1);assert.equal(f.sim.repo.get(f.truck.id).remainingMs,D-7000);assert.equal(flushWorldClocks(f.db),0);
  const writes=f.sim.repo.get(f.truck.id).version;f.tick(Math.ceil((D-7000)/250)+1,250);
  const arrived=f.sim.repo.get(f.truck.id);assert.equal(arrived.status,'AT_SITE');assert.equal(arrived.at,f.site.id);assert.equal(arrived.destination,null);assert.ok(arrived.version-writes<=Math.ceil((D-7000)/5000)+1,'few writes on the way');
  const delivery=f.sim.repo.get(arrived.delivery,'delivery');assert.equal(delivery.status,'ARRIVED');assert.ok(f.sim.repo.all('notification').some(n=>n.title==='Truck arrived'));
  assert.equal(f.sim.repo.get(f.a.id).location,f.truck.id,'cargo stays on the truck until unloading, as before');
});

test('at the fast demo speed a trip takes well under a second, so quick-trip flows keep working',t=>{const f=world(t);const truck=f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});assert.ok(truck.remainingMs<1500,'short trip: '+truck.remainingMs);assert.ok(truck.route.points.length>1);f.tick(2);assert.equal(f.sim.repo.get(f.truck.id).status,'AT_SITE');});

test('a fault in the map never blocks a dispatch: the trip keeps the old fixed time and the page draws a road itself',t=>{
  const f=world(t),orig=f.sim.worldLayoutNow;f.sim.worldLayoutNow=()=>{throw new Error('map broken');};const err=console.error;console.error=()=>{};
  try{const truck=f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});assert.equal(truck.status,'IN_TRANSIT');assert.equal(truck.remainingMs,3000);assert.equal(truck.route.points,null);}finally{f.sim.worldLayoutNow=orig;console.error=err;}
  f.tick(4);assert.equal(f.sim.repo.get(f.truck.id).status,'AT_SITE');
});

test('back to the yard: the truck reverses into the free bay; a second truck finds the bay taken and waits at the kerb',t=>{
  const f=world(t);defaultSpeed(f);const t2=f.cmd('truck',{name:'T02',yard:f.yard.id});
  const go=f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});f.tick(Math.ceil(go.route.durationMs/250)+1,250);
  const home=f.cmd('dispatch',{id:f.truck.id,destination:f.yard.id}).route;assert.ok(home.rev>0,'reversing into the bay at the end');assert.equal(home.end.bay,true);
  const g=routeGeom(home),rev=poseAt(g,g.L-100);assert.equal(rev.rev,true);assert.ok(Math.abs(rev.hy-1)<1e-9,'it faces the street while it backs in');
  const l=wmLayout(f.sim.snapshot()),s=f.sim.snapshot(),rest=restPoses(l,f.yard.id,s.trucks.filter(t=>t.status==='AT_YARD'),s.trucks);assert.deepEqual(rest.get(t2.id),kerbPose(l,f.yard.id,0),'the other truck keeps its kerb spot');
  f.tick(Math.ceil(home.durationMs/250)+1,250);const t2Trip=f.cmd('dispatch',{id:t2.id,destination:f.site.id}).route;f.tick(Math.ceil(t2Trip.durationMs/250)+1,250);
  const t2Home=f.cmd('dispatch',{id:t2.id,destination:f.yard.id}).route;assert.equal(t2Home.end.bay,false,'the bay is taken by T01');assert.equal(t2Home.rev,null);
});

test('moving a site on the map: validated block, never the yard or a taken block, not while a truck drives there, operations only, pins the others; archiving never shuffles the rest',t=>{
  const f=world(t);defaultSpeed(f);const b=f.cmd('site',{name:'Site B'}),c=f.cmd('site',{name:'Site C'}),d=f.cmd('site',{name:'Site D'});
  const before=f.sim.snapshot().world.lots;assert.deepEqual(before[f.yard.id].slice(0,2),[0,0]);for(const id of [f.site.id,b.id,c.id,d.id])assert.equal(before[id][2],1,'auto placed');
  assert.equal(new Set(Object.values(before).map(v=>v[0]+','+v[1])).size,5,'no two places share a block');
  // archiving one site pins the others where they are
  f.cmd('archive',{id:b.id});const pinned=f.sim.snapshot().world.lots;for(const id of [f.site.id,c.id,d.id])assert.deepEqual(pinned[id].slice(0,2),before[id].slice(0,2),'still where it was');assert.ok(!(b.id in pinned));
  assert.throws(()=>f.cmd('worldPlace',{id:c.id,col:0,row:0}),/yard/);assert.throws(()=>f.cmd('worldPlace',{id:c.id,col:before[d.id][0],row:before[d.id][1]}),/taken by Site D/);
  assert.throws(()=>f.cmd('worldPlace',{id:c.id,col:1.5,row:0}),/Map column/);assert.throws(()=>f.cmd('worldPlace',{id:c.id,col:99,row:0}),/Map column/);assert.throws(()=>f.cmd('worldPlace',{col:1,row:0}),/Choose a site/);
  const key=randomUUID(),moved=f.sim.execute('worldPlace',{id:c.id,col:3,row:-2},key);assert.deepEqual(moved.site.map,{col:3,row:-2});assert.deepEqual(f.sim.execute('worldPlace',{id:c.id,col:3,row:-2},key),moved,'idempotent replay');
  const after=f.sim.snapshot().world.lots;assert.deepEqual(after[c.id],[3,-2,0]);for(const id of [f.site.id,d.id])assert.deepEqual(after[id].slice(0,2),before[id].slice(0,2),'the others stay where they were');
  assert.ok(f.sim.repo.history(500).some(l=>l.event==='SITE_MAP'&&l.destination===c.id));
  const far=f.cmd('dispatch',{id:f.truck.id,destination:c.id}).route;assert.equal(far.to,c.id);assert.deepEqual(far.lot,[3,-2]);assert.throws(()=>f.cmd('worldPlace',{id:c.id,col:4,row:-2}),/Wait until T01/);
  f.auth.addUser(f.user,{name:'Sup',email:'sup-map@example.com',password:'demonstration-password',roles:['SUPERVISOR']});const sup=new Simulation(f.db,f.auth.authenticate(f.auth.login({email:'sup-map@example.com',password:'demonstration-password'})));
  assert.throws(()=>sup.execute('worldPlace',{id:d.id,col:-3,row:0},randomUUID()),{status:403});
});

test('the snapshot world block: the lots each viewer may see, unpaged site stock and cargo; a supervisor gets no yard details',t=>{
  const f=world(t);const b=f.cmd('site',{name:'Hidden'});
  f.auth.addUser(f.user,{name:'Sup',email:'sup-world@example.com',password:'demonstration-password',roles:['SUPERVISOR']});const supUser=f.auth.authenticate(f.auth.login({email:'sup-world@example.com',password:'demonstration-password'}));
  f.cmd('siteDetails',{id:f.site.id,supervisor:supUser.id});
  for(let i=0;i<6;i++)f.cmd('container',{name:'Z'+i,location:f.site.id,type:'STILLAGE',length:2000,width:1000,height:1000,tare:50000,x:2000+(i%3)*3000,y:4000+Math.floor(i/3)*2500});
  for(let i=0;i<63;i++){const x=300+(i%9)*2150,y=5500+Math.floor(i/9)*1200,c=f.cmd('container',{name:'P'+i,location:f.yard.id,type:'STILLAGE',length:2000,width:1000,height:1000,tare:50000,x,y});f.cmd('container',{name:'Q'+i,location:f.yard.id,type:'STILLAGE',length:2000,width:1000,height:1000,tare:50000,x,y,support:c.id});}
  const owner=f.sim.snapshot(),sv=new Simulation(f.db,supUser).snapshot();
  assert.ok(owner.containerCount>100&&owner.world.items.filter(c=>c.location===f.site.id).length===6,'site stock is complete whichever page of the list is shown');
  assert.equal('yard' in sv.world,false);assert.deepEqual(Object.keys(sv.world.lots),[f.site.id],'only the assigned site');assert.deepEqual(sv.world.lots[f.site.id],owner.world.lots[f.site.id]);assert.equal(sv.world.bw,owner.world.bw);assert.ok(!(b.id in sv.world.lots));
  assert.equal(sv.world.items.filter(c=>c.location===f.site.id).length,6);assert.ok(!sv.world.items.some(c=>c.location===f.yard.id),'no yard stock for a supervisor');
  const lo=wmLayout(owner),ls=wmLayout(sv);assert.equal(ls.byId.get(f.site.id).ox,lo.byId.get(f.site.id).ox);assert.equal(ls.byId.get(f.site.id).oy,lo.byId.get(f.site.id).oy);
});

test('layout: the yard in block 0,0, sites in the nearest free blocks in creation order, deterministic and never overlapping; a site turns its gate to the street',()=>{
  const yard={id:'Y',kind:'yard',name:'Y',points:box(30000,20000)},sites=Array.from({length:12},(_,i)=>({id:'S'+i,name:'S'+i,points:box(18000+i*1000,16000)}));
  const a=worldLayout(yard,sites),b=worldLayout(yard,sites);assert.deepEqual(a.places.map(p=>[p.id,p.col,p.row,p.ox,p.oy]),b.places.map(p=>[p.id,p.col,p.row,p.ox,p.oy]));
  const order=lotOrder(a.bw,a.bh);assert.deepEqual(a.places.filter(p=>p.kind==='site').map(p=>[p.col,p.row]),order.slice(0,12).map(o=>[o.c,o.r]));
  for(const p of a.places)assert.ok(p.ext.x0>=p.block.x0&&p.ext.x1<=p.block.x1&&p.ext.y0>=p.block.y0&&p.ext.y1<=p.block.y1,p.id+' fits its block');
  const moved=worldLayout(yard,[{...sites[0],map:{col:4,row:4}},{...sites[1],map:{col:4,row:4}},sites[2]]);assert.deepEqual([moved.byId.get('S0').col,moved.byId.get('S0').row],[4,4]);assert.equal(moved.byId.get('S1').auto,true);
  // a site facing south is drawn turned half round, so the top of its plan (where unloaded stillages go, and a new site's gate and loading zone) faces the street
  const def={id:'D',name:'D',points:box(20000,16000),loading:{x:1000,y:1000},gate:{x:3500,y:1000}};assert.equal(siteRot(def),180);const l=worldLayout(yard,[def]),p=l.byId.get('D'),z=placePoint(p,1000+1000,1000+750);assert.ok(z.y>p.ext.y1-4000,'the loading zone is by the street');
  assert.equal(siteRot(def,'N'),0,'a site facing north keeps the top of its plan to the north street');
  // an archived site still sizes the blocks (worldLayout also), so archiving a big site never shrinks every block and moves every place
  const big={id:'B',name:'B',points:box(70000,40000)},withBig=worldLayout(yard,[def,big]),archived=worldLayout(yard,[def],null,[big]);assert.deepEqual([archived.bw,archived.bh],[withBig.bw,withBig.bh]);assert.ok(worldLayout(yard,[def]).bw<withBig.bw);assert.equal(archived.byId.has('B'),false,'not drawn');
});

test('driving along a route: continuous, forward only, easing in and out, headings in 24 steps',()=>{
  const l=worldLayout({id:'Y',kind:'yard',name:'Y',points:box(30000,20000)},[{id:'S',name:'S',points:box(20000,16000)}]),r=worldRoute(l,{length:6000},'Y','S'),g=routeGeom(r),D=tripMs(r.length);let prev=null,prevS=-1,maxStep=0;
  for(let i=0;i<=600;i++){const u=i/600,s=distanceAt(g,u,D),p=poseAt(g,s);assert.ok(s>=prevS-1e-6,'never backwards');if(prev)maxStep=Math.max(maxStep,Math.hypot(p.x-prev.x,p.y-prev.y));prev=p;prevS=s;}
  assert.ok(maxStep<g.L/600*2.2,'no jumps: '+maxStep);assert.equal(distanceAt(g,0,D),0);assert.equal(distanceAt(g,1,D),g.L);assert.ok(distanceAt(g,.02,D)<g.L*.02,'starts slowly');
  assert.equal(__wm.headingKey(1,0),0);assert.equal(__wm.headingKey(0,1),6);assert.equal(__wm.headingKey(-1,0),12);assert.equal(__wm.headingKey(0,-1),18);
});

test('the map builders are plain strings in Node: static scenery, a site with its stock, crew and crane, the toolbar, the Home signal part',()=>{
  const yard={id:'Y',kind:'yard',name:'Main yard',points:box(30000,20000)},site={id:'S',kind:'site',status:'ACTIVE',name:'George Street',points:box(22000,16000),gate:{x:3500,y:1000},loading:{x:1000,y:1000}};
  const state={yards:[yard],sites:[site],trucks:[],tasks:[],containers:[],balances:[],products:[{id:'P',name:'Standard'}],resources:[{id:'C1',type:'CRANE',location:'S',enabled:true},{id:'W1',type:'WORKER',location:'S',x:2000,y:2000,name:'Worker 1'}],config:{},world:{items:[{id:'X',name:'X-1',type:'STILLAGE',condition:'SERVICEABLE',location:'S',x:3000,y:4000,rotation:0,support:null,envelopeLength:2000,envelopeWidth:1000,height:1000,lines:[['P',40]]}]}};
  const l=wmLayout(state),st=__wm.staticSVG(l);assert.ok(st.grounds.length>=16&&st.grounds.some(g=>g.svg.includes('url(#asphalt)')),'the ground, one picture per lot, with streets');assert.ok(st.cells.length>=9&&st.cells.every((c,i)=>!i||st.cells[i-1].dep<=c.dep),'blocks back to front');assert.ok([...st.blocks.values()].some(b=>b.svg.includes('<circle')),'trees and houses');
  const svg=__wm.siteSVG(l.byId.get('S'),l,state,{});assert.ok(svg.includes('data-select="X"'),'site stillages select like yard ones');assert.ok(svg.includes('40 x Standard'),'their contents are in the tooltip');assert.ok(svg.includes('Worker 1'));assert.ok(svg.includes('wm-shadecloth')||svg.includes('url(#mesh)'),'the site fence');
  assert.equal(__wm.siteParts(l.byId.get('S'),l,state,{},{art:false}).crane,true,'the site has a crane to draw');
  const ops=wmTools({ops:true,view:{rotate:0,tilt:true}}),sup=wmTools({ops:false});for(const w of ['Director','Fit all','Turn view','3D view','data-wm="in"','data-wm="out"'])assert.ok(ops.includes(w),w);assert.ok(ops.includes('Arrange map'));assert.ok(!sup.includes('Arrange map'),'arranging is for operations only');
  assert.match(__wm.signal({state,selected:null}),/^<i class="wm-sig" hidden data-v="\d+"><\/i>$/);
});
