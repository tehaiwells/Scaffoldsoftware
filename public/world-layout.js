// Home world map geometry, shared by the server (travel time at dispatch, src/domain/world.js) and the browser (public/world.js), so the road a truck
// is timed on is the road it is drawn on. Pure functions only: no DOM, no clock, no randomness. Everything is in plan millimetres, y pointing down.
// The map is schematic: one block per place (the yard in block 0,0, each active site in its own block), a grid of streets between the blocks.
// A street corridor is a footpath, a two-lane carriageway and a footpath; trucks keep left (Australia) and turn on rounded corners.
export const WORLD={street:12000,foot:2200,lane:2000,speed:6,minMs:15000,maxMs:45000,siteFront:2000,yardFront:4000,side:9000,siteBack:18000,yardBack:9000,minW:52000,minH:46000,turn:7000,lotRange:20,wait:14000};
export const DEFAULT_PARKING={side:'RIGHT',vehicleLength:9000,vehicleWidth:2100,clearance:500,length:10000,width:3100};
const R=Math.round,S=WORLD.street,clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const DIRS=[{x:1,y:0},{x:0,y:1},{x:-1,y:0},{x:0,y:-1}];// E S W N
const dirOf=h=>Math.abs(h.x)>=Math.abs(h.y)?(h.x>=0?0:2):(h.y>=0?1:3);
export function bbox(pts){let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;for(const p of pts??[]){if(p.x<x0)x0=p.x;if(p.y<y0)y0=p.y;if(p.x>x1)x1=p.x;if(p.y>y1)y1=p.y;}return x0===Infinity?{x0:0,y0:0,x1:20000,y1:16000}:{x0,y0,x1,y1};}
// The truck bay beside a yard, as the yard plan draws it (visual.js planFrame): 600 mm off the side, level with the top edge.
export function bayOf(yard){const p={...DEFAULT_PARKING,...(yard?.parking??{})},b=bbox(yard?.points);return {...p,px:p.side==='LEFT'?b.x0-p.width-600:b.x1+600,py:b.y0};}
export function extentOf(place){const b=bbox(place.points);if(place.kind!=='yard')return b;const bay=bayOf(place);return {x0:Math.min(b.x0,bay.px),y0:b.y0,x1:Math.max(b.x1,bay.px+bay.width),y1:Math.max(b.y1,bay.py+bay.length)};}
// Truck length bumper to bumper: deck + headboard gap + cab (visual.js truckDims).
export const truckTotal=t=>{const l=t?.length??6000;return l+120+(l>=4500?1900:1550);};
// Candidate lots around the yard, the ones that keep the map compact on a wide screen first. Lot (c,r) projects to screen x ~ c-r, y ~ c+r.
export function lotOrder(bw,bh){const pw=bw+S,ph=bh+S,out=[];for(let r=-6;r<=6;r++)for(let c=-6;c<=6;c++){if(!c&&!r)continue;const X=(c*pw-r*ph)*0.866,Y=(c*pw+r*ph)*0.55;out.push({c,r,cost:(X/1.7)**2+Y**2});}return out.sort((a,b)=>a.cost-b.cost||a.r-b.r||a.c-b.c);}
const validLot=m=>m&&Number.isInteger(m.col)&&Number.isInteger(m.row)&&Math.abs(m.col)<=WORLD.lotRange&&Math.abs(m.row)<=WORLD.lotRange;
// Block size: every place fits its block with room for the site building behind it and houses at the sides.
export function blockSize(places){let w=WORLD.minW,h=WORLD.minH;for(const p of places){const e=extentOf(p),site=p.kind!=='yard';w=Math.max(w,e.x1-e.x0+2*WORLD.side);h=Math.max(h,e.y1-e.y0+(site?WORLD.siteFront+WORLD.siteBack:WORLD.yardFront+WORLD.yardBack));}return {bw:Math.ceil(w/2000)*2000,bh:Math.ceil(h/2000)*2000};}
// The layout: yard in lot 0,0, sites where they were placed (site.map) or in the nearest free lot, in creation order. given (from the server snapshot):
// {bw,bh,lots:{id:[col,row]}} makes a browser that sees only some sites draw them exactly where everybody else does.
export function worldLayout(yard,sites,given=null){
 const list=[...(yard?[{...yard,kind:'yard'}]:[]),...(sites??[]).map(s=>({...s,kind:'site'}))];
 const size=given?.bw>0&&given?.bh>0?{bw:given.bw,bh:given.bh}:blockSize(list),{bw,bh}=size,pw=bw+S,ph=bh+S,lots=new Map(),taken=new Set(['0,0']);
 if(yard)lots.set(yard.id,{col:0,row:0,auto:false});
 const fixed=given?.lots??null;
 for(const s of list)if(s.kind==='site'){const g=fixed?.[s.id];if(g){lots.set(s.id,{col:g[0],row:g[1],auto:!!g[2]});taken.add(g[0]+','+g[1]);}}
 if(!fixed||list.some(s=>s.kind==='site'&&!lots.has(s.id))){
  for(const s of list)if(s.kind==='site'&&!lots.has(s.id)&&validLot(s.map)&&!taken.has(s.map.col+','+s.map.row)){lots.set(s.id,{col:s.map.col,row:s.map.row,auto:false});taken.add(s.map.col+','+s.map.row);}
  const order=lotOrder(bw,bh);let k=0;for(const s of list)if(s.kind==='site'&&!lots.has(s.id)){while(k<order.length&&taken.has(order[k].c+','+order[k].r))k++;const o=order[k]??{c:k+7,r:0};lots.set(s.id,{col:o.c,row:o.r,auto:true});taken.add(o.c+','+o.r);}}
 const places=list.map(src=>{const lot=lots.get(src.id),X0=lot.col*pw,Y0=lot.row*ph,e=extentOf(src),front=src.kind==='yard'?WORLD.yardFront:WORLD.siteFront;
  const ox=R(X0+(bw-(e.x1-e.x0))/2-e.x0),oy=R(Y0+bh-front-e.y1),streetY=Y0+bh+S/2;const p={id:src.id,kind:src.kind,name:src.name??'',col:lot.col,row:lot.row,auto:lot.auto,ox,oy,block:{x0:X0,y0:Y0,x1:X0+bw,y1:Y0+bh},ext:{x0:e.x0+ox,y0:e.y0+oy,x1:e.x1+ox,y1:e.y1+oy},streetY,src};
  if(src.kind==='yard'){const bay=bayOf(src);p.bay={...bay,x:bay.px+ox,y:bay.py+oy};p.attachX=R(ox+bay.px+bay.clearance+bay.vehicleWidth/2);}
  else{const gx=src.gate?src.gate.x+1000:(e.x0+e.x1)/2;p.attachX=R(clamp(ox+gx,X0+10000,X0+bw-10000));}
  return p;});
 const cols=places.map(p=>p.col),rows=places.map(p=>p.row);
 return {bw,bh,pw,ph,street:S,places,byId:new Map(places.map(p=>[p.id,p])),range:{c0:Math.min(0,...cols)-1,c1:Math.max(0,...cols)+1,r0:Math.min(0,...rows)-1,r1:Math.max(0,...rows)+1}};
}
// What the snapshot carries so every viewer draws the same lots: {bw,bh,lots:{id:[col,row,auto]}}.
export const layoutKey=l=>({bw:l.bw,bh:l.bh,lots:Object.fromEntries(l.places.map(p=>[p.id,[p.col,p.row,p.auto?1:0]]))});
export const nodeAt=(l,c,r)=>({x:c*l.pw+l.bw+S/2,y:r*l.ph+l.bh+S/2});
// Where a truck stands at a place: in the bay (yard), on the kerb lane outside the site gate (site, k-th truck further back), or waiting in the lane beside the yard.
export function bayPose(l,yardId,truck){const p=l.byId.get(yardId);if(!p?.bay)return null;const b=p.bay,tw=Math.min(b.vehicleWidth,truck?.width??2050),total=truckTotal(truck),ox=b.x+b.clearance+(b.vehicleWidth-tw)/2,oy=b.y+b.clearance+Math.max(0,(b.vehicleLength-total)/2);return {x:R(ox+tw/2),y:R(oy+total/2),hx:0,hy:1,bay:true};}
export function kerbPose(l,placeId,k=0){const p=l.byId.get(placeId);if(!p)return null;const x=p.kind==='yard'?p.attachX-WORLD.wait-k*13000:p.attachX-k*13000;return {x:R(clamp(x,p.block.x0+7000,p.block.x1-7000)),y:R(p.streetY-WORLD.lane),hx:1,hy:0,bay:false};}
// A stored route's end is where the truck is now, if it ended at this place and the map has not been rearranged since.
export function routeEnd(l,truck){const r=truck?.route,p=r&&l.byId.get(truck.at);if(!r||!p||r.to!==truck.at||!r.end||!r.lot||r.lot[0]!==p.col||r.lot[1]!==p.row||!r.grid||r.grid[0]!==l.bw||r.grid[1]!==l.bh)return null;return r.end;}
// Which spot a pose takes: the bay, or kerb slot k (13 m apart, one behind the other).
export function slotOf(l,placeId,pose){if(!pose)return null;if(pose.bay)return 'bay';for(let k=0;k<12;k++){const q=kerbPose(l,placeId,k);if(q&&q.x===pose.x&&q.y===pose.y)return 'k'+k;}return 'p'+pose.x+','+pose.y;}
// Every truck at rest at one place gets a spot, the same on the server and in every browser: a truck keeps the spot its route ended in (first come
// first kept). A truck that has never driven stands where its place in the yard's fleet puts it (fleet: every truck of that yard, in repository order):
// the first in the bay, the others one behind the other on the kerb, so a truck leaving never makes the others jump. Else the first free kerb slot.
export function restPoses(l,placeId,trucks,fleet=trucks){const p=l.byId.get(placeId),out=new Map(),used=new Set();if(!p)return out;
 for(const t of trucks){const e=routeEnd(l,{...t,at:placeId}),s=slotOf(l,placeId,e);if(e&&!used.has(s)){used.add(s);out.set(t.id,e);}}
 const home=p.kind==='yard'?fleet.filter(t=>(t.yard??placeId)===placeId).map(t=>t.id):[];
 for(const t of trucks){if(out.has(t.id))continue;const i=home.indexOf(t.id),want=i<0?null:i===0?'bay':'k'+(i-1);if(want&&!used.has(want)){used.add(want);out.set(t.id,want==='bay'?bayPose(l,placeId,t):kerbPose(l,placeId,i-1));continue;}
  if(p.kind==='yard'&&i<0&&!used.has('bay')){used.add('bay');out.set(t.id,bayPose(l,placeId,t));continue;}let k=0;while(used.has('k'+k))k++;used.add('k'+k);out.set(t.id,kerbPose(l,placeId,k));}
 return out;}
