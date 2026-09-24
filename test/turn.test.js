import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './simulation.test.js';
import { yardSVG } from '../public/visual.js';

// ---- Server: turns that meet a crowded yard, and turns the engine refuses ----
const rectYard=(w,d)=>[{x:0,y:0},{x:w,y:0},{x:w,y:d},{x:0,y:d}];
const box=(f,name,x,y,length=2000,width=1000,extra={})=>f.cmd('container',{name,location:extra.location,type:'STILLAGE',length,width,height:1000,tare:50000,x,y,...extra});

test('a queued turn goes BLOCKED at RESERVED when stock boxes it in while paused, and Retry completes it once a blocker is retired',t=>{const f=fixture(t);
 const tight=f.cmd('yard',{name:'Tight',points:rectYard(6000,4000),loading:{x:0,y:2500},gate:{x:4000,y:2500}});f.cmd('resources',{location:tight.id,workers:2,machines:1,stepMs:100,speed:100000,jobs:false});
 const a=box(f,'A',2000,1500,2000,1000,{location:tight.id});
 const plan=f.sim.turnPreview({container:a.id});assert.equal(plan.ok,true,plan.message);
 f.cmd('pause',{paused:true});const res=f.cmd('rotate',{container:a.id,rotation:90});const id=res.tasks[0].id;assert.equal(f.sim.repo.get(id).turn,true);
 // Boxed in on three sides while nothing moves: no clear 2.2 m circle is left anywhere in the 6 x 4 m yard.
 box(f,'N',2000,0,2000,800,{location:tight.id});box(f,'W',0,1500,1800,1000,{location:tight.id});const e=box(f,'E',4000,1500,2000,1000,{location:tight.id});
 f.cmd('pause',{paused:false});f.tick(10);
 let task=f.sim.repo.get(id);assert.equal(task.state,'BLOCKED');assert.equal(task.resumeState,'RESERVED');assert.equal(!!task.picked,false);assert.match(task.reason,/No room to turn A/);
 assert.deepEqual([f.sim.repo.get(a.id).x,f.sim.repo.get(a.id).y,f.sim.repo.get(a.id).rotation??0,f.sim.repo.get(a.id).location],[2000,1500,0,tight.id]);
 f.cmd('scrapContainer',{id:e.id,reason:'Blocking the turn'});f.cmd('retry',{id});f.tick(40);
 task=f.sim.repo.get(id);assert.equal(task.state,'COMPLETE',task.reason??'');const c=f.sim.repo.get(a.id);assert.deepEqual([c.x,c.y,c.rotation,c.location],[2500,1000,90,tight.id]);assert.equal(f.total(),200);});

test('rotate refuses with no forklift at the yard and with an unknown tare, in the engine\'s own words',t=>{const f=fixture(t);
 const bare=f.cmd('yard',{name:'Bare yard',points:rectYard(12000,8000)});const lone=box(f,'Lone',6000,4000,2000,1000,{location:bare.id});
 const p=f.sim.turnPreview({container:lone.id});assert.equal(p.ok,false);assert.match(p.message,/There is no forklift at Bare yard/);assert.throws(()=>f.cmd('rotate',{container:lone.id}),/There is no forklift/);
 const unknown=box(f,'Unknown',12000,10000,2000,1000,{location:f.yard.id,tare:null});
 const q=f.sim.turnPreview({container:unknown.id});assert.equal(q.ok,false);assert.match(q.message,/tare weight is unknown/);assert.throws(()=>f.cmd('rotate',{container:unknown.id}),/Container tare weight is unknown\. Configure it before moving\./);
 assert.equal(f.sim.tasks().filter(x=>x.turn).length,0);});

