import { AppError } from '../service.js';
import { cross,on,intersects,inside,overlap,contains,fitsPolygon,ringArea,ringProblems,cleanCorners,footprint,TURN_ANCHORS,turnSpot,turnSweep,circleBox,circleHits,pileTurn,sweepOf,sameRing,sameGround,simplifyRing,freeZone,bbox,ringInside } from '../../public/shape.js';
export { cross,on,intersects,inside,overlap,contains,fitsPolygon,ringArea,ringProblems,cleanCorners,footprint,TURN_ANCHORS,turnSpot,turnSweep,circleBox,circleHits,pileTurn,sweepOf,sameRing,sameGround,simplifyRing,freeZone,bbox,ringInside };
export const requireRule=(ok,message)=>{if(!ok)throw new AppError(409,message);};
export function integer(value,label,min=0,max=1000000000){if(!Number.isSafeInteger(value)||value<min||value>max)throw new AppError(400,`${label} must be a whole number between ${min} and ${max}.`);return value;}
const directions={RIGHT:[1,0],LEFT:[-1,0],UP:[0,-1],DOWN:[0,1],NE:[1,-1],SE:[1,1],SW:[-1,1],NW:[-1,-1]};
export function vertices(segments){requireRule(Array.isArray(segments)&&segments.length<=100,'Use at most 100 boundary segments.');const points=[{x:0,y:0}];for(const s of segments){const d=directions[s.direction];requireRule(d,'Choose a direction.');integer(s.length,'Segment length',1,1000000);const scale=Math.hypot(...d),p=points.at(-1);points.push({x:p.x+d[0]*s.length/scale,y:p.y+d[1]*s.length/scale});}return points;}
function ring(pts){const problem=ringProblems(pts)[0];requireRule(!problem,problem?.message);return {points:pts,area:ringArea(pts)};}
// Legacy line-by-line boundary (scripts, tests, old clients).
export function polygon(segments,close){const pts=vertices(segments);requireRule(close===true,'Preview and explicitly close the perimeter.');if(Math.hypot(pts.at(-1).x,pts.at(-1).y)<=1)pts.pop();return ring(pts);}
// Boundary sent as absolute corners (the shape editor). Untouched stored corners (keep) may be sent back exactly, even when fractional.
export function polygonFromPoints(input,keep=[]){const r=cleanCorners(input,keep);if(r.problem)throw new AppError(r.problem.status,r.problem.message);return ring(r.points);}
export function rect(container,position=container){const rotation=position.rotation??0;requireRule(rotation===0||rotation===90,'Rotation must be 0 or 90 degrees.');const length=container.envelopeLength??container.length,width=container.envelopeWidth??container.width;integer(length,'Loaded length',1);integer(width,'Loaded width',1);return {x:position.x,y:position.y,w:rotation===90?width:length,h:rotation===90?length:width};}

