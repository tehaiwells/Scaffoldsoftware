import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { atomic } from '../src/database.js';
import { Simulation } from '../src/simulation.js';
import { flushWorldClocks } from '../src/domain/world.js';
import { fixture } from './simulation.test.js';
import { WORLD,worldLayout,worldRoute,tripMs,routeGeom,poseAt,distanceAt,restPoses,lotOrder,kerbPose,bayPose } from '../public/world-layout.js';
import { wmLayout,__wm } from '../public/world.js';

// The shared fixture keeps trips at 3 s (config.truckTripMs); these tests drive real roads.
const realTrips=f=>{const c=f.sim.repo.all('config')[0];delete c.truckTripMs;f.sim.repo.save(c);};
const tickMs=(f,n,ms=250)=>{for(let i=0;i<n;i++)atomic(f.db,()=>f.sim.tick(ms));};
const load=(f,ids)=>{f.cmd('loadTruck',{truck:f.truck.id,containers:ids});f.tick(40);for(const t of f.sim.tasks().filter(t=>t.state==='BLOCKED'))f.cmd('retry',{id:t.id});f.tick(40);};

test('a trip gets its road and a travel time from the road length: along the streets, keeping left, the same for everyone',t=>{
  const f=fixture(t);realTrips(f);
  const truck=f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});
  const r=truck.route;assert.ok(r&&r.points.length>4,'a road with corners');assert.equal(r.from,f.yard.id);assert.equal(r.to,f.site.id);
  assert.equal(r.durationMs,tripMs(r.length));assert.ok(r.durationMs>=15000&&r.durationMs<=45000,'between 15 and 45 s: '+r.durationMs);assert.equal(truck.remainingMs,r.durationMs);
  let len=0;for(let i=1;i<r.points.length;i++)len+=Math.hypot(r.points[i][0]-r.points[i-1][0],r.points[i][1]-r.points[i-1][1]);assert.ok(Math.abs(len-r.length)<2,'length is the polyline');
  // the same world gives the same road in the browser (the shared layout module)
  const s=f.sim.snapshot(),l=wmLayout(s),again=worldRoute(l,s.trucks[0],f.yard.id,f.site.id,{start:bayPose(l,f.yard.id,s.trucks[0])});assert.deepEqual(again.points,r.points);
  // it leaves from the bay heading south (cab first out of the driveway) and stops at the kerb beside the site, heading east in the near lane
  assert.deepEqual(r.points[0],[bayPose(l,f.yard.id,s.trucks[0]).x,bayPose(l,f.yard.id,s.trucks[0]).y]);const site=l.byId.get(f.site.id);assert.equal(r.end.y,site.streetY-WORLD.lane);assert.equal(r.end.hx,1);assert.equal(r.end.bay,false);
  // no U-turn anywhere: consecutive segments never point back on themselves
  for(let i=2;i<r.points.length;i++){const a=r.points[i-2],b=r.points[i-1],c=r.points[i],d1=[b[0]-a[0],b[1]-a[1]],d2=[c[0]-b[0],c[1]-b[1]],dot=(d1[0]*d2[0]+d1[1]*d2[1])/(Math.hypot(...d1)*Math.hypot(...d2)||1);assert.ok(dot>-0.5,'no reversal at point '+i);}
});