// Where a truck bound for placeId will stop: the bay if nobody holds it (a yard), else the first kerb slot not held by a truck there or on its way.
export function destSlot(l,placeId,resting,inbound,fleet=resting){const p=l.byId.get(placeId),used=new Set([...restPoses(l,placeId,resting,fleet).values()].map(q=>slotOf(l,placeId,q)));for(const t of inbound){const e=t.route?.to===placeId&&t.route.end&&t.route.lot?.[0]===p?.col&&t.route.lot?.[1]===p?.row?t.route.end:null;if(e)used.add(slotOf(l,placeId,e));}
 if(p?.kind==='yard'&&!used.has('bay'))return {bayFree:true,k:0};let k=0;while(used.has('k'+k))k++;return {bayFree:false,k};}
// Shortest drive on the street grid from a street point (heading fixed, or free when coming out of a driveway) to a street point: Dijkstra over
// (intersection, heading) with a turn penalty and no U-turns. Ties break the same way everywhere (fixed direction order, stable queue).
function gridPath(l,from,to){
 const {c0,c1,r0,r1}=l.range,key=(c,r,d)=>((c-c0)*(r1-r0+1)+(r-r0))*4+d,T=WORLD.turn,dist=new Map(),prev=new Map(),heap=[];let seq=0;
 const push=(cost,st)=>{heap.push({cost,seq:seq++,st});let i=heap.length-1;while(i>0){const j=(i-1)>>1;if(heap[j].cost<heap[i].cost||(heap[j].cost===heap[i].cost&&heap[j].seq<heap[i].seq))break;[heap[i],heap[j]]=[heap[j],heap[i]];i=j;}};
 const pop=()=>{const top=heap[0],last=heap.pop();if(heap.length){heap[0]=last;let i=0;for(;;){const a=2*i+1,b=a+1;let m=i;const less=(x,y)=>heap[x].cost<heap[y].cost||(heap[x].cost===heap[y].cost&&heap[x].seq<heap[y].seq);if(a<heap.length&&less(a,m))m=a;if(b<heap.length&&less(b,m))m=b;if(m===i)break;[heap[i],heap[m]]=[heap[m],heap[i]];i=m;}}return top;};
 const relax=(cost,st,from)=>{const k=st.goal?'goal':key(st.c,st.r,st.d);if(dist.has(k)&&dist.get(k)<=cost)return;dist.set(k,cost);prev.set(k,from);push(cost,st);};
 // from/to: {x,r,c} on the H street (to.dirs: the headings it may arrive in; a kerb is reached heading east, in the lane beside the place) of row r, between intersections (c-1,r) and (c,r); from.heads: allowed first headings (0 E / 2 W), from.turn: cost of the first turn.
 for(const d of from.heads){const c=d===0?from.c:from.c-1,n=nodeAt(l,c,from.r);relax(Math.abs(n.x-from.x)+(from.turn??0),{c,r:from.r,d},null);}
 while(heap.length){const {cost,st}=pop();if(st.goal)break;const k=key(st.c,st.r,st.d);if(dist.get(k)<cost)continue;const n=nodeAt(l,st.c,st.r);
  if(st.r===to.r){if(st.c===to.c-1&&to.dirs.includes(0))relax(cost+Math.abs(to.x-n.x)+(st.d===0?0:T),{goal:true,d:0},k);if(st.c===to.c&&to.dirs.includes(2))relax(cost+Math.abs(n.x-to.x)+(st.d===2?0:T),{goal:true,d:2},k);}
  for(let d=0;d<4;d++){if(d===(st.d+2)%4)continue;const c=st.c+DIRS[d].x,r=st.r+DIRS[d].y;if(c<c0||c>c1||r<r0||r>r1)continue;const m=nodeAt(l,c,r);relax(cost+Math.abs(m.x-n.x)+Math.abs(m.y-n.y)+(d===st.d?0:T),{c,r,d},k);}}
 if(!prev.has('goal'))return null;const nodes=[];let k=prev.get('goal');while(k!=null){const d=k%4,rest=(k-d)/4,rr=rest%(r1-r0+1),cc=(rest-rr)/(r1-r0+1);nodes.unshift({...nodeAt(l,cc+c0,rr+r0)});k=prev.get(k);}return nodes;
}
const unit=(a,b)=>{const dx=b.x-a.x,dy=b.y-a.y,n=Math.hypot(dx,dy)||1;return {x:dx/n,y:dy/n};};
// Centre line to driving line: each segment moves its own offset to the left of travel (0 on a driveway, one lane on a street), corners meet where the offset
// lines cross, then every corner is rounded (radius WORLD.turn, less where the legs are short) and sampled every 15 degrees.
function laneLine(C,offs){
 const segs=[];for(let i=0;i<C.length-1;i++){if(Math.hypot(C[i+1].x-C[i].x,C[i+1].y-C[i].y)<1)continue;const d=unit(C[i],C[i+1]),n={x:d.y,y:-d.x},o=offs[i];segs.push({d,a:{x:C[i].x+n.x*o,y:C[i].y+n.y*o},b:{x:C[i+1].x+n.x*o,y:C[i+1].y+n.y*o}});}
 const merged=[];for(const s of segs){const m=merged.at(-1);if(m&&Math.abs(m.d.x-s.d.x)<1e-9&&Math.abs(m.d.y-s.d.y)<1e-9&&Math.abs((s.a.x-m.b.x)*m.d.y-(s.a.y-m.b.y)*m.d.x)<1)m.b=s.b;else merged.push({...s});}
 const pts=[merged[0].a];for(let i=1;i<merged.length;i++){const p=merged[i-1],q=merged[i],den=p.d.x*q.d.y-p.d.y*q.d.x;if(Math.abs(den)<1e-9){pts.push(p.b);continue;}const t=((q.a.x-p.a.x)*q.d.y-(q.a.y-p.a.y)*q.d.x)/den;pts.push({x:p.a.x+p.d.x*t,y:p.a.y+p.d.y*t});}
 pts.push(merged.at(-1).b);return fillet(pts);
}
function fillet(pts){if(pts.length<3)return pts;const out=[pts[0]];for(let i=1;i<pts.length-1;i++){const A=out.at(-1),K=pts[i],B=pts[i+1],d1=unit(A,K),d2=unit(K,B),cos=clamp(d1.x*d2.x+d1.y*d2.y,-1,1),th=Math.acos(cos);if(th<1e-3){out.push(K);continue;}
  const tn=Math.tan(th/2),la=Math.hypot(K.x-A.x,K.y-A.y),lb=Math.hypot(B.x-K.x,B.y-K.y),r=Math.min(WORLD.turn,0.48*Math.min(la,lb)/tn),t=r*tn,T1={x:K.x-d1.x*t,y:K.y-d1.y*t},T2={x:K.x+d2.x*t,y:K.y+d2.y*t};
  let m={x:d2.x-d1.x*cos,y:d2.y-d1.y*cos};const ml=Math.hypot(m.x,m.y)||1;m={x:m.x/ml,y:m.y/ml};const c={x:T1.x+m.x*r,y:T1.y+m.y*r};let a1=Math.atan2(T1.y-c.y,T1.x-c.x),a2=Math.atan2(T2.y-c.y,T2.x-c.x),da=a2-a1;while(da>Math.PI)da-=2*Math.PI;while(da<-Math.PI)da+=2*Math.PI;
  const n=Math.max(2,Math.ceil(Math.abs(da)/(Math.PI/12)));for(let k=0;k<=n;k++){const a=a1+da*k/n;out.push({x:c.x+Math.cos(a)*r,y:c.y+Math.sin(a)*r});}}
 out.push(pts.at(-1));return out;}