// Obstacle rectangles bucketed on a 2 m grid: hits(r) answers exactly obstacles.some(o=>overlap(r,o)) but only tests nearby ones.
// Build one per obstacle list and pass it to route()/carryRoute()/anyOverlap() in place of the array; it is read-only.
const CELL=2000,SPAN=4096;
export class ObstacleIndex{
  // Anything not finite or very large is kept in `loose` and always tested, so the answer never depends on the buckets being complete.
  constructor(list){this.list=list;this.cells=new Map();this.loose=[];for(const o of list){const c=cellsOf(o);if(!c){this.loose.push(o);continue;}for(let gx=c[0];gx<=c[1];gx++)for(let gy=c[2];gy<=c[3];gy++){const k=gx+':'+gy;let b=this.cells.get(k);if(!b)this.cells.set(k,b=[]);b.push(o);}}}
  hits(r){const c=cellsOf(r);if(!c)return this.list.some(o=>overlap(r,o));for(const o of this.loose)if(overlap(r,o))return true;for(let gx=c[0];gx<=c[1];gx++)for(let gy=c[2];gy<=c[3];gy++){const b=this.cells.get(gx+':'+gy);if(b)for(const o of b)if(overlap(r,o))return true;}return false;}
}
// overlap(a,b) implies the closed x and y extents of a and b intersect, so they share at least one cell.
function cellsOf(o){const x0=Math.min(o.x,o.x+o.w),x1=Math.max(o.x,o.x+o.w),y0=Math.min(o.y,o.y+o.h),y1=Math.max(o.y,o.y+o.h);if(!Number.isFinite(x0)||!Number.isFinite(x1)||!Number.isFinite(y0)||!Number.isFinite(y1))return null;const c=[Math.floor(x0/CELL),Math.floor(x1/CELL),Math.floor(y0/CELL),Math.floor(y1/CELL)];return (c[1]-c[0]+1)*(c[3]-c[2]+1)>SPAN?null:c;}
export const obstacleIndex=obstacles=>obstacles instanceof ObstacleIndex?obstacles:new ObstacleIndex(obstacles);
export const obstacleList=obstacles=>obstacles instanceof ObstacleIndex?obstacles.list:obstacles;
// obstacles.some(o=>overlap(r,o)) for either an array or an ObstacleIndex.
export const anyOverlap=(r,obstacles)=>obstacles instanceof ObstacleIndex?obstacles.hits(r):obstacles.some(o=>overlap(r,o));
// Conservative grid routing: each node and swept edge fits the full load envelope. A* on the 4-connected grid (Manhattan heuristic less the
// goal radius, so it never overestimates; binary heap; ties by lower heuristic, then first pushed) with the same 20000-node budget and goal
// test as the old breadth-first search: the fewest grid steps, then the shortest last leg to the end among those. obstacles: array or ObstacleIndex.
export function route(start,end,shape,poly,obstacles,step=500){
  const index=obstacleIndex(obstacles),memo=new Map();
  const valid=(x,y)=>{const k=x+','+y;let v=memo.get(k);if(v===undefined){const r={x,y,w:shape.w,h:shape.h};v=fitsPolygon(r,poly)&&!index.hits(r);memo.set(k,v);}return v;};
  const edge=(a,b)=>{const n=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)/100));for(let i=0;i<=n;i++)if(!valid(a.x+(b.x-a.x)*i/n,a.y+(b.y-a.y)*i/n))return false;return true;};
  if(!valid(start.x,start.y)||!valid(end.x,end.y))return null;
  if(edge(start,end))return [start,end];
  const reach=step*1.5,slack=reach*Math.SQRT2,h=p=>Math.max(0,Math.abs(p.x-end.x)+Math.abs(p.y-end.y)-slack);
  // heap entries [f,h,seq,node,g]
  const heap=[];let seq=0;const less=(a,b)=>a[0]<b[0]||a[0]===b[0]&&(a[1]<b[1]||a[1]===b[1]&&a[2]<b[2]);
  const push=e=>{heap.push(e);let i=heap.length-1;while(i>0){const j=(i-1)>>1;if(!less(heap[i],heap[j]))break;[heap[i],heap[j]]=[heap[j],heap[i]];i=j;}};
  const pop=()=>{const top=heap[0],last=heap.pop();if(heap.length){heap[0]=last;let i=0;for(;;){const l=2*i+1,r=l+1;let m=i;if(l<heap.length&&less(heap[l],heap[m]))m=l;if(r<heap.length&&less(heap[r],heap[m]))m=r;if(m===i)break;[heap[i],heap[m]]=[heap[m],heap[i]];i=m;}}return top;};
  const key=p=>`${p.x},${p.y}`,parent=new Map([[key(start),null]]),best=new Map([[key(start),0]]),closed=new Set();
  const hs=h(start);push([hs,hs,seq++,start,0]);let goal=null,goalG=Infinity,goalLeg=Infinity,expanded=0;
  while(heap.length&&expanded<20000){const e=pop(),p=e[3],g=e[4],k=key(p);if(closed.has(k)||g>best.get(k))continue;
    if(goal&&e[0]>goalG)break;closed.add(k);expanded++;
    if(g<=goalG){const leg=Math.hypot(p.x-end.x,p.y-end.y);if(leg<=reach&&leg<goalLeg&&edge(p,end)){goal=p;goalG=g;goalLeg=leg;}}
    if(goal)continue;
    for(const [dx,dy] of [[step,0],[-step,0],[0,step],[0,-step]]){const next={x:p.x+dx,y:p.y+dy},nk=key(next),ng=g+step;if(closed.has(nk)||(best.has(nk)&&best.get(nk)<=ng)||!edge(p,next))continue;best.set(nk,ng);parent.set(nk,p);const hn=h(next);push([ng+hn,hn,seq++,next,ng]);}}
  if(!goal)return null;const points=[end];for(let p=goal;p;p=parent.get(key(p)))points.push(p);return points.reverse();
}
// Route a carried load (top-left corners start/end, real footprint load {w,h}). The machine needs at least 1.5 m × 1.0 m of room; that padding
// goes to the right/below the load when it fits there at both ends, otherwise to the left/above, otherwise centred, so a load flush against the
// right or bottom fence can be carried as well as one against the left or top. The returned points are the load's own top-left corners.
export function carryRoute(start,end,load,poly,obstacles,step=500){
  const W=Math.max(1500,load.w),H=Math.max(1000,load.h),xs=[...new Set([0,W-load.w,Math.round((W-load.w)/2)])],ys=[...new Set([0,H-load.h,Math.round((H-load.h)/2)])];
  const index=obstacleIndex(obstacles),valid=(p,ox,oy)=>{const r={x:p.x-ox,y:p.y-oy,w:W,h:H};return fitsPolygon(r,poly)&&!index.hits(r);};
  for(const oy of ys)for(const ox of xs){if(!valid(start,ox,oy)||!valid(end,ox,oy))continue;const path=route({x:start.x-ox,y:start.y-oy},{x:end.x-ox,y:end.y-oy},{w:W,h:H},poly,index,step);return path?path.map(p=>({x:p.x+ox,y:p.y+oy})):null;}
  return null;
}
// A move that changes a stillage's rotation within one location. Where it stands when the swept circle is clear; otherwise the forklift
// carries it (old orientation) to the nearest clear circle within 6 m, turns it there and carries it (new orientation) to its spot.
// Returns {path, turnAt:{x,y,r}, inPlace} or null. obstacles: rectangles (other stock, solid fixtures).
export function turnPath(points,c,from,to,obstacles){
  const a=rect(c,from),b=rect(c,to),half=Math.hypot(a.w,a.h)/2,index=obstacleIndex(obstacles);obstacles=obstacleList(obstacles);
  const clear=d=>fitsPolygon(circleBox(d),points)&&!obstacles.some(o=>circleHits(d,o));
  if(overlap(a,b)){const d=turnSweep(c,from,to);if(clear(d))return {path:[{x:from.x,y:from.y},{x:to.x,y:to.y}],turnAt:d,inPlace:true};}
  const c0={x:a.x+a.w/2,y:a.y+a.h/2},c1={x:b.x+b.w/2,y:b.y+b.h/2},mid={x:(c0.x+c1.x)/2,y:(c0.y+c1.y)/2};
  const lattice=[];for(let dy=-6000;dy<=6000;dy+=500)for(let dx=-6000;dx<=6000;dx+=500)lattice.push({x:Math.round(mid.x/500)*500+dx,y:Math.round(mid.y/500)*500+dy});
  lattice.sort((p,q)=>Math.hypot(p.x-mid.x,p.y-mid.y)-Math.hypot(q.x-mid.x,q.y-mid.y));
  let tried=0;
  for(const p of [c0,c1,...lattice]){const d={x:p.x,y:p.y,r:half};if(!clear(d))continue;if(++tried>6)break;
    const leg1=carryRoute({x:from.x,y:from.y},{x:p.x-a.w/2,y:p.y-a.h/2},a,points,index);if(!leg1)continue;
    const leg2=carryRoute({x:p.x-b.w/2,y:p.y-b.h/2},{x:to.x,y:to.y},b,points,index);if(!leg2)continue;
    return {path:[...leg1,...leg2],turnAt:d,inPlace:false};}
  return null;
}
