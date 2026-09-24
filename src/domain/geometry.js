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

// Conservative grid routing: each node and swept edge fits the full load envelope.
export function route(start,end,shape,poly,obstacles,step=500){
  const valid=(x,y)=>{const r={x,y,w:shape.w,h:shape.h};return fitsPolygon(r,poly)&&!obstacles.some(o=>overlap(r,o));};
  const edge=(a,b)=>{const n=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)/100));for(let i=0;i<=n;i++)if(!valid(a.x+(b.x-a.x)*i/n,a.y+(b.y-a.y)*i/n))return false;return true;};
  if(!valid(start.x,start.y)||!valid(end.x,end.y))return null;
  if(edge(start,end))return [start,end];
  const queue=[start],seen=new Map([[`${start.x},${start.y}`,null]]);let goal=null;
  for(let head=0;head<queue.length&&head<20000;head++){const p=queue[head];if(Math.hypot(p.x-end.x,p.y-end.y)<=step*1.5&&edge(p,end)){goal=p;break;}for(const [dx,dy] of [[step,0],[-step,0],[0,step],[0,-step]]){const next={x:p.x+dx,y:p.y+dy},key=`${next.x},${next.y}`;if(!seen.has(key)&&edge(p,next)){seen.set(key,p);queue.push(next);}}}
  if(!goal)return null;const points=[end];for(let p=goal;p;p=seen.get(`${p.x},${p.y}`))points.push(p);return points.reverse();
}
// Route a carried load (top-left corners start/end, real footprint load {w,h}). The machine needs at least 1.5 m × 1.0 m of room; that padding
// goes to the right/below the load when it fits there at both ends, otherwise to the left/above, otherwise centred, so a load flush against the
// right or bottom fence can be carried as well as one against the left or top. The returned points are the load's own top-left corners.
export function carryRoute(start,end,load,poly,obstacles,step=500){
  const W=Math.max(1500,load.w),H=Math.max(1000,load.h),xs=[...new Set([0,W-load.w,Math.round((W-load.w)/2)])],ys=[...new Set([0,H-load.h,Math.round((H-load.h)/2)])];
  const valid=(p,ox,oy)=>{const r={x:p.x-ox,y:p.y-oy,w:W,h:H};return fitsPolygon(r,poly)&&!obstacles.some(o=>overlap(r,o));};
  for(const oy of ys)for(const ox of xs){if(!valid(start,ox,oy)||!valid(end,ox,oy))continue;const path=route({x:start.x-ox,y:start.y-oy},{x:end.x-ox,y:end.y-oy},{w:W,h:H},poly,obstacles,step);return path?path.map(p=>({x:p.x+ox,y:p.y+oy})):null;}
  return null;
}
// A move that changes a stillage's rotation within one location. Where it stands when the swept circle is clear; otherwise the forklift
// carries it (old orientation) to the nearest clear circle within 6 m, turns it there and carries it (new orientation) to its spot.
// Returns {path, turnAt:{x,y,r}, inPlace} or null. obstacles: rectangles (other stock, solid fixtures).
export function turnPath(points,c,from,to,obstacles){
  const a=rect(c,from),b=rect(c,to),half=Math.hypot(a.w,a.h)/2;
  const clear=d=>fitsPolygon(circleBox(d),points)&&!obstacles.some(o=>circleHits(d,o));
  if(overlap(a,b)){const d=turnSweep(c,from,to);if(clear(d))return {path:[{x:from.x,y:from.y},{x:to.x,y:to.y}],turnAt:d,inPlace:true};}
  const c0={x:a.x+a.w/2,y:a.y+a.h/2},c1={x:b.x+b.w/2,y:b.y+b.h/2},mid={x:(c0.x+c1.x)/2,y:(c0.y+c1.y)/2};
  const lattice=[];for(let dy=-6000;dy<=6000;dy+=500)for(let dx=-6000;dx<=6000;dx+=500)lattice.push({x:Math.round(mid.x/500)*500+dx,y:Math.round(mid.y/500)*500+dy});
  lattice.sort((p,q)=>Math.hypot(p.x-mid.x,p.y-mid.y)-Math.hypot(q.x-mid.x,q.y-mid.y));
  let tried=0;
  for(const p of [c0,c1,...lattice]){const d={x:p.x,y:p.y,r:half};if(!clear(d))continue;if(++tried>6)break;
    const leg1=carryRoute({x:from.x,y:from.y},{x:p.x-a.w/2,y:p.y-a.h/2},a,points,obstacles);if(!leg1)continue;
    const leg2=carryRoute({x:p.x-b.w/2,y:p.y-b.h/2},{x:to.x,y:to.y},b,points,obstacles);if(!leg2)continue;
    return {path:[...leg1,...leg2],turnAt:d,inPlace:false};}
  return null;
}