const streetPoint=(l,pose)=>{const r=Math.round((pose.y-(l.bh+S/2))/l.ph);return {x:pose.x,r,c:Math.floor((pose.x-(l.bw+S/2))/l.pw)+1,y:r*l.ph+l.bh+S/2};};
// The drive from where the truck stands at `fromId` (opts.start, else its rest spot there) to `toId`: into the bay (a yard, opts.bayFree not false) or kerb slot opts.k.
// Returns {points:[[x,y]...], rev (index from which it reverses, into the yard bay), length, end pose, lot and grid (to tell a stale end later)} or null.
export function worldRoute(l,truck,fromId,toId,opts={}){
 const from=l.byId.get(fromId),to=l.byId.get(toId);if(!from||!to||fromId===toId)return null;
 const start=opts.start??restPoses(l,fromId,[{...truck,at:fromId}],opts.fleet??[truck]).get(truck.id);if(!start)return null;
 const C=[],offs=[],lane=WORLD.lane;let src;
 if(start.bay){const a={x:from.attachX,y:from.streetY};C.push({x:start.x,y:start.y},a);offs.push(0);src={x:a.x,r:from.row,c:from.col,heads:[0,2],turn:WORLD.turn};}
 else{const s=streetPoint(l,start);C.push({x:s.x,y:s.y});src={x:s.x,r:s.r,c:s.c,heads:[dirOf({x:start.hx,y:start.hy})===2?2:0]};}
 const toBay=to.kind==='yard'&&opts.bayFree!==false,kerb=toBay?null:kerbPose(l,to.id,opts.k??0),dest={x:toBay?to.attachX:kerb.x,r:to.row,c:Math.floor(((toBay?to.attachX:kerb.x)-(l.bw+S/2))/l.pw)+1,dirs:toBay?[0,2]:[0]};
 const nodes=gridPath(l,src,dest);if(!nodes)return null;for(const n of nodes){C.push(n);offs.push(lane);}
 const last=C.at(-1),dx=Math.sign(dest.x-last.x)||1;C.push({x:dest.x,y:to.streetY});offs.push(lane);
 let rev=null,end;
 if(toBay){const RV=9000;C.push({x:dest.x+dx*RV,y:to.streetY});offs.push(lane);}
 let pts=laneLine(C,offs);
 if(toBay){const bay=bayPose(l,to.id,truck),Q=pts.at(-1),Rr=6000,yl=Q.y,s=dx;rev=pts.length-1;const c={x:dest.x+s*Rr,y:yl-Rr};pts.push({x:dest.x+s*Rr,y:yl});for(let k=1;k<=6;k++){const a=Math.PI/2*k/6;pts.push({x:c.x-s*Math.sin(a)*Rr,y:c.y+Math.cos(a)*Rr});}pts.push({x:bay.x,y:bay.y});end=bay;}
 else{const Q=pts.at(-1),P=pts.at(-2)??Q,h=unit(P,Q);end={x:R(Q.x),y:R(Q.y),hx:Math.round(h.x),hy:Math.round(h.y),bay:false};}
 const out=[];for(const p of pts){const q=[R(p.x),R(p.y)],m=out.at(-1);if(!m||m[0]!==q[0]||m[1]!==q[1])out.push(q);else if(rev!=null&&out.length<=rev)rev--;}
 let length=0;for(let i=1;i<out.length;i++)length+=Math.hypot(out[i][0]-out[i-1][0],out[i][1]-out[i-1][1]);
 return {from:fromId,to:toId,points:out,rev,length:R(length),end,lot:[to.col,to.row],grid:[l.bw,l.bh]};
}
export const tripMs=length=>clamp(R(length/WORLD.speed),WORLD.minMs,WORLD.maxMs);
// Along a route: the pose at distance s (mm from the start), heading from the segment it is on; reversing (from index rev) faces back.
export function routeGeom(route){const P=route.points,cum=[0];for(let i=1;i<P.length;i++)cum.push(cum[i-1]+Math.hypot(P[i][0]-P[i-1][0],P[i][1]-P[i-1][1]));return {P,cum,L:cum.at(-1)||0,sRev:route.rev!=null?cum[route.rev]??null:null};}
export function poseAt(g,s){const {P,cum,L}=g;if(P.length<2)return {x:P[0]?.[0]??0,y:P[0]?.[1]??0,hx:1,hy:0};s=clamp(s,0,L);let i=1;while(i<P.length-1&&cum[i]<s)i++;const a=P[i-1],b=P[i],len=cum[i]-cum[i-1]||1,u=clamp((s-cum[i-1])/len,0,1),h=unit({x:a[0],y:a[1]},{x:b[0],y:b[1]}),back=g.sRev!=null&&s>=g.sRev-1e-6&&i-1>=0&&cum[i-1]>=g.sRev-1e-6;return {x:a[0]+(b[0]-a[0])*u,y:a[1]+(b[1]-a[1])*u,hx:back?-h.x:h.x,hy:back?-h.y:h.y,rev:back};}
// Speed profile: a trip (and its reversing part) starts and ends at rest; u in 0..1 of the trip time -> distance along the route.
const ease=(u,a)=>{if(u<=0)return 0;if(u>=1)return 1;const v=1/(1-a);return u<a?v*u*u/(2*a):u>1-a?1-v*(1-u)*(1-u)/(2*a):v*(a/2+(u-a));};
export function distanceAt(g,u,durationMs){const L=g.L;if(!(L>0))return 0;const acc=d=>clamp(2500/Math.max(1,d),0.05,0.3);if(g.sRev==null||g.sRev<=0||g.sRev>=L)return L*ease(u,acc(durationMs));const f=g.sRev/L,df=durationMs*f;if(u<f)return g.sRev*ease(u/f,acc(df));return g.sRev+(L-g.sRev)*ease((u-f)/(1-f),acc(durationMs-df));}