test('the countdown is written about every 5 s of engine time, the snapshot reads it exactly, arrival is unchanged and a stop flushes it',t=>{
  const f=fixture(t);realTrips(f);load(f,[f.a.id]);
  const sent=f.cmd('dispatch',{id:f.truck.id,destination:f.site.id}),D=sent.route.durationMs,v0=f.sim.repo.get(f.truck.id).version;
  tickMs(f,28);// 7 s
  const row=f.sim.repo.get(f.truck.id);assert.equal(row.status,'IN_TRANSIT');assert.ok(row.version-v0<=2,'at most one write per 5 s: '+(row.version-v0));assert.equal(row.remainingMs,D-5000,'the stored value is the last flush');
  assert.equal(f.sim.snapshot().trucks.find(t=>t.id===f.truck.id).remainingMs,D-7000,'the snapshot has the exact countdown');
  // a pause freezes the countdown
  f.cmd('pause',{paused:true});tickMs(f,20);assert.equal(f.sim.snapshot().trucks[0].remainingMs,D-7000);f.cmd('pause',{paused:false});
  // a graceful stop writes the held value back, version-checked, only onto the same trip still on the road
  assert.equal(flushWorldClocks(f.db),1);assert.equal(f.sim.repo.get(f.truck.id).remainingMs,D-7000);assert.equal(flushWorldClocks(f.db),0);
  const writes=f.sim.repo.get(f.truck.id).version;tickMs(f,Math.ceil((D-7000)/250)+1);
  const arrived=f.sim.repo.get(f.truck.id);assert.equal(arrived.status,'AT_SITE');assert.equal(arrived.at,f.site.id);assert.equal(arrived.destination,null);assert.ok(arrived.version-writes<=Math.ceil((D-7000)/5000)+1,'few writes on the way');
  const delivery=f.sim.repo.get(arrived.delivery,'delivery');assert.equal(delivery.status,'ARRIVED');assert.ok(f.sim.repo.all('notification').some(n=>n.title==='Truck arrived'));
  // cargo stays on the truck until unloading, as before
  assert.equal(f.sim.repo.get(f.a.id).location,f.truck.id);
});

test('back to the yard: the truck reverses into the free bay; a second truck finds the bay taken and waits at the kerb',t=>{
  const f=fixture(t);realTrips(f);const t2=f.cmd('truck',{name:'T02',yard:f.yard.id});
  const go=f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});tickMs(f,Math.ceil(go.route.durationMs/250)+1);
  const home=f.cmd('dispatch',{id:f.truck.id,destination:f.yard.id}).route;assert.ok(home.rev>0,'reversing into the bay at the end');assert.equal(home.end.bay,true);
  const g=routeGeom(home),rev=poseAt(g,g.L-100);assert.equal(rev.rev,true);assert.ok(Math.abs(rev.hy-1)<1e-9,'it faces the street while it backs in');
  // the other truck, parked at the kerb since it never drove, keeps its spot while the first one comes and goes
  const l=wmLayout(f.sim.snapshot()),s=f.sim.snapshot(),rest=restPoses(l,f.yard.id,s.trucks.filter(t=>t.status==='AT_YARD'),s.trucks);assert.deepEqual(rest.get(t2.id),kerbPose(l,f.yard.id,0));
  tickMs(f,Math.ceil(home.durationMs/250)+1);const t2Trip=f.cmd('dispatch',{id:t2.id,destination:f.site.id}).route;tickMs(f,Math.ceil(t2Trip.durationMs/250)+1);
  const t2Home=f.cmd('dispatch',{id:t2.id,destination:f.yard.id}).route;assert.equal(t2Home.end.bay,false,'the bay is taken by T01');assert.equal(t2Home.rev,null);
});

test('the fixture keeps quick trips: a fixed truckTripMs overrides the road time',t=>{const f=fixture(t);const truck=f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});assert.equal(truck.remainingMs,3000);assert.ok(truck.route.points.length>1);f.tick(3);assert.equal(f.sim.repo.get(f.truck.id).status,'AT_SITE');});