// ---- Visual: orientation, corner numbers, pending and carried turns ----
const yard={id:'Y',kind:'site',name:'Yard',points:rectYard(20000,16000)};
const still=(o={})=>({id:'S1',name:'S-001',type:'STILLAGE',location:'Y',x:4000,y:4000,rotation:0,envelopeLength:2000,envelopeWidth:1000,height:1000,condition:'SERVICEABLE',...o});
const slats=svg=>[...svg.matchAll(/class="slat" d="M ([\d.]+) ([\d.]+) ([HV])/g)].map(m=>m[3]);

test('slats run along the long side and the label names the orientation',()=>{
 const flat=yardSVG(yard,[still()]),up=yardSVG(yard,[still({rotation:90})]),square=yardSVG(yard,[still({envelopeLength:1200,envelopeWidth:1200})]);
 assert.ok(slats(flat).length>0);assert.ok(slats(flat).every(d=>d==='H'));assert.ok(slats(up).length>0);assert.ok(slats(up).every(d=>d==='V'),'an r90 2000 x 1000 stillage has vertical slats');
 assert.match(flat,/aria-label="Select S-001 stillage, long side left-right"/);assert.match(up,/aria-label="Select S-001 stillage, long side up-down"/);assert.match(square,/aria-label="Select S-001 stillage, square"/);assert.match(up,/<title>S-001 - empty - long side up-down<\/title>/);
 // Fork pockets on the front long edge: the bottom edge left-right, the left edge up-down.
 const pockets=svg=>[...svg.matchAll(/<rect class="fork-pocket" x="(-?\d+)" y="(-?\d+)" width="(\d+)" height="(\d+)"/g)].map(m=>m.slice(1).map(Number));
 assert.deepEqual(pockets(flat).map(p=>[p[1],p[2]>p[3]]),[[870,true],[870,true]]);assert.deepEqual(pockets(up).map(p=>[p[0],p[2]<p[3]]),[[0,true],[0,true]]);});

test('the top face stays the first rect of the transformed group, and pulse flags a stillage',()=>{
 const svg=yardSVG(yard,[still(),still({id:'S2',name:'S-002',x:9000})],[],'S1',[],[],null,{pulse:new Set(['S2'])});
 const m=svg.match(/data-select="S2" class="svg-container ([^"]*)"><title>[^<]*<\/title>(?:<polygon[^>]*\/>)*<g transform="translate\([^)]*\)"><rect width="(\d+)" height="(\d+)"/);assert.ok(m,'data-select > g[transform] > rect is the top face');assert.match(m[1],/\bpulse\b/);assert.deepEqual([m[2],m[3]],['2000','1000']);
 assert.doesNotMatch(svg.match(/data-select="S1" class="svg-container ([^"]*)"/)[1],/pulse/);assert.doesNotMatch(yardSVG(yard,[still()]),/\bpulse\b/);});

test('corner numbers follow the shape editor order and stay upright',()=>{
 assert.doesNotMatch(yardSVG(yard,[]),/corner-number/);
 const reversed={...yard,points:[{x:20000,y:16000},{x:20000,y:0},{x:0,y:0},{x:0,y:16000}]};const svg=yardSVG(reversed,[],[],null,[],[],null,{cornerNumbers:true});
 const nums=[...svg.matchAll(/<g class="corner-number" data-corner="(\d+)" transform="translate\((-?\d+) (-?\d+)\) matrix\(/g)].map(m=>m.slice(1).map(Number));assert.equal(nums.length,4);
 // normalise(): clockwise on screen from the top-left corner, each number just outside its corner.
 assert.deepEqual(nums.map(([n,x,y])=>[n,Math.sign(x-10000),Math.sign(y-8000)]),[[1,-1,-1],[2,1,-1],[3,1,1],[4,-1,1]]);assert.ok(nums[0][1]<0&&nums[0][2]<0);
 assert.match(svg,/data-corner="3"[^>]*><circle[^>]*\/><text[^>]*>3<\/text><\/g>/);
 const L={...yard,points:[{x:0,y:0},{x:12000,y:0},{x:12000,y:6000},{x:20000,y:6000},{x:20000,y:16000},{x:0,y:16000}]};assert.equal((yardSVG(L,[],[],null,[],[],null,{cornerNumbers:true,view:{tilt:false}}).match(/class="corner-number"/g)||[]).length,6);});

test('a waiting turn is outlined at its destination until pickup',()=>{
 const task=(o={})=>({id:'T1',type:'MOVE',container:'S1',from:'Y',to:'Y',handling:'Y',turn:true,picked:false,state:'QUEUED',position:{x:4500,y:3500,rotation:90,support:null},...o});
 const outline=svg=>svg.match(/<g class="pending-turn" data-pending-turn="S1"[^>]*><title>[^<]*<\/title><rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="(\d+)" height="(\d+)"/);
 for(const state of ['QUEUED','RESERVED','ASSIGNED','TRAVELLING_TO_PICKUP','PICKING']){const m=outline(yardSVG(yard,[still()],[task({state})],null,[],[],null,{view:{tilt:false}}));assert.ok(m,state);assert.deepEqual(m.slice(1).map(Number),[4500,3500,1000,2000]);}
 for(const t of [task({state:'BLOCKED'}),task({state:'COMPLETE'}),task({state:'CANCELLED'}),task({picked:true,state:'CARRYING'}),task({turn:false}),task({to:'other'}),task({position:null})])assert.equal(outline(yardSVG(yard,[still()],[t])),null);
 assert.match(yardSVG(yard,[still()],[task()]),/pending-turn[\s\S]*⟳/);});

test('a carried turn load is drawn at its turning spot: old orientation while carried, new at PLACING',()=>{
 const carried=still({location:'M1'});const task=state=>({id:'T1',type:'MOVE',container:'S1',from:'Y',to:'Y',handling:'Y',turn:true,picked:true,state,machine:'M1',turnAt:{x:9000,y:8000,r:1118},path:[{x:4000,y:4000},{x:8000,y:7500},{x:4500,y:3500}],position:{x:4500,y:3500,rotation:90,support:null}});
 const load=svg=>svg.match(/<g class="carried-turn" data-turn-task="T1"><title>[^<]*<\/title><rect x="(-?\d+)" y="(-?\d+)" width="(\d+)" height="(\d+)"/)?.slice(1).map(Number);
 const placing=yardSVG(yard,[carried],[task('PLACING')]),carrying=yardSVG(yard,[carried],[task('CARRYING')]);
 assert.deepEqual(load(placing),[8500,7000,1000,2000],'PLACING: centred on turnAt in the target rotation');assert.deepEqual(load(carrying),[8000,7500,2000,1000],'CARRYING: centred on turnAt in the current rotation');
 assert.match(placing,/carried-turn[\s\S]*⟳[\s\S]*SETTING DOWN/);assert.match(carrying,/carried-turn[\s\S]*⟳[\s\S]*TURNING/);assert.doesNotMatch(placing,/pending-turn/);
 // A plain carried load keeps the generic box at its path point.
 const plain=yardSVG(yard,[carried],[{...task('CARRYING'),turn:false}]);assert.doesNotMatch(plain,/carried-turn/);assert.match(plain,/<g transform="translate\(8000 7500\)"><rect width="1400" height="900"/);});

// ---- Server: the forklift's room around a carried load goes to whichever side has space ----
test('a lengthwise stillage flush against the right or bottom fence can be turned and moved, like one against the left or top fence',t=>{const f=fixture(t);
 const r=box(f,'R',19000,8000,2000,1000,{location:f.yard.id,rotation:90}),d=box(f,'D',14000,15200,2000,800,{location:f.yard.id}),l=box(f,'L',0,8000,2000,1000,{location:f.yard.id,rotation:90});
 for(const c of [r,d,l]){const p=f.sim.turnPreview({container:c.id});assert.equal(p.ok,true,c.name+': '+p.message);}
 const turn=f.cmd('rotate',{container:r.id,rotation:0});f.tick(30);const task=f.sim.repo.get(turn.tasks[0].id);assert.equal(task.state,'COMPLETE',task.reason??'');assert.equal(f.sim.repo.get(r.id).rotation,0);
 const move=f.cmd('queue',{container:d.id,destination:f.yard.id,position:{x:12000,y:12000,rotation:0,support:null}});f.tick(30);const m=f.sim.repo.get(move.id);assert.equal(m.state,'COMPLETE',m.reason??'');assert.equal(f.total(),200);});

test('carryRoute keeps the load\'s own corners at both ends and pads to the right when there is room (unchanged routes)',async()=>{const {carryRoute,route}=await import('../src/domain/geometry.js');const yard=rectYard(20000,16000);
 const open=carryRoute({x:4000,y:4000},{x:9000,y:4000},{w:1000,h:2000},yard,[]);assert.deepEqual(open,route({x:4000,y:4000},{x:9000,y:4000},{w:1500,h:2000},yard,[]));
 const flush=carryRoute({x:19000,y:8000},{x:12000,y:8000},{w:1000,h:2000},yard,[]);assert.deepEqual([flush[0],flush.at(-1)],[{x:19000,y:8000},{x:12000,y:8000}]);
 assert.equal(route({x:19000,y:8000},{x:12000,y:8000},{w:1500,h:2000},yard,[]),null,'the old right-hand padding left the fence');
 assert.equal(carryRoute({x:19000,y:8000},{x:12000,y:8000},{w:1000,h:2000},yard,[{x:18000,y:7000,w:1000,h:4000}]),null,'no room on either side');});