test('moving a site on the map: validated block, never the yard or a taken block, not while a truck drives there, operations only, pins the others',t=>{
  const f=fixture(t);realTrips(f);const b=f.cmd('site',{name:'Site B'}),c=f.cmd('site',{name:'Site C'});
  const before=f.sim.snapshot().world.lots;assert.deepEqual(before[f.yard.id].slice(0,2),[0,0]);for(const id of [f.site.id,b.id,c.id])assert.equal(before[id][2],1,'auto placed');
  const taken=new Set(Object.values(before).map(v=>v[0]+','+v[1]));assert.equal(taken.size,4,'no two places share a block');
  assert.throws(()=>f.cmd('worldPlace',{id:c.id,col:0,row:0}),/yard/);assert.throws(()=>f.cmd('worldPlace',{id:c.id,col:before[b.id][0],row:before[b.id][1]}),/taken by Site B/);
  assert.throws(()=>f.cmd('worldPlace',{id:c.id,col:1.5,row:0}),/Map column/);assert.throws(()=>f.cmd('worldPlace',{id:c.id,col:99,row:0}),/Map column/);
  const key=randomUUID(),moved=f.sim.execute('worldPlace',{id:c.id,col:3,row:-2},key);assert.deepEqual(moved.site.map,{col:3,row:-2});assert.deepEqual(f.sim.execute('worldPlace',{id:c.id,col:3,row:-2},key),moved,'idempotent replay');
  const after=f.sim.snapshot().world.lots;assert.deepEqual(after[c.id],[3,-2,0]);for(const id of [f.site.id,b.id])assert.deepEqual(after[id],[before[id][0],before[id][1],0],'the others stay where they were, now pinned');
  assert.ok(f.sim.repo.history(500).some(l=>l.event==='SITE_MAP'&&l.destination===c.id));
  // new trips take the new road
  const far=f.cmd('dispatch',{id:f.truck.id,destination:c.id}).route;assert.equal(far.to,c.id);assert.deepEqual(far.lot,[3,-2]);assert.throws(()=>f.cmd('worldPlace',{id:c.id,col:4,row:-2}),/Wait until T01/);
  // supervisors cannot move sites
  f.auth.addUser(f.user,{name:'Sup',email:'sup-map@example.com',password:'demonstration-password',roles:['SUPERVISOR']});const sup=new Simulation(f.db,f.auth.authenticate(f.auth.login({email:'sup-map@example.com',password:'demonstration-password'})));
  assert.throws(()=>sup.execute('worldPlace',{id:b.id,col:-3,row:0},randomUUID()),{status:403});
});

test('the snapshot world block: every viewer gets the same lots for what they may see, unpaged site stock and cargo, a yard outline only for those without yards',t=>{
  const f=fixture(t);const b=f.cmd('site',{name:'Hidden'});
  f.auth.addUser(f.user,{name:'Sup',email:'sup-world@example.com',password:'demonstration-password',roles:['SUPERVISOR']});const supUser=f.auth.authenticate(f.auth.login({email:'sup-world@example.com',password:'demonstration-password'}));
  f.cmd('siteDetails',{id:f.site.id,supervisor:supUser.id});
  for(let i=0;i<6;i++)f.cmd('container',{name:'Z'+i,location:f.site.id,type:'STILLAGE',length:2000,width:1000,height:1000,tare:50000,x:2000+(i%3)*3000,y:4000+Math.floor(i/3)*2500});
  const owner=f.sim.snapshot(),sv=new Simulation(f.db,supUser).snapshot();
  assert.equal(owner.world.yard,null,'operations see the full yard in yards');assert.ok(sv.world.yard&&sv.world.yard.points.length>=3,'a supervisor gets the yard outline');assert.equal(sv.world.yard.fixtures.every(x=>x.kind==='OFFICE'),true);
  assert.deepEqual(Object.keys(sv.world.lots).sort(),[f.yard.id,f.site.id].sort(),'only the yard and the assigned site');assert.deepEqual(sv.world.lots[f.site.id],owner.world.lots[f.site.id]);assert.equal(sv.world.bw,owner.world.bw);assert.ok(!(b.id in sv.world.lots));
  assert.equal(sv.world.items.filter(c=>c.location===f.site.id).length,6);assert.ok(!sv.world.items.some(c=>c.location===f.yard.id),'no yard stock for a supervisor');
  // the supervisor's browser places the site exactly where everyone else does
  const lo=wmLayout(owner),ls=wmLayout(sv);assert.equal(ls.byId.get(f.site.id).ox,lo.byId.get(f.site.id).ox);assert.equal(ls.byId.get(f.site.id).oy,lo.byId.get(f.site.id).oy);
});

test('layout: the yard in block 0,0, sites in the nearest free blocks in creation order, deterministic and never overlapping',()=>{
  const yard={id:'Y',kind:'yard',name:'Y',points:[{x:0,y:0},{x:30000,y:0},{x:30000,y:20000},{x:0,y:20000}]},sites=Array.from({length:12},(_,i)=>({id:'S'+i,name:'S'+i,points:[{x:0,y:0},{x:18000+i*1000,y:0},{x:18000+i*1000,y:16000},{x:0,y:16000}]}));
  const a=worldLayout(yard,sites),b=worldLayout(yard,sites);assert.deepEqual(a.places.map(p=>[p.id,p.col,p.row,p.ox,p.oy]),b.places.map(p=>[p.id,p.col,p.row,p.ox,p.oy]));
  const order=lotOrder(a.bw,a.bh);assert.deepEqual(a.places.filter(p=>p.kind==='site').map(p=>[p.col,p.row]),order.slice(0,12).map(o=>[o.c,o.r]));
  for(const p of a.places){assert.ok(p.ext.x0>=p.block.x0&&p.ext.x1<=p.block.x1&&p.ext.y0>=p.block.y0&&p.ext.y1<=p.block.y1,p.id+' fits its block');}
  // a manual lot wins; a second claim of the same lot falls back to auto
  const moved=worldLayout(yard,[{...sites[0],map:{col:4,row:4}},{...sites[1],map:{col:4,row:4}},sites[2]]);assert.deepEqual([moved.byId.get('S0').col,moved.byId.get('S0').row],[4,4]);assert.equal(moved.byId.get('S1').auto,true);
});

test('driving along a route: continuous, forward only, easing in and out, headings in 24 steps',()=>{
  const yard={id:'Y',kind:'yard',name:'Y',points:[{x:0,y:0},{x:30000,y:0},{x:30000,y:20000},{x:0,y:20000}]},site={id:'S',name:'S',points:[{x:0,y:0},{x:20000,y:0},{x:20000,y:16000},{x:0,y:16000}]};
  const l=worldLayout(yard,[site]),r=worldRoute(l,{length:6000},'Y','S'),g=routeGeom(r),D=tripMs(r.length);let prev=null,prevS=-1,maxStep=0;
  for(let i=0;i<=600;i++){const u=i/600,s=distanceAt(g,u,D),p=poseAt(g,s);assert.ok(s>=prevS-1e-6,'never backwards');if(prev)maxStep=Math.max(maxStep,Math.hypot(p.x-prev.x,p.y-prev.y));prev=p;prevS=s;}
  assert.ok(maxStep<g.L/600*2.2,'no jumps: '+maxStep);assert.equal(distanceAt(g,0,D),0);assert.equal(distanceAt(g,1,D),g.L);assert.ok(distanceAt(g,.02,D)<g.L*.02,'starts slowly');
  assert.equal(__wm.headingKey(1,0),0);assert.equal(__wm.headingKey(0,1),6);assert.equal(__wm.headingKey(-1,0),12);assert.equal(__wm.headingKey(0,-1),18);
});

test('the map builders are plain strings in Node: static scenery, a site with its stock and crane mast, the Home signal part',()=>{
  const yard={id:'Y',kind:'yard',name:'Main yard',points:[{x:0,y:0},{x:30000,y:0},{x:30000,y:20000},{x:0,y:20000}]},site={id:'S',kind:'site',status:'ACTIVE',name:'George Street',points:[{x:0,y:0},{x:22000,y:0},{x:22000,y:16000},{x:0,y:16000}],gate:{x:3500,y:1000},loading:{x:1000,y:1000}};
  const state={yards:[yard],sites:[site],trucks:[],tasks:[],containers:[],balances:[],products:[{id:'P',name:'Standard'}],resources:[{id:'C1',type:'CRANE',location:'S',enabled:true},{id:'W1',type:'WORKER',location:'S',x:2000,y:2000,name:'Worker 1'}],config:{},world:{items:[{id:'X',name:'X-1',type:'STILLAGE',condition:'SERVICEABLE',location:'S',x:3000,y:4000,rotation:0,support:null,envelopeLength:2000,envelopeWidth:1000,height:1000,lines:[['P',40]]}]}};
  const l=wmLayout(state),st=__wm.staticSVG(l);assert.match(st.ground,/url\(#asphalt\)/);assert.ok([...st.blocks.values()].join('').includes('wm-blk'));
  const svg=__wm.siteSVG(l.byId.get('S'),l,state,{});assert.ok(svg.includes('data-select="X"'),'site stillages select like yard ones');assert.ok(svg.includes('40 x Standard'),'their contents are in the tooltip');assert.ok(svg.includes('Worker 1'));assert.ok(svg.includes('#c99a16'),'the crane mast');
  const sig=__wm.signal({state,selected:null});assert.match(sig,/^<i class="wm-sig" hidden data-v="\d+"><\/i>$/);
});
